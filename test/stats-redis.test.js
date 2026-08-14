import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_RESPONDENTS } from '../src/stats.js';

// Runs only when a Redis is reachable:
//   docker run -d -p 6380:6379 redis:7-alpine
//   REDIS_URL=redis://localhost:6380 npm test
const URL = process.env.REDIS_URL;
const options = URL ? {} : { skip: 'set REDIS_URL to run the Redis-backed tests' };

const { RedisGuessStore } = URL ? await import('../src/stats-redis.js') : {};
const player = (n) => `player-${String(n).padStart(4, '0')}`;

// Keys outlive a test run (they carry a 40-day TTL), so each run gets its own
// namespace rather than flushing a database it does not own.
const PREFIX = `axctest-${Math.random().toString(36).slice(2, 10)}`;

// A distinct day per test keeps them independent without flushing shared state.
let counter = 0;
const nextDay = () => `2099-01-${String(++counter).padStart(2, '0')}`;

const withStore = async (fn) => {
  const store = new RedisGuessStore(URL, { prefix: PREFIX });
  try { await fn(store); } finally { await store.close(); }
};

test('the split stays hidden until enough people have answered', options, async () => {
  await withStore(async (store) => {
    const day = nextDay();
    for (let i = 0; i < MIN_RESPONDENTS - 1; i++) {
      const tally = await store.record(day, player(i), 0, i % 4);
      assert.equal(tally.enough, false);
      assert.equal(tally.counts, undefined);
    }
    const tally = await store.record(day, player(99), 0, 1);
    assert.equal(tally.enough, true);
    assert.equal(tally.total, MIN_RESPONDENTS);
  });
});

test('a player is counted once and their first answer is final', options, async () => {
  await withStore(async (store) => {
    const day = nextDay();
    for (let i = 0; i < MIN_RESPONDENTS; i++) await store.record(day, player(i), 0, 2);
    for (const pick of [0, 1, 3]) await store.record(day, player(0), 0, pick);

    const { groups } = await store.tallies(day);
    assert.equal(groups[0].total, MIN_RESPONDENTS);
    assert.equal(groups[0].counts[2], MIN_RESPONDENTS);
    assert.equal(groups[0].counts[0], 0);
  });
});

test('groups are tallied independently', options, async () => {
  await withStore(async (store) => {
    const day = nextDay();
    for (let i = 0; i < MIN_RESPONDENTS; i++) await store.record(day, player(i), 0, 1);
    for (let i = 0; i < 3; i++) await store.record(day, player(i), 1, 2);

    const { groups } = await store.tallies(day);
    assert.equal(groups[0].enough, true);
    assert.equal(groups[1].enough, false);
    assert.equal(groups[1].total, 3);
    assert.equal(groups[2].total, 0);
  });
});

test('malformed input is rejected rather than recorded', options, async () => {
  await withStore(async (store) => {
    const day = nextDay();
    for (const args of [
      ['2099-1-1', player(1), 0, 0], [day, 'no', 0, 0], [day, 'has spaces!!', 0, 0],
      [day, player(1), 4, 0], [day, player(1), -1, 0], [day, player(1), 0, 4],
      [day, player(1), 0, 1.5], [day, player(1), '0', 0],
    ]) {
      await assert.rejects(() => store.record(...args), /bad request/);
    }
    const { groups } = await store.tallies(day);
    assert.equal(groups[0].total, 0);
  });
});

test('concurrent guesses are all counted exactly once', options, async () => {
  await withStore(async (store) => {
    const day = nextDay();
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.record(day, player(i), 1, i % 4)));
    const { groups } = await store.tallies(day);
    assert.equal(groups[1].total, 50);
    assert.deepEqual(groups[1].counts, [13, 13, 12, 12]);
  });
});

test('the same player voting concurrently is still counted once', options, async () => {
  await withStore(async (store) => {
    const day = nextDay();
    // The dedupe and the increment must be atomic, or a racing duplicate slips through.
    await Promise.all(Array.from({ length: 20 }, () => store.record(day, player(7), 2, 3)));
    const { groups } = await store.tallies(day);
    assert.equal(groups[2].total, 1);
  });
});

test('separate instances — as separate machines would be — share one tally', options, async () => {
  const day = nextDay();
  const a = new RedisGuessStore(URL, { prefix: PREFIX });
  const b = new RedisGuessStore(URL, { prefix: PREFIX });
  try {
    // Half the players hit "machine A", half hit "machine B".
    for (let i = 0; i < 5; i++) await a.record(day, player(i), 3, 0);
    for (let i = 5; i < 10; i++) await b.record(day, player(i), 3, 1);

    for (const [name, store] of [['A', a], ['B', b]]) {
      const { groups } = await store.tallies(day);
      assert.equal(groups[3].total, MIN_RESPONDENTS, `machine ${name} should see every vote`);
      assert.equal(groups[3].enough, true, `machine ${name} should cross the threshold`);
      assert.deepEqual(groups[3].counts, [5, 5, 0, 0]);
    }
  } finally {
    await a.close();
    await b.close();
  }
});
