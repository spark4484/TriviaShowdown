#!/usr/bin/env node
'use strict';

/**
 * Print the question ratings players have left, worst first.
 *
 * Questions marked RETIRED are already being withheld by the server. This
 * report is for the follow-up: deciding which ones to fix or delete from
 * server/questions.js for good.
 *
 *   npm run ratings          # everything rated so far
 *   npm run ratings -- 20    # just the 20 worst
 */

const QUESTIONS = require('../server/questions');
const { votes, RETIRE_DOWNS, RETIRE_RATIO, VOTES_FILE } = require('../server/votes');

const CATEGORY_NAMES = ['Geography', 'Entertainment', 'History', 'Arts & Lit', 'Science', 'Sport'];
const limit = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : Infinity;

const rows = votes.report(QUESTIONS);

console.log(`\n  ${VOTES_FILE}`);
console.log(`  retiring at ${RETIRE_DOWNS}+ downvotes when downs are ${RETIRE_RATIO}x the ups\n`);

if (rows.length === 0) {
  console.log('  Nobody has rated a question yet.\n');
  process.exit(0);
}

const shown = rows.slice(0, limit);
for (const r of shown) {
  const tier = r.difficulty === 2 ? 'hard' : r.difficulty === 1 ? 'easy' : '?';
  const cat = r.category == null ? 'unknown' : CATEGORY_NAMES[r.category];
  const flag = r.retired ? ' RETIRED' : '';
  console.log(`  +${r.up} -${r.down}${flag}  [${cat} / ${tier}]`);
  console.log(`    ${r.text}`);
}

const retired = rows.filter((r) => r.retired).length;
const orphans = rows.filter((r) => r.category == null).length;
console.log(`\n  ${rows.length} questions rated, ${retired} retired${shown.length < rows.length ? ` (showing ${shown.length})` : ''}.`);
if (orphans) console.log(`  ${orphans} ratings belong to questions no longer in the bank - they are ignored.`);
console.log('');
