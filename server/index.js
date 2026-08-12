'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const { RoomManager } = require('./rooms');
const { publicBoard } = require('./board');
const { votes } = require('./votes');
const llm = require('./llm');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BOARD_JSON = JSON.stringify(publicBoard());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- static ---
function resolveStatic(urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null; // malformed percent-encoding, e.g. "/%"
  }
  if (clean.includes('\0')) return null;
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);
  const normalized = path.normalize(full);
  // Path traversal guard. The separator matters: a bare startsWith(PUBLIC_DIR)
  // also accepts siblings like "<root>/public-secret/x".
  if (normalized !== PUBLIC_DIR && !normalized.startsWith(PUBLIC_DIR + path.sep)) return null;
  return normalized;
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (req.url === '/board.json') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-cache' });
    return res.end(BOARD_JSON);
  }

  const file = resolveStatic(req.url || '/');
  if (!file) {
    res.writeHead(400);
    return res.end('Bad request');
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});

// ------------------------------------------------------------- websockets ---
const rooms = new RoomManager();
const wss = new WebSocketServer({ server, path: '/ws' });

function fail(ws, message) {
  rooms.send(ws, { t: 'error', message });
}

function enterRoom(ws, room, playerId, name) {
  const result = room.game.addPlayer(playerId, name);
  if (!result.ok) return fail(ws, result.error);

  ws.roomCode = room.code;
  ws.playerId = playerId;
  rooms.attach(room, playerId, ws);
  if (result.rejoined) room.game.setConnected(playerId, true);

  rooms.send(ws, {
    t: 'joined',
    code: room.code,
    playerId,
    board: JSON.parse(BOARD_JSON),
  });
  rooms.broadcast(room.code);
}

const HANDLERS = {
  create(ws, msg) {
    const room = rooms.create();
    enterRoom(ws, room, msg.playerId, msg.name);
    if (msg.options) room.game.setOptions(msg.playerId, msg.options);
    rooms.broadcast(room.code);
  },

  join(ws, msg) {
    const room = rooms.get(msg.code);
    if (!room) return fail(ws, `No room called "${String(msg.code || '').toUpperCase()}". Check the code and try again.`);
    enterRoom(ws, room, msg.playerId, msg.name);
  },

  leave(ws) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    rooms.detach(room, ws.playerId, ws);
    room.game.setConnected(ws.playerId, false);
    const code = ws.roomCode;
    ws.roomCode = null;
    rooms.broadcast(code);
  },

  chat(ws, msg) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const player = room.game.player(ws.playerId);
    const text = String(msg.text || '').slice(0, 300).trim();
    if (!player || !text) return;
    rooms.broadcastRaw(room.code, {
      t: 'chat',
      from: player.name,
      color: player.color,
      text,
      ts: Date.now(),
    });
  },

  ping(ws) {
    rooms.send(ws, { t: 'pong' });
  },
};

// Game actions all follow the same shape: run it, report errors, rebroadcast.
const GAME_ACTIONS = {
  setOptions: (game, id, msg) => game.setOptions(id, msg.options || {}),
  start: (game, id) => game.start(id),
  roll: (game, id) => game.roll_(id),
  move: (game, id, msg) => game.move(id, msg.node),
  answer: (game, id, msg) => game.answer(id, msg.index),
  lifeline: (game, id, msg) => game.useLifeline(id, String(msg.kind || '')),
  chooseCategory: (game, id, msg) => game.chooseCategory(id, msg.category),
  skip: (game, id) => game.skip(id),
  kick: (game, id, msg) => game.kick(id, msg.playerId),
  playAgain: (game, id) => game.reset(id),
  voteQuestion: (game, id, msg) => game.voteQuestion(id, String(msg.questionId || ''), msg.vote),
};

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return fail(ws, 'Malformed message.');
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (HANDLERS[msg.t]) return HANDLERS[msg.t](ws, msg);

    const action = GAME_ACTIONS[msg.t];
    if (!action) return fail(ws, `Unknown action "${msg.t}".`);

    const room = rooms.get(ws.roomCode);
    if (!room) return fail(ws, 'You are not in a room.');
    const result = action(room.game, ws.playerId, msg);
    if (result && !result.ok) fail(ws, result.error);
    rooms.broadcast(room.code);
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const gone = rooms.detach(room, ws.playerId, ws);
    if (gone) room.game.setConnected(ws.playerId, false);
    rooms.broadcast(room.code);
  });

  ws.on('error', () => {});
});

// Keep-alive: tunnels and proxies drop idle sockets, so ping every 25s.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 25000);
if (heartbeat.unref) heartbeat.unref();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Trivia Showdown is running');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Ask-the-AI lifeline: ${llm.MODEL} via ${llm.URL_BASE} (preloading…)`);
  // Load the weights now and keep them resident. A cold llama-server takes
  // well over ten seconds to come up, and a player pressing the button should
  // never be the one who discovers that.
  llm.start();
  console.log('');
  console.log('  To play with friends over the internet, in another terminal run:');
  console.log(`    cloudflared tunnel --url http://localhost:${PORT}`);
  console.log('  then share the https://<something>.trycloudflare.com URL it prints.');
  console.log('');
});

function shutdown() {
  console.log('\nShutting down...');
  clearInterval(heartbeat);
  votes.close(); // ratings are written lazily; make sure the last ones land
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Exposed so test harnesses can drive a room directly.
module.exports = { server, wss, rooms };
