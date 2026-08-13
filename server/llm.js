'use strict';

/**
 * The "ask a language model" lifeline.
 *
 * Talks to a locally-run model - by default qwen3:8b served by Ollama. The
 * lifeline started out on qwen2.5:0.5b on the theory that a confidently wrong
 * friend is funnier than a right one, but half a billion parameters turned out
 * to be funny exactly once: over hours of play it got two questions right, so
 * nobody ever spent the lifeline. A friend worth phoning is the better game.
 *
 * Qwen3 is a hybrid reasoning model and will happily spend its whole token
 * budget on a <think> block before it says a letter. Thinking is therefore
 * turned off by default - see THINK below - which keeps an answer at a second
 * or two rather than half a minute of dead air on screen.
 *
 * No dependencies. Node 18's global fetch does the work, and two API shapes are
 * supported so llama.cpp's server or LM Studio work just as well as Ollama:
 *
 *   LLM_URL=http://127.0.0.1:11434        -> Ollama's native /api/generate
 *   LLM_URL=http://127.0.0.1:8080/v1      -> OpenAI-compatible /chat/completions
 *
 * If nothing is listening the lifeline reports itself as unavailable and the
 * game carries on - the button greys out rather than the turn hanging.
 *
 * The weights are preloaded at boot and kept resident. This is not an
 * optimisation, it is the difference between working and not: a cold
 * llama-server spends ten to fifteen seconds on CUDA init and a warmup pass
 * before it looks at the prompt, and a request that arrives during that window
 * spends its entire timeout budget waiting to be started. Reachable and loaded
 * are separate questions, and only the second one is fast.
 */

