'use strict';

/**
 * Question ratings.
 *
 * Players thumb questions up or down while they are on screen. The tallies are
 * global (not per room) and survive restarts, so a question that keeps getting
 * booed eventually stops being dealt at all.
 *
 * Storage is a single JSON file: { "<question id>": [up, down] }. Question ids
 * are hashes of the question text (see questions.js), so votes stay attached to
 * the right question when the bank is reordered or added to. Edit a question's
 * wording and it starts over with a clean slate, which is what you want.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.VOTES_FILE || path.join(__dirname, '..', 'data', 'votes.json');

// Retire once a question has this many downvotes AND downs outweigh ups by this
// ratio. A merely divisive question survives; a broken one does not.
const RETIRE_DOWNS = Math.max(1, Number(process.env.QUESTION_RETIRE_DOWNS) || 3);
const RETIRE_RATIO = Math.max(1, Number(process.env.QUESTION_RETIRE_RATIO) || 2);

const FLUSH_MS = 2000;
const EMPTY = { up: 0, down: 0 };

class VoteStore {
  constructor(file) {
    this.file = file || FILE;
    /** @type {Map<string, {up: number, down: number}>} */
    this.tallies = new Map();
    this.dirty = false;
    this.flushTimer = null;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[votes] could not read ${this.file}: ${err.message}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Don't take the server down over a corrupt ratings file - it is not
      // load-bearing. Move it aside so the next write starts clean.
      console.warn(`[votes] ${this.file} is not valid JSON, starting fresh: ${err.message}`);
      try { fs.renameSync(this.file, this.file + '.corrupt'); } catch {}
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    for (const [id, value] of Object.entries(parsed)) {
      const [up, down] = Array.isArray(value) ? value : [value && value.up, value && value.down];
      const t = { up: clampCount(up), down: clampCount(down) };
      if (t.up || t.down) this.tallies.set(id, t);
    }
    console.log(`[votes] loaded ratings for ${this.tallies.size} questions from ${this.file}`);
  }

  tally(id) {
    return this.tallies.get(id) || EMPTY;
  }

  /**
   * Move one player's vote on a question from `before` to `after`, each of
   * -1 (down), 0 (no vote) or 1 (up).
   */
  record(id, before, after) {
    if (before === after) return this.tally(id);
    let t = this.tallies.get(id);
    if (!t) {
      t = { up: 0, down: 0 };
      this.tallies.set(id, t);
    }
    if (before === 1) t.up = Math.max(0, t.up - 1);
    if (before === -1) t.down = Math.max(0, t.down - 1);
    if (after === 1) t.up++;
    if (after === -1) t.down++;
    this.markDirty();
    return t;
  }

  isRetired(id) {
    const t = this.tallies.get(id);
    if (!t) return false;
    return t.down >= RETIRE_DOWNS && t.down >= t.up * RETIRE_RATIO;
  }

  /** Every rated question, worst first - the eviction shortlist. */
  report(questions) {
    const byId = new Map(questions.map((q) => [q.id, q]));
    const rows = [];
    for (const [id, t] of this.tallies) {
      const q = byId.get(id);
      rows.push({
        id,
        up: t.up,
        down: t.down,
        score: t.up - t.down,
        retired: this.isRetired(id),
        text: q ? q.q : '(no longer in the question bank)',
        category: q ? q.c : null,
        difficulty: q ? q.d : null,
      });
    }
    rows.sort((a, b) => a.score - b.score || b.down - a.down);
    return rows;
  }

  // ------------------------------------------------------------ persistence
  markDirty() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_MS);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  flush() {
    if (!this.dirty) return;
    const out = {};
    for (const [id, t] of this.tallies) {
      if (t.up || t.down) out[id] = [t.up, t.down];
    }
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
      fs.renameSync(tmp, this.file); // atomic, so a crash mid-write can't truncate it
      this.dirty = false;
    } catch (err) {
      console.warn(`[votes] could not save ${this.file}: ${err.message}`);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  close() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flush();
  }
}

function clampCount(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

module.exports = {
  VoteStore,
  votes: new VoteStore(),
  RETIRE_DOWNS,
  RETIRE_RATIO,
  VOTES_FILE: FILE,
};
