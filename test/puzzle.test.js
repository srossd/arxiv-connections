import test from 'node:test';
import assert from 'node:assert/strict';
import { puzzleDayFor, msUntilRollover } from '../src/puzzle.js';
import { CATEGORIES, compatible } from '../src/categories.js';

test('the puzzle day rolls over at 2am US Eastern', () => {
  // Daylight time (EDT, UTC-4): 2am ET == 06:00 UTC
  assert.equal(puzzleDayFor(new Date('2026-08-13T05:59:59Z')), '2026-08-12');
  assert.equal(puzzleDayFor(new Date('2026-08-13T06:00:01Z')), '2026-08-13');
  // Standard time (EST, UTC-5): 2am ET == 07:00 UTC
  assert.equal(puzzleDayFor(new Date('2026-01-15T06:59:59Z')), '2026-01-14');
  assert.equal(puzzleDayFor(new Date('2026-01-15T07:00:01Z')), '2026-01-15');
});

test('msUntilRollover lands on the next boundary', () => {
  const now = new Date('2026-08-13T18:00:00Z');
  const next = new Date(now.getTime() + msUntilRollover(now));
  assert.equal(puzzleDayFor(next), '2026-08-14');
  // ...and a second earlier is still the old day.
  assert.equal(puzzleDayFor(new Date(next.getTime() - 1500)), '2026-08-13');
});

test('category ids are unique and free of alias duplicates', () => {
  const ids = CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const [a, b] of [['math.MP', 'math-ph'], ['math.IT', 'cs.IT'],
                        ['math.ST', 'stat.TH'], ['cs.SY', 'eess.SY']]) {
    assert.ok(!(ids.includes(a) && ids.includes(b)), `${a} and ${b} are the same category`);
  }
});

test('compatible() rejects same-archive and confusable pairs', () => {
  const by = (id) => CATEGORIES.find((c) => c.id === id);
  assert.equal(compatible(by('math.AG'), [by('math.NT')]), false, 'same archive');
  assert.equal(compatible(by('stat.ML'), [by('cs.LG')]), false, 'confusable pair');
  assert.equal(compatible(by('math-ph'), [by('hep-th')]), false, 'confusable pair');
  assert.equal(compatible(by('math.NT'), [by('cs.SD')]), true, 'unrelated');
});

test('at least four mutually compatible categories always exist', () => {
  const chosen = [];
  for (const category of CATEGORIES) {
    if (compatible(category, chosen)) chosen.push(category);
  }
  assert.ok(chosen.length >= 4, `greedy pass found only ${chosen.length}`);
});