const URL_BASE = (process.env.LLM_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || 'qwen3:8b';
const API = (process.env.LLM_API || (/\/v1$/.test(URL_BASE) ? 'openai' : 'ollama')).toLowerCase();

// Let the model reason out loud before answering. Off by default: it buys a few
// points of accuracy for ten to thirty seconds of silence, and the answer clock
// is paused throughout, so the table just sits there watching a spinner.
// LLM_THINK=1 turns it back on for anyone who would rather have the points.
const THINK = /^(1|true|yes|on)$/i.test(String(process.env.LLM_THINK || ''));

// Generous, because the answer clock is paused while we wait. The old 20s was
// not enough: a cold llama-server spends ten-plus seconds on CUDA init before
// it reads the first token, which left the actual generation racing a deadline
// it had already mostly spent. Preloading below means we should never be cold,
// but if we are, a slow answer beats a dead one.
const TIMEOUT_MS = Math.max(2000, Number(process.env.LLM_TIMEOUT_MS) || 45000);
const LOAD_TIMEOUT_MS = Math.max(TIMEOUT_MS, Number(process.env.LLM_LOAD_TIMEOUT_MS) || 120000);

// How long a probe result is trusted before we look again. Short enough that
// starting Ollama mid-game makes the button light up without a restart.
const PROBE_TTL_MS = 30000;

// Told to Ollama on every call, so each use pushes the eviction deadline out.
// The default is five minutes, which is shorter than a game: without this the
// model quietly unloads between questions and the next player pays cold start.
const KEEP_ALIVE = process.env.LLM_KEEP_ALIVE || '30m';

// Belt and braces for the gap KEEP_ALIVE cannot cover: a lobby sitting idle
// broadcasts no state, so nothing calls ready() and nothing refreshes the
// deadline. Re-poking the model well inside KEEP_ALIVE keeps it resident.
const KEEP_WARM_MS = Math.max(60000, Number(process.env.LLM_KEEP_WARM_MS) || 600000);

// The trailing /no_think is Qwen3's own soft switch. Ollama has a proper `think`
// field and we send that too, but the token works everywhere - llama.cpp and LM
// Studio have no such field - and costs nothing on models that ignore it.
const SYSTEM = 'You are a contestant\'s phone-a-friend on a television quiz show. '
  + 'You are enthusiastic and you always commit to one answer, even when you are unsure. '
  + 'Never say you cannot answer. '
  // Reasoning first, letter last. Demanding the letter up front sounds tidier
  // and parses beautifully, but it makes the model commit before it has
  // thought, and on a question it finds hard it then spends the rest of the
  // reply arguing with itself - which is both a mess on the card and a pick
  // that no longer matches the words underneath it.
  + 'Give one short sentence of reasoning, then your choice on the end as "Answer: X".'
  + (THINK ? '' : ' /no_think');

// 0.8 was set when the lifeline ran on a 0.5b and the flailing was the joke.
// A model that knows the answer only needs enough slack to sound human, and a
// hot one talks itself out of correct answers mid-sentence - which also breaks
// parsePick, since the letter it opens with is no longer the one it ends on.
const TEMPERATURE = Number.isFinite(Number(process.env.LLM_TEMPERATURE))
  && process.env.LLM_TEMPERATURE !== undefined && process.env.LLM_TEMPERATURE !== ''
  ? Number(process.env.LLM_TEMPERATURE)
  : 0.4;

// Enough for a letter and a sentence. Thinking needs far more headroom: the
// budget covers the reasoning as well, and a reply cut off mid-thought reaches
// parsePick with no letter in it at all.
const MAX_TOKENS = THINK ? 800 : 160;

// Trimmed hard: the card has room for a sentence or two, and a model left to run
// will happily restate the whole question back at you.
const MAX_REPLY_CHARS = 400;

const state = {
  /** @type {boolean|null} null = not probed yet */
  up: null,
  checkedAt: 0,
  inflight: null,
  /** True once the weights are resident, so the next ask answers immediately. */
  loaded: false,
  /** @type {Promise|null} de-dupes concurrent preloads. */
  loading: null,
};

function displayModel() {
  return MODEL;
}

/** Fetch with a hard timeout - a stalled socket must not strand a turn. */
async function post(path, body, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(URL_BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is the server up, and are the weights resident?
 *
 * Ollama's /api/ps answers both at once, which matters: a reachable daemon and
 * a loaded model are different things, and only the second one is fast. The
 * OpenAI shape has no equivalent, so there we can only ask about reachability
 * and trust our own record of having loaded it.
 */
async function probeOnce() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const path = API === 'openai' ? '/models' : '/api/ps';
    const res = await fetch(URL_BASE + path, { signal: controller.signal });
    if (!res.ok) return { up: false, loaded: false };
    if (API === 'openai') return { up: true, loaded: state.loaded };

    const data = await res.json().catch(() => null);
    const running = (data && data.models) || [];
    const loaded = running.some((m) => m && (m.name === MODEL || m.model === MODEL));
    return { up: true, loaded };
  } catch {
    return { up: false, loaded: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the weights into memory and run one token through them.
 *
 * Ollama loads on an empty prompt, but loaded is not the same as warm: the
 * first prompt to actually reach the model still waits on graph and cache
 * setup, which measured ten seconds on an 8b even with the weights already
 * resident. Spending one token here moves that cost to boot, where nobody is
 * sitting and watching.
 */
async function loadModel() {
  if (API === 'openai') {
    await post('/chat/completions', {
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    }, LOAD_TIMEOUT_MS);
  } else {
    await post('/api/generate', {
      model: MODEL,
      prompt: 'hi',
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: { num_predict: 1 },
    }, LOAD_TIMEOUT_MS);
  }
}

/**
 * Preload, de-duped. Safe to call as often as you like - once the model is
 * resident this is a no-op round trip that also resets the eviction clock.
 */
function preload() {
  if (state.loading) return state.loading;
  const startedAt = Date.now();
  const wasLoaded = state.loaded;

  state.loading = loadModel().then(
    () => {
      state.loaded = true;
      state.up = true;
      state.checkedAt = Date.now();
      if (!wasLoaded) {
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[llm] ${displayModel()} loaded and warm (${secs}s) - the lifeline will answer instantly`);
      }
    },
    (err) => {
      state.loaded = false;
      console.log(`[llm] could not preload ${displayModel()}: ${err && err.message ? err.message : err}`);
      // A slow load is not a dead daemon. Ask before condemning it, so the
      // button only greys out when the server really is gone.
      return probeOnce().then(({ up }) => {
        state.up = up;
        state.checkedAt = Date.now();
      });
    }
  );

  state.loading = state.loading.then(() => {
    state.loading = null;
  });
  return state.loading;
}

/**
 * Availability, refreshed lazily in the background. Callers get the cached
 * answer immediately - this is read on every state broadcast, so it must not
 * await anything.
 */
function ready() {
  const age = Date.now() - state.checkedAt;
  if (age > PROBE_TTL_MS && !state.inflight) {
    state.inflight = probeOnce().then(({ up, loaded }) => {
      if (state.up !== up) {
        console.log(`[llm] ${displayModel()} at ${URL_BASE} is ${up ? 'reachable' : 'not reachable'}`);
      }
      state.up = up;
      state.loaded = loaded;
      state.checkedAt = Date.now();
      state.inflight = null;
      // Evicted while we were not looking - pull it back in before a player
      // finds out the hard way.
      if (up && !loaded) preload();
    });
  }
  // Unknown counts as available: better to let someone try and get an apology
  // than to grey the button out before we have ever looked.
  return state.up !== false;
}

/** True when the next ask will be answered from memory rather than from disk. */
function isWarm() {
  return state.loaded === true;
}

/**
 * Preload now and keep it that way. Called once at boot; the interval is
 * unref'd so it never holds the process open.
 */
function start() {
  const timer = setInterval(() => preload(), KEEP_WARM_MS);
  if (timer.unref) timer.unref();
  return preload();
}

function buildPrompt(question, choices) {
  const lettered = choices.map((c, i) => `${'ABCD'[i]}) ${c}`).join('\n');
  return `Quiz question:\n${question}\n\n${lettered}\n\n`
    + 'Which letter is correct? Reply in the form "Short reason. Answer: B".';
}

/**
 * Pull a choice index out of whatever the model said.
 *
 * Order matters. An explicit "the answer is C" beats a leading letter, which in
 * turn beats matching the answer text, because a reply that opens with "A "
 * is as likely to be the article as the option.
 *
 * The last such label wins rather than the first: the model is asked to reason
 * and then commit, so anything earlier is working out loud, and a reply that
 * doubles back has its real answer at the end.
 */
function parsePick(reply, choices) {
  const text = String(reply || '');

  const labels = [...text.matchAll(/\b(?:answer|option|choice|pick|say|go with)\b[^A-Za-z0-9]{0,12}\(?([A-D])\)?(?![A-Za-z])/gi)];
  const labelled = labels.length ? labels[labels.length - 1] : null;
  if (labelled) {
    const i = labelled[1].toUpperCase().charCodeAt(0) - 65;
    if (i < choices.length) return i;
  }

  const leading = text.match(/^\s*\(?([A-D])\)?\s*(?:[-–—:.,)]|$)/i);
  if (leading) {
    const i = leading[1].toUpperCase().charCodeAt(0) - 65;
    if (i < choices.length) return i;
  }

  // Last resort: whichever option it quoted first.
  const lower = text.toLowerCase();
  let best = -1;
  let bestAt = Infinity;
  choices.forEach((choice, i) => {
    const at = lower.indexOf(String(choice).toLowerCase());
    if (at >= 0 && at < bestAt) {
      bestAt = at;
      best = i;
    }
  });
  return best >= 0 ? best : null;
}

/**
 * Drop the reasoning block a hybrid model may put in front of its answer.
 *
 * Ollama hands thinking back in its own field, so this is mostly for the
 * OpenAI-compatible servers, which inline it. An unterminated block means the
 * reply was cut off mid-thought - there is no answer behind it, and returning
 * empty is honest where returning the musings would be nonsense on the card.
 */
function stripThinking(reply) {
  const text = String(reply || '');
  if (!/<(?:think|thinking)>/i.test(text)) return text;
  return text
    .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, ' ')
    .replace(/<(?:think|thinking)>[\s\S]*$/i, ' ');
}

function tidy(reply) {
  const text = stripThinking(reply).replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_REPLY_CHARS) return text;
  return text.slice(0, MAX_REPLY_CHARS).replace(/\s+\S*$/, '') + '…';
}

/**
 * Ask the model. Resolves to { model, text, pick } where pick is the choice
 * index it seems to have gone for, or null if it never committed to one.
 * Rejects only when the model could not be reached at all - the caller uses
 * that to hand the lifeline back.
 */
async function ask(question, choices) {
  const prompt = buildPrompt(question, choices);
  let raw;

  if (API === 'openai') {
    const data = await post('/chat/completions', {
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
    });
    raw = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
  } else {
    const body = {
      model: MODEL,
      system: SYSTEM,
      prompt,
      stream: false,
      think: THINK,
      keep_alive: KEEP_ALIVE,
      options: { temperature: TEMPERATURE, num_predict: MAX_TOKENS },
    };
    // `think` is only understood by newer Ollama, and only for models that can
    // reason. Rather than gate on a version and a model list, ask once and drop
    // the field if we are told off for it - the /no_think in SYSTEM still does
    // the job on the retry.
    let data;
    try {
      data = await post('/api/generate', body);
    } catch (err) {
      if (!/\b400\b/.test(String(err && err.message))) throw err;
      delete body.think;
      data = await post('/api/generate', body);
    }
    raw = data ? data.response : '';
  }

  state.up = true;
  state.loaded = true;
  state.checkedAt = Date.now();

  const text = tidy(raw);
  return {
    model: displayModel(),
    text: text || '(silence)',
    pick: text ? parsePick(text, choices) : null,
  };
}

/** Called when a request fails, so the button greys out promptly. */
function markDown() {
  state.up = false;
  state.loaded = false;
  state.checkedAt = Date.now();
}

module.exports = {
  ask, ready, isWarm, preload, start, markDown, displayModel, MODEL, URL_BASE, API,
};
