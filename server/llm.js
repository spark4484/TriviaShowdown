'use strict';

/**
 * The "ask a small language model" lifeline.
 *
 * Talks to a locally-run model - by default qwen2.5:0.5b served by Ollama. Half
 * a billion parameters is not very many, and that is the entire point: the
 * lifeline is a gamble, not an oracle. A confidently wrong answer is a feature.
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
const MODEL = process.env.LLM_MODEL || 'qwen2.5:0.5b';
const API = (process.env.LLM_API || (/\/v1$/.test(URL_BASE) ? 'openai' : 'ollama')).toLowerCase();

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

const SYSTEM = 'You are a contestant\'s phone-a-friend on a television quiz show. '
  + 'You are enthusiastic and you always commit to one answer, even when you are unsure. '
  + 'Reply with the letter of your choice and one short sentence of reasoning. Never say you cannot answer.';

// Trimmed hard: the card has room for a sentence or two, and a 0.5b model left
// to run will happily restate the whole question back at you.
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
 * Pull the weights into memory without asking anything of them. Ollama treats
 * an empty prompt as exactly this request. The OpenAI shape has no load call,
 * so we spend a single token to get the same effect.
 */
async function loadModel() {
  if (API === 'openai') {
    await post('/chat/completions', {
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    }, LOAD_TIMEOUT_MS);
  } else {
    await post('/api/generate', { model: MODEL, prompt: '', keep_alive: KEEP_ALIVE }, LOAD_TIMEOUT_MS);
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
    + 'Which letter is correct? Answer in the form "B - short reason".';
}

/**
 * Pull a choice index out of whatever the model said.
 *
 * Order matters. An explicit "the answer is C" beats a leading letter, which in
 * turn beats matching the answer text, because a reply that opens with "A "
 * is as likely to be the article as the option.
 */
function parsePick(reply, choices) {
  const text = String(reply || '');

  const labelled = text.match(/\b(?:answer|option|choice|pick|say|go with)\b[^A-Za-z0-9]{0,12}\(?([A-D])\)?(?![A-Za-z])/i);
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

function tidy(reply) {
  const text = String(reply || '').replace(/\s+/g, ' ').trim();
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
      temperature: 0.8,
      max_tokens: 120,
    });
    raw = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
  } else {
    const data = await post('/api/generate', {
      model: MODEL,
      system: SYSTEM,
      prompt,
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: { temperature: 0.8, num_predict: 120 },
    });
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
