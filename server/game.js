'use strict';

const { BOARD, CATEGORIES, TYPE, reachable } = require('./board');
const QUESTIONS = require('./questions');

const PLAYER_COLORS = ['#ff5252', '#40c4ff', '#69f0ae', '#ffd740', '#b388ff', '#ff8a65'];
const MAX_PLAYERS = 6;
const REVEAL_MS = 3400;
const MAX_LOG = 60;

const DEFAULT_OPTIONS = {
  wedgesToWin: 6,
  answerSeconds: 30, // 0 = no limit
};

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class Game {
  /**
   * @param {string} code room code
   * @param {() => void} onChange called whenever state changes from a timer
   */
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange || (() => {});
    this.createdAt = Date.now();

    this.phase = 'lobby';
    this.players = [];
    this.hostId = null;
    this.options = { ...DEFAULT_OPTIONS };

    this.turnIndex = 0;
    this.step = 'roll';
    this.roll = null;
    this.rollSeq = 0;
    this.moveOptions = [];
    this.question = null;
    this.categoryChooserId = null;
    this.winnerId = null;
    this.log = [];
    this.deadline = null;
    this.lastActionAt = Date.now();

    this.timer = null;
    this.decks = CATEGORIES.map(() => []);
  }

  // ------------------------------------------------------------- utilities
  now() {
    return Date.now();
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  schedule(ms, fn) {
    this.clearTimer();
    this.deadline = this.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deadline = null;
      try {
        fn();
      } catch (err) {
        console.error('[game] timer error', err);
      }
      this.onChange();
    }, ms);
  }

  addLog(text) {
    this.log.push({ t: this.now(), text });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }

  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  current() {
    return this.players[this.turnIndex] || null;
  }

  isEmpty() {
    return this.players.every((p) => !p.connected);
  }

  // -------------------------------------------------------------- lobby ops
  addPlayer(id, name) {
    const existing = this.player(id);
    if (existing) {
      existing.connected = true;
      if (name) existing.name = name;
      if (!this.hostId) this.hostId = existing.id;
      return { ok: true, player: existing, rejoined: true };
    }
    if (this.phase !== 'lobby') return { ok: false, error: 'That game is already in progress.' };
    if (this.players.length >= MAX_PLAYERS) return { ok: false, error: 'That room is full (6 players max).' };

    const used = new Set(this.players.map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[0];
    const player = {
      id,
      name: (name || 'Player').slice(0, 18),
      color,
      connected: true,
      node: 'HUB',
      wedges: [false, false, false, false, false, false],
      correct: 0,
      asked: 0,
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = id;
    this.addLog(`${player.name} joined the game.`);
    return { ok: true, player };
  }

  setConnected(id, connected) {
    const p = this.player(id);
    if (!p) return;
    p.connected = connected;
    if (!connected && this.phase === 'lobby') {
      // Drop from the lobby entirely so the seat frees up.
      this.players = this.players.filter((x) => x.id !== id);
      this.addLog(`${p.name} left.`);
      if (this.hostId === id) this.hostId = this.players[0] ? this.players[0].id : null;
    } else if (!connected) {
      this.addLog(`${p.name} disconnected.`);
      // Don't strand everyone else - host powers move to someone still here.
      if (this.hostId === id) {
        const heir = this.players.find((x) => x.connected && x.id !== id);
        if (heir) {
          this.hostId = heir.id;
          this.addLog(`${heir.name} is now the host.`);
        }
      }
    } else {
      this.addLog(`${p.name} reconnected.`);
      if (!this.players.some((x) => x.id === this.hostId && x.connected)) {
        this.hostId = id;
        this.addLog(`${p.name} is now the host.`);
      }
    }
  }

  setOptions(byId, options) {
    if (byId !== this.hostId) return { ok: false, error: 'Only the host can change settings.' };
    if (this.phase !== 'lobby') return { ok: false, error: 'Settings are locked once the game starts.' };
    const wedges = Number(options.wedgesToWin);
    const seconds = Number(options.answerSeconds);
    if ([3, 4, 5, 6].includes(wedges)) this.options.wedgesToWin = wedges;
    if ([0, 20, 30, 45, 60].includes(seconds)) this.options.answerSeconds = seconds;
    return { ok: true };
  }

  start(byId) {
    if (byId !== this.hostId) return { ok: false, error: 'Only the host can start the game.' };
    if (this.phase === 'playing') return { ok: false, error: 'The game has already started.' };
    if (this.players.length < 1) return { ok: false, error: 'You need at least one player.' };

    this.phase = 'playing';
    this.players = shuffle(this.players);
    this.players.forEach((p) => {
      p.node = 'HUB';
      p.wedges = [false, false, false, false, false, false];
      p.correct = 0;
      p.asked = 0;
    });
    this.turnIndex = 0;
    this.step = 'roll';
    this.roll = null;
    this.moveOptions = [];
    this.question = null;
    this.winnerId = null;
    this.decks = CATEGORIES.map(() => []);
    this.clearTimer();
    this.deadline = null;
    this.addLog(`Game on! First to ${this.options.wedgesToWin} wedges and back to the hub wins.`);
    this.addLog(`${this.current().name} goes first.`);
    return { ok: true };
  }

  reset(byId) {
    if (byId !== this.hostId) return { ok: false, error: 'Only the host can start a new game.' };
    this.clearTimer();
    this.phase = 'lobby';
    this.winnerId = null;
    this.question = null;
    this.moveOptions = [];
    this.roll = null;
    this.deadline = null;
    this.log = [];
    this.addLog('Back to the lobby - set up another game.');
    return { ok: true };
  }

  // --------------------------------------------------------------- turn ops
  roll_(byId) {
    if (this.phase !== 'playing') return { ok: false, error: 'The game is not running.' };
    const cur = this.current();
    if (!cur || cur.id !== byId) return { ok: false, error: "It's not your turn." };
    if (this.step !== 'roll') return { ok: false, error: 'You cannot roll right now.' };

    this.clearTimer();
    this.deadline = null;
    const value = 1 + Math.floor(Math.random() * 6);
    this.roll = value;
    this.rollSeq++;
    this.lastActionAt = this.now();

    const paths = reachable(cur.node, value);
    this.moveOptions = Array.from(paths.entries()).map(([node, path]) => ({ node, path }));
    this.step = 'move';
    this.addLog(`${cur.name} rolled a ${value}.`);

    if (this.moveOptions.length === 1) {
      // Only one legal landing space - take it automatically.
      return this.move(byId, this.moveOptions[0].node);
    }
    return { ok: true };
  }

  move(byId, nodeId) {
    if (this.phase !== 'playing') return { ok: false, error: 'The game is not running.' };
    const cur = this.current();
    if (!cur || cur.id !== byId) return { ok: false, error: "It's not your turn." };
    if (this.step !== 'move') return { ok: false, error: 'There is no move to make.' };

    const choice = this.moveOptions.find((o) => o.node === nodeId);
    if (!choice) return { ok: false, error: 'That space is not reachable with this roll.' };

    cur.node = nodeId;
    this.moveOptions = [];
    this.lastActionAt = this.now();

    const space = BOARD.nodes[nodeId];

    if (space.type === TYPE.ROLL) {
      this.addLog(`${cur.name} landed on Roll Again.`);
      this.step = 'roll';
      return { ok: true };
    }

    if (space.type === TYPE.HUB) {
      if (this.wedgeCount(cur) >= this.options.wedgesToWin) {
        this.step = 'category';
        const chooser = this.players[(this.turnIndex + 1) % this.players.length];
        this.categoryChooserId = chooser ? chooser.id : cur.id;
        this.addLog(`${cur.name} reached the hub! ${chooser && chooser.id !== cur.id ? chooser.name + ' picks' : 'Pick'} the winning category.`);
      } else {
        this.addLog(`${cur.name} passed through the hub - roll again.`);
        this.step = 'roll';
      }
      return { ok: true };
    }

    // hq or plain category space
    this.askQuestion(cur, space.category, space.type === TYPE.HQ, false);
    return { ok: true };
  }

  chooseCategory(byId, category) {
    if (this.step !== 'category') return { ok: false, error: 'No category to choose.' };
    const cur = this.current();
    if (byId !== this.categoryChooserId && byId !== this.hostId) {
      return { ok: false, error: 'It is not your choice to make.' };
    }
    const cat = Number(category);
    if (!Number.isInteger(cat) || cat < 0 || cat > 5) return { ok: false, error: 'Unknown category.' };
    this.lastActionAt = this.now();
    this.askQuestion(cur, cat, false, true);
    return { ok: true };
  }

  drawQuestion(category) {
    if (!this.decks[category] || this.decks[category].length === 0) {
      const pool = QUESTIONS.map((q, i) => (q.c === category ? i : -1)).filter((i) => i >= 0);
      this.decks[category] = shuffle(pool);
    }
    const idx = this.decks[category].pop();
    return QUESTIONS[idx];
  }

  askQuestion(player, category, isHq, isFinal) {
    const raw = this.drawQuestion(category);
    const correct = raw.a[0];
    const choices = shuffle(raw.a);
    this.question = {
      category,
      text: raw.q,
      choices,
      correctIndex: choices.indexOf(correct),
      forId: player.id,
      isHq,
      isFinal,
      chosenIndex: null,
      revealed: false,
      timedOut: false,
    };
    player.asked++;
    this.step = 'answer';
    const label = isFinal ? 'the winning question' : isHq ? `a ${CATEGORIES[category].name} headquarters question` : `a ${CATEGORIES[category].name} question`;
    this.addLog(`${player.name} draws ${label}.`);

    if (this.options.answerSeconds > 0) {
      this.schedule(this.options.answerSeconds * 1000, () => this.resolveAnswer(null, true));
    } else {
      this.deadline = null;
    }
  }

  answer(byId, index) {
    if (this.step !== 'answer' || !this.question) return { ok: false, error: 'There is no question to answer.' };
    if (this.question.forId !== byId) return { ok: false, error: 'This question is not yours to answer.' };
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.question.choices.length) {
      return { ok: false, error: 'Invalid answer.' };
    }
    this.lastActionAt = this.now();
    this.resolveAnswer(i, false);
    return { ok: true };
  }

  resolveAnswer(index, timedOut) {
    if (this.step !== 'answer' || !this.question) return;
    this.clearTimer();
    const q = this.question;
    const player = this.player(q.forId) || this.current();
    const correct = !timedOut && index === q.correctIndex;

    q.chosenIndex = timedOut ? null : index;
    q.revealed = true;
    q.timedOut = !!timedOut;
    q.wasCorrect = correct;
    this.step = 'reveal';

    if (correct) {
      player.correct++;
      if (q.isFinal) {
        this.addLog(`${player.name} answered correctly and WINS THE GAME!`);
        this.winnerId = player.id;
        this.phase = 'over';
        this.schedule(REVEAL_MS, () => {
          this.step = 'done';
        });
        return;
      }
      if (q.isHq && !player.wedges[q.category]) {
        player.wedges[q.category] = true;
        this.addLog(`${player.name} won the ${CATEGORIES[q.category].name} wedge! (${this.wedgeCount(player)}/${this.options.wedgesToWin})`);
      } else {
        this.addLog(`${player.name} answered correctly and rolls again.`);
      }
      this.schedule(REVEAL_MS, () => {
        this.question = null;
        this.step = 'roll';
      });
    } else {
      this.addLog(timedOut ? `${player.name} ran out of time.` : `${player.name} answered incorrectly.`);
      this.schedule(REVEAL_MS, () => {
        this.question = null;
        this.endTurn();
      });
    }
  }

  endTurn() {
    if (this.phase !== 'playing') return;
    this.clearTimer();
    this.question = null;
    this.moveOptions = [];
    this.roll = null;
    this.step = 'roll';
    if (this.players.length === 0) return;
    this.turnIndex = (this.turnIndex + 1) % this.players.length;
    this.lastActionAt = this.now();
    const next = this.current();
    if (next) this.addLog(`${next.name}'s turn.`);
  }

  skip(byId) {
    if (this.phase !== 'playing') return { ok: false, error: 'The game is not running.' };
    const cur = this.current();
    if (!cur) return { ok: false, error: 'No active turn.' };
    const stalled = this.now() - this.lastActionAt > 45000;
    if (byId !== this.hostId && !(!cur.connected || stalled)) {
      return { ok: false, error: 'Only the host can skip an active player.' };
    }
    this.addLog(`${cur.name}'s turn was skipped.`);
    this.endTurn();
    return { ok: true };
  }

  wedgeCount(player) {
    return player.wedges.filter(Boolean).length;
  }

  /** Remove a player mid-game (used when a seat is abandoned by request). */
  kick(byId, targetId) {
    if (byId !== this.hostId) return { ok: false, error: 'Only the host can remove players.' };
    const idx = this.players.findIndex((p) => p.id === targetId);
    if (idx < 0) return { ok: false, error: 'No such player.' };
    const [gone] = this.players.splice(idx, 1);
    this.addLog(`${gone.name} was removed from the game.`);
    if (this.players.length === 0) {
      this.phase = 'lobby';
      return { ok: true };
    }
    if (idx < this.turnIndex) this.turnIndex--;
    if (this.turnIndex >= this.players.length) this.turnIndex = 0;
    if (this.phase === 'playing' && gone.id === (this.question && this.question.forId)) {
      this.clearTimer();
      this.question = null;
      this.step = 'roll';
    }
    return { ok: true };
  }

  // ------------------------------------------------------------ serialising
  toJSON() {
    const cur = this.current();
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      options: this.options,
      wedgesToWin: this.options.wedgesToWin,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        connected: p.connected,
        node: p.node,
        wedges: p.wedges,
        correct: p.correct,
        asked: p.asked,
      })),
      turn: cur
        ? {
            playerId: cur.id,
            step: this.step,
            roll: this.roll,
            rollSeq: this.rollSeq,
            options: this.moveOptions,
            categoryChooserId: this.step === 'category' ? this.categoryChooserId : null,
            deadline: this.deadline,
          }
        : null,
      question: this.question
        ? {
            category: this.question.category,
            text: this.question.text,
            choices: this.question.choices,
            forId: this.question.forId,
            isHq: this.question.isHq,
            isFinal: this.question.isFinal,
            revealed: this.question.revealed,
            chosenIndex: this.question.chosenIndex,
            timedOut: this.question.timedOut,
            correctIndex: this.question.revealed ? this.question.correctIndex : null,
            wasCorrect: this.question.revealed ? this.question.wasCorrect : null,
          }
        : null,
      winnerId: this.winnerId,
      log: this.log.slice(-24),
      serverTime: this.now(),
    };
  }
}

module.exports = { Game, MAX_PLAYERS };
