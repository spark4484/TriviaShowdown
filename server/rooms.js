'use strict';

const { Game } = require('./game');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // reap abandoned rooms after 6h
const SWEEP_MS = 10 * 60 * 1000;

function makeCode() {
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

class RoomManager {
  constructor() {
    /** @type {Map<string, {game: Game, sockets: Map<string, Set<any>>, lastSeen: number}>} */
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  create() {
    let code = makeCode();
    let guard = 0;
    while (this.rooms.has(code) && guard++ < 500) code = makeCode();
    const room = {
      code,
      game: null,
      sockets: new Map(),
      lastSeen: Date.now(),
    };
    room.game = new Game(code, () => this.broadcast(code));
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase().trim()) || null;
  }

  attach(room, playerId, ws) {
    if (!room.sockets.has(playerId)) room.sockets.set(playerId, new Set());
    room.sockets.get(playerId).add(ws);
    room.lastSeen = Date.now();
  }

  detach(room, playerId, ws) {
    const set = room.sockets.get(playerId);
    if (!set) return false;
    set.delete(ws);
    if (set.size === 0) {
      room.sockets.delete(playerId);
      return true; // fully disconnected
    }
    return false;
  }

  broadcast(code, extra) {
    const room = this.get(code);
    if (!room) return;
    const payload = JSON.stringify(Object.assign({ t: 'state', state: room.game.toJSON() }, extra || {}));
    for (const set of room.sockets.values()) {
      for (const ws of set) {
        if (ws.readyState === 1) ws.send(payload);
      }
    }
    room.lastSeen = Date.now();
  }

  send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  broadcastRaw(code, msg) {
    const room = this.get(code);
    if (!room) return;
    const payload = JSON.stringify(msg);
    for (const set of room.sockets.values()) {
      for (const ws of set) {
        if (ws.readyState === 1) ws.send(payload);
      }
    }
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const idle = now - room.lastSeen > ROOM_TTL_MS;
      const empty = room.sockets.size === 0 && now - room.lastSeen > 60 * 60 * 1000;
      if (idle || empty) {
        room.game.clearTimer();
        this.rooms.delete(code);
        console.log(`[rooms] reaped ${code}`);
      }
    }
  }
}

module.exports = { RoomManager, makeCode };
