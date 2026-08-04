'use strict';

/**
 * The board is a wheel:
 *   - an outer ring of 42 spaces
 *   - 6 "category headquarters" spaces evenly spaced around the ring
 *   - 6 "roll again" spaces, each of which is the mouth of a spoke
 *   - 6 spokes of 5 spaces each, running inward to the hub
 *
 * Movement is modelled as a graph walk: you take exactly N steps and may
 * never step back onto the space you just came from (i.e. no reversing
 * mid-move), which is how direction works in the original game.
 */

// Short codes are used as the on-board glyphs - deliberately plain text so they
// render identically on every OS (emoji fonts are not guaranteed anywhere).
const CATEGORIES = [
  { id: 0, key: 'geography', name: 'Geography', short: 'Geo', color: '#2d7dd2' },
  { id: 1, key: 'entertainment', name: 'Entertainment', short: 'Ent', color: '#e0489f' },
  { id: 2, key: 'history', name: 'History', short: 'His', color: '#eab308' },
  { id: 3, key: 'arts', name: 'Arts & Literature', short: 'Art', color: '#9061f9' },
  { id: 4, key: 'science', name: 'Science & Nature', short: 'Sci', color: '#22c55e' },
  { id: 5, key: 'sports', name: 'Sports & Leisure', short: 'Spt', color: '#f97316' },
];

const RING_SIZE = 42;
const SEGMENT = RING_SIZE / 6; // 7 spaces per segment
const SPOKE_COUNT = 6;
const SPOKE_LEN = 5;

// Geometry (SVG units, board centred on 0,0)
const R_RING = 296;
const R_HUB = 62;

const TYPE = {
  HQ: 'hq',
  ROLL: 'roll',
  CATEGORY: 'category',
  HUB: 'hub',
};

function polar(radius, index, total, offsetDeg) {
  const deg = (index / total) * 360 + (offsetDeg || 0) - 90;
  const rad = (deg * Math.PI) / 180;
  return {
    x: Math.round(Math.cos(rad) * radius * 100) / 100,
    y: Math.round(Math.sin(rad) * radius * 100) / 100,
    angle: Math.round(deg * 100) / 100,
  };
}

function buildBoard() {
  const nodes = {};
  const order = [];

  const add = (node) => {
    nodes[node.id] = node;
    order.push(node.id);
    return node;
  };

  // ---- outer ring -------------------------------------------------------
  for (let i = 0; i < RING_SIZE; i++) {
    const id = `R${i}`;
    const withinSegment = i % SEGMENT;
    const segment = Math.floor(i / SEGMENT);
    const pos = polar(R_RING, i, RING_SIZE, 0);

    let node;
    if (withinSegment === 0) {
      node = { id, type: TYPE.HQ, category: segment, ring: i };
    } else if (withinSegment === 3) {
      node = { id, type: TYPE.ROLL, category: null, ring: i, spoke: segment };
    } else {
      // Each segment carries one space of every category except its own HQ.
      const slot = withinSegment > 3 ? withinSegment - 2 : withinSegment - 1; // 0..4
      node = { id, type: TYPE.CATEGORY, category: (segment + slot + 1) % 6, ring: i };
    }
    add(Object.assign(node, { x: pos.x, y: pos.y, angle: pos.angle }));
  }

  // ---- spokes -----------------------------------------------------------
  const step = (R_RING - R_HUB) / (SPOKE_LEN + 1);
  for (let k = 0; k < SPOKE_COUNT; k++) {
    const mouthRing = k * SEGMENT + 3;
    for (let j = 0; j < SPOKE_LEN; j++) {
      const id = `S${k}_${j}`;
      // 5 distinct categories per spoke, skipping the spoke's own index.
      const category = (k + [1, 3, 5, 2, 4][j]) % 6;
      const pos = polar(R_RING - step * (j + 1), mouthRing, RING_SIZE, 0);
      add({
        id,
        type: TYPE.CATEGORY,
        category,
        spoke: k,
        depth: j,
        x: pos.x,
        y: pos.y,
        angle: pos.angle,
      });
    }
  }

  // ---- hub --------------------------------------------------------------
  add({ id: 'HUB', type: TYPE.HUB, category: null, x: 0, y: 0, angle: 0 });

  // ---- adjacency --------------------------------------------------------
  const adj = {};
  for (const id of order) adj[id] = [];
  const link = (a, b) => {
    if (!adj[a].includes(b)) adj[a].push(b);
    if (!adj[b].includes(a)) adj[b].push(a);
  };

  for (let i = 0; i < RING_SIZE; i++) link(`R${i}`, `R${(i + 1) % RING_SIZE}`);
  for (let k = 0; k < SPOKE_COUNT; k++) {
    link(`R${k * SEGMENT + 3}`, `S${k}_0`);
    for (let j = 0; j < SPOKE_LEN - 1; j++) link(`S${k}_${j}`, `S${k}_${j + 1}`);
    link(`S${k}_${SPOKE_LEN - 1}`, 'HUB');
  }

  return { nodes, order, adj, geometry: { R_RING, R_HUB, RING_SIZE, SPOKE_LEN } };
}

const BOARD = buildBoard();

/**
 * Every space reachable in exactly `steps` moves without doubling back.
 * Returns a Map of nodeId -> shortest path (array of node ids, incl. start).
 */
function reachable(startId, steps) {
  const found = new Map();
  const walk = (current, previous, remaining, path) => {
    if (remaining === 0) {
      if (!found.has(current)) found.set(current, path);
      return;
    }
    for (const next of BOARD.adj[current]) {
      if (next === previous) continue;
      walk(next, current, remaining - 1, path.concat(next));
    }
  };
  walk(startId, null, steps, [startId]);
  return found;
}

function publicBoard() {
  return {
    nodes: BOARD.order.map((id) => {
      const n = BOARD.nodes[id];
      return {
        id: n.id,
        type: n.type,
        category: n.category,
        x: n.x,
        y: n.y,
        angle: n.angle,
        spoke: n.spoke,
      };
    }),
    geometry: BOARD.geometry,
    categories: CATEGORIES,
  };
}

module.exports = { BOARD, CATEGORIES, TYPE, reachable, publicBoard, RING_SIZE, SPOKE_LEN };
