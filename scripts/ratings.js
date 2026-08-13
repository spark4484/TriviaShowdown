#!/usr/bin/env node
'use strict';

/**
 * Print the question ratings players have left, worst first.
 *
 * Questions marked RETIRED are already being withheld by the server. This
 * report is for the follow-up: deciding which ones to fix or delete from
 * server/questions.js (or server/questions-nerd.js) for good.
 *
 *   npm run ratings          # everything rated so far
 *   npm run ratings -- 20    # just the 20 worst
 */

const CLASSIC = require('../server/questions');
const NERD = require('../server/questions-nerd');
const { CATEGORY_SETS } = require('../server/board');
const { votes, RETIRE_DOWNS, RETIRE_RATIO, VOTES_FILE } = require('../server/votes');

const limit = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : Infinity;

// Ratings are global, so a rated question could have come from either bank.
// The label says which, since a slot number on its own does not identify a
// subject.
const labels = new Map();
for (const [edition, bank] of [['classic', CLASSIC], ['nerd', NERD]]) {
  for (const q of bank) labels.set(q.id, CATEGORY_SETS[edition][q.c].name);
}

const rows = votes.report([...CLASSIC, ...NERD]);

console.log(`\n  ${VOTES_FILE}`);
console.log(`  retiring at ${RETIRE_DOWNS}+ downvotes when downs are ${RETIRE_RATIO}x the ups\n`);

if (rows.length === 0) {
  console.log('  Nobody has rated a question yet.\n');
  process.exit(0);
}

const shown = rows.slice(0, limit);
for (const r of shown) {
  const tier = r.difficulty === 2 ? 'hard' : r.difficulty === 1 ? 'easy' : '?';
  const cat = labels.get(r.id) || 'unknown';
  const flag = r.retired ? ' RETIRED' : '';
  console.log(`  +${r.up} -${r.down}${flag}  [${cat} / ${tier}]`);
  console.log(`    ${r.text}`);
}

const retired = rows.filter((r) => r.retired).length;
const orphans = rows.filter((r) => r.category == null).length;
console.log(`\n  ${rows.length} questions rated, ${retired} retired${shown.length < rows.length ? ` (showing ${shown.length})` : ''}.`);
if (orphans) console.log(`  ${orphans} ratings belong to questions no longer in the bank - they are ignored.`);
console.log('');
