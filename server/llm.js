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
 */

const URL_BASE = (process.env.LLM_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || 'qwen2.5:0.5b';
const TIMEOUT_MS = Math.max(2000, Number(process.env.LLM_TIMEOUT_MS) || 20000);
const API = (process.env.LLM_API || (/\/v1$/.test(URL_BASE) ? 'openai' : 'ollama')).toLowerCase();

// How long a probe result is trusted before we look again. Short enough that
// starting Ollama mid-game makes the button light up without a restart.
const PROBE_TTL_MS = 30000;

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
};

function displayModel() {
  return MODEL;
}

/** Fetch with a hard timeout - a stalled socket must not strand a turn. */
async function post(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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

async function probeOnce() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const path = API === 'openai' ? '/models' : '/api/tags';
    const res = await fetch(URL_BASE + path, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Availability, refreshed lazily in the background. Callers get the cached
 * answer immediately - this is read on every state broadcast, so it must not
 * await anything.
 */
function ready() {
  const age = Date.now() - state.checkedAt;
  if (age > PROBE_TTL_MS && !state.inflight) {
    state.inflight = probeOnce().then((up) => {
      if (state.up !== up) {
        console.log(`[llm] ${displayModel()} at ${URL_BASE} is ${up ? 'reachable' : 'not reachable'}`);
      }
      state.up = up;
      state.checkedAt = Date.now();
      state.inflight = null;
    });
  }
  // Unknown counts as available: better to let someone try and get an apology
  // than to grey the button out before we have ever looked.
  return state.up !== false;
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
      options: { temperature: 0.8, num_predict: 120 },
    });
    raw = data ? data.response : '';
  }

  state.up = true;
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
  state.checkedAt = Date.now();
}

module.exports = { ask, ready, markDown, displayModel, MODEL, URL_BASE, API };
