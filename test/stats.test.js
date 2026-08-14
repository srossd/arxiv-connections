import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GuessStore, MIN_RESPONDENTS } from '../src/stats.js';

const freshStore = async () => new GuessStore(await mkdtemp(path.join(tmpdir(), 'axc-stats-')));
const DAY = '2026-08-14';
const player = (n) => `player-${String(n).padStart(4, '0')}`;

test('the split stays hidden until enough people have answered', async () => {
  const store = await freshStore();
  for (let i = 0; i < MIN_RESPONDENTS - 1; i++) {
    const tally = await store.record(DAY, player(i), 0, i % 4);
    assert.equal(tally.enough, false);
    assert.equal(tally.counts, undefined, 'counts must not leak below the threshold');
  }
  const tally = await store.record(DAY, player(99), 0, 1);
  assert.equal(tally.enough, true);
  assert.equal(tally.total, MIN_RESPONDENTS);
  assert.equal(tally.counts.reduce((a, b) => a + b, 0), MIN_RESPONDENTS);
});

test('a tally counts each player once, and the first answer is final', async () => {
  const store = await freshStore();
  for (let i = 0; i < MIN_RESPONDENTS; i++) await store.record(DAY, player(i), 0, 2);

  // Same player tries again with a different answer, several times.
  for (const pick of [0, 1, 3]) await store.record(DAY, player(0), 0, pick);

  const { groups } = await store.tallies(DAY);
  assert.equal(groups[0].total, MIN_RESPONDENTS, 'no double counting');
  assert.equal(groups[0].counts[2], MIN_RESPONDENTS, 'original answer retained');
  assert.equal(groups[0].counts[0], 0);
});

test('groups are tallied independently', async () => {
  const store = await freshStore();
  for (let i = 0; i < MIN_RESPONDENTS; i++) await store.record(DAY, player(i), 0, 1);
  for (let i = 0; i < 3; i++) await store.record(DAY, player(i), 1, 2);

  const { groups } = await store.tallies(DAY);
  assert.equal(groups[0].enough, true, 'group 0 has enough answers');
  assert.equal(groups[1].enough, false, 'group 1 does not');
  assert.equal(groups[1].total, 3);
  assert.equal(groups[2].total, 0);
});

test('guesses survive a restart', async () => {
  const store = await freshStore();
  for (let i = 0; i < MIN_RESPONDENTS; i++) await store.record(DAY, player(i), 3, i % 4);
  await store.flush();

  const reopened = new GuessStore(store.dir);
  const { groups } = await reopened.tallies(DAY);
  assert.equal(groups[3].total, MIN_RESPONDENTS);
  assert.equal(groups[3].enough, true);

  // ...and no temp files were left behind.
  const files = await readdir(store.dir);
  assert.deepEqual(files, [`guesses-${DAY}.json`]);
});

test('malformed input is rejected rather than recorded', async () => {
  const store = await freshStore();
  const bad = [
    ['2026-8-14', player(1), 0, 0],       // malformed day
    [DAY, 'no', 0, 0],                    // player id too short
    [DAY, 'has spaces!!', 0, 0],          // player id charset
    [DAY, player(1), 4, 0],               // group out of range
    [DAY, player(1), -1, 0],              // negative group
    [DAY, player(1), 0, 4],               // pick out of range
    [DAY, player(1), 0, 1.5],             // non-integer
    [DAY, player(1), '0', 0],             // wrong type
  ];
  for (const args of bad) {
    await assert.rejects(() => store.record(...args), /bad request/, `should reject ${JSON.stringify(args)}`);
  }
  const { groups } = await store.tallies(DAY);
  assert.equal(groups[0].total, 0, 'nothing was recorded');
});

test('concurrent guesses are all recorded without clobbering the file', async () => {
  const store = await freshStore();
  await Promise.all(
    Array.from({ length: 50 }, (_, i) => store.record(DAY, player(i), 1, i % 4)),
  );
  await store.flush();

  const onDisk = JSON.parse(await readFile(path.join(store.dir, `guesses-${DAY}.json`), 'utf8'));
  assert.equal(Object.keys(onDisk.players).length, 50);

  const { groups } = await store.tallies(DAY);
  assert.equal(groups[1].total, 50);
  assert.deepEqual(groups[1].counts, [13, 13, 12, 12]);
});
