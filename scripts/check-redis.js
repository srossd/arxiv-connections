#!/usr/bin/env node
/**
 * Checks that a Redis URL actually works for the guess tallies, before it is
 * set as a production secret.
 *
 *   REDIS_URL='rediss://…' node scripts/check-redis.js
 *
 * Exercises the real store against a throwaway namespace and day, so it proves
 * the things that matter — that EVAL is permitted, that the dedupe is atomic,
 * and that the threshold behaves — without touching live tallies.
 */
import { RedisGuessStore } from '../src/stats-redis.js';
import { MIN_RESPONDENTS } from '../src/stats.js';

const url = process.env.REDIS_URL;
if (!url) {
  console.error('Set REDIS_URL first, e.g.\n  REDIS_URL=\'rediss://…\' node scripts/check-redis.js');
  process.exit(2);
}

/**
 * Upstash shows two sets of credentials, and only one of them is ours. The REST
 * pair (an https:// URL plus a separate token) is for @upstash/redis over HTTP;
 * this app speaks the Redis wire protocol, which takes a single connection
 * string with the password already in it.
 */
function explainUrl(value) {
  if (/^https?:\/\//i.test(value)) {
    return 'That is the Upstash REST endpoint (used with UPSTASH_REDIS_REST_TOKEN).\n'
      + 'This app speaks the Redis protocol, so use the connection string instead:\n'
      + "  rediss://default:<password>@<host>:6379\n"
      + 'In the Upstash console it is under "Connect to your database", on the\n'
      + 'redis-cli / Node tab rather than the @upstash/redis snippet.';
  }
  if (!/^rediss?:\/\//i.test(value)) {
    return `Expected a redis:// or rediss:// URL, got "${value.slice(0, 24)}…".`;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return 'That does not parse as a URL.';
  }

  // A local or private-network Redis legitimately has no password and no TLS —
  // that is how the docker test instance and a Fly 6PN address both look.
  const isLocal = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(parsed.hostname)
    || parsed.hostname.endsWith('.internal');
  if (isLocal) return null;

  if (!parsed.password && !parsed.username) {
    return 'That URL has no password in it. Upstash connection strings look like\n'
      + '  rediss://default:<password>@<host>:6379\n'
      + 'The password is the credential — there is no separate token to set.';
  }
  if (parsed.protocol === 'redis:') {
    return `Use rediss:// rather than redis:// for ${parsed.hostname} — `
      + 'Upstash requires TLS, and the URL it gives you already says rediss.';
  }
  return null;
}

const problem = explainUrl(url);
if (problem) {
  console.error(`${problem}\n`);
  process.exit(2);
}

const prefix = `preflight-${Math.random().toString(36).slice(2, 10)}`;
const day = '2099-12-31';
const store = new RedisGuessStore(url, { prefix });

const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(true);
    console.log(`  ok    ${label}`);
  } catch (error) {
    results.push(false);
    console.log(`  FAIL  ${label}\n        ${error.message}`);
  }
};

const assert = (condition, message) => { if (!condition) throw new Error(message); };

console.log(`Checking ${url.replace(/\/\/[^@]*@/, '//***@')}\n`);

const started = Date.now();
await check('connects and records a guess (requires EVAL)', async () => {
  const tally = await store.record(day, 'preflight-player-1', 0, 1);
  assert(tally.total === 1, `expected total 1, got ${tally.total}`);
});

await check('hides counts below the threshold', async () => {
  const tally = await store.record(day, 'preflight-player-2', 0, 2);
  assert(tally.counts === undefined, 'counts leaked below the threshold');
});

await check('counts a repeat guess only once', async () => {
  const before = (await store.tallies(day)).groups[0].total;
  await store.record(day, 'preflight-player-1', 0, 3);
  const after = (await store.tallies(day)).groups[0].total;
  assert(before === after, `total moved from ${before} to ${after}`);
});

await check('reveals the split once enough people answer', async () => {
  for (let i = 0; i < MIN_RESPONDENTS; i++) await store.record(day, `preflight-filler-${i}`, 1, i % 4);
  const { groups } = await store.tallies(day);
  assert(groups[1].enough === true, 'threshold not reached');
  assert(Array.isArray(groups[1].counts), 'counts missing above the threshold');
});

await check('handles concurrent writes from the same player', async () => {
  await Promise.all(Array.from({ length: 10 }, () => store.record(day, 'preflight-racer', 2, 0)));
  const { groups } = await store.tallies(day);
  assert(groups[2].total === 1, `expected 1 vote, got ${groups[2].total}`);
});

await check('cleans up after itself', async () => {
  // Keys carry a TTL anyway, but leaving preflight data around is untidy.
  await store.client.del([
    ...[0, 1, 2, 3].map((g) => `${prefix}:${day}:g${g}:voters`),
    ...[0, 1, 2, 3].map((g) => `${prefix}:${day}:g${g}:counts`),
  ]);
});

await store.close();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed in ${Date.now() - started}ms`);
if (failed) {
  console.log('\nThis URL is not ready to use for guess tallies.');
  process.exit(1);
}
console.log('\nReady. Set it on the app with:\n  fly secrets set REDIS_URL=\'…\' --app arxiv-connections');
