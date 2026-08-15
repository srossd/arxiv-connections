import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { categoriesToAvoid, mailingDayOf } from '../src/puzzle.js';

test('a mailing is dated by the day arXiv labelled it, in Eastern time', () => {
  assert.equal(mailingDayOf('Fri, 14 Aug 2026 00:00:00 -0400'), '2026-08-14');
  assert.equal(mailingDayOf('Thu, 13 Aug 2026 00:00:00 -0400'), '2026-08-13');
  // Winter, when the offset is -0500.
  assert.equal(mailingDayOf('Mon, 12 Jan 2026 00:00:00 -0500'), '2026-01-12');
  assert.equal(mailingDayOf('nonsense'), null);
  assert.equal(mailingDayOf(undefined), null);
});

const puzzleOn = (day, mailingDay, ids) => ({ day, mailingDay, groups: ids.map((id) => ({ id })) });

test('a fresh mailing avoids nothing', () => {
  const previous = [puzzleOn('2026-08-14', '2026-08-14', ['hep-th', 'cs.SD', 'math.NT', 'q-bio.NC'])];
  assert.equal(categoriesToAvoid(previous, '2026-08-17').size, 0);
});

test('a repeated mailing avoids the categories it already used', () => {
  const previous = [puzzleOn('2026-08-14', '2026-08-14', ['hep-th', 'cs.SD', 'math.NT', 'q-bio.NC'])];
  const avoid = categoriesToAvoid(previous, '2026-08-14');
  assert.deepEqual([...avoid].sort(), ['cs.SD', 'hep-th', 'math.NT', 'q-bio.NC']);
});

test('a long weekend keeps avoiding every day of the run', () => {
  // Friday announced; Saturday and Sunday reuse it.
  const previous = [
    puzzleOn('2026-08-16', '2026-08-14', ['stat.ME', 'cs.CV', 'astro-ph.GA', 'nucl-th']),  // Sun
    puzzleOn('2026-08-15', '2026-08-14', ['hep-th', 'cs.SD', 'math.NT', 'q-bio.NC']),      // Sat
    puzzleOn('2026-08-14', '2026-08-14', ['gr-qc', 'cs.LG', 'math.AG', 'stat.ML']),        // Fri
  ];
  const avoid = categoriesToAvoid(previous, '2026-08-14');
  assert.equal(avoid.size, 12, 'all three earlier days are off limits');
  // Monday would otherwise be free to reuse Friday's set.
  for (const id of ['gr-qc', 'cs.LG', 'math.AG', 'stat.ML']) {
    assert.ok(avoid.has(id), `${id} was used on the first day of the run`);
  }
});

test('the run stops at the last fresh mailing', () => {
  const previous = [
    puzzleOn('2026-08-15', '2026-08-14', ['hep-th', 'cs.SD', 'math.NT', 'q-bio.NC']),  // same mailing
    puzzleOn('2026-08-14', '2026-08-14', ['gr-qc', 'cs.LG', 'math.AG', 'stat.ML']),    // same mailing
    puzzleOn('2026-08-13', '2026-08-13', ['math.AP', 'cs.RO', 'quant-ph', 'stat.AP']), // older mailing
  ];
  const avoid = categoriesToAvoid(previous, '2026-08-14');
  assert.equal(avoid.size, 8);
  assert.ok(!avoid.has('quant-ph'), 'a different mailing is not part of this run');
});

test('puzzles predating the mailingDay field do not constrain anything', () => {
  const previous = [{ day: '2026-08-14', groups: [{ id: 'hep-th' }] }];   // no mailingDay
  assert.equal(categoriesToAvoid(previous, '2026-08-14').size, 0);
});

test('the header date never runs ahead of the puzzle day', () => {
  const announcedDay = (mailingDay, day) => (mailingDay && mailingDay < day ? mailingDay : day);
  // Weekend: papers really were announced on Friday.
  assert.equal(announcedDay('2026-08-14', '2026-08-15'), '2026-08-14');
  // Midnight-to-2am: the feed is already dated tomorrow, the puzzle is not.
  assert.equal(announcedDay('2026-08-14', '2026-08-13'), '2026-08-13');
  assert.equal(announcedDay('2026-08-14', '2026-08-14'), '2026-08-14');
  assert.equal(announcedDay(null, '2026-08-14'), '2026-08-14');
});
