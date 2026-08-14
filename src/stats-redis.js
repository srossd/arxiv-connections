import { createClient } from 'redis';
import {
  GROUPS, MIN_RESPONDENTS, OPTIONS, isIndex, isValidDay, isValidPlayer, shapeTally,
} from './stats.js';

/**
 * Guess tallies in Redis, so several machines can serve the same day's split.
 *
 * The file-backed store is fine on one machine, but a Fly volume attaches to
 * exactly one machine — scale past that and each would keep its own tallies.
 */

const TTL_SECONDS = 40 * 24 * 60 * 60;   // keep about a month of history
const COMMAND_TIMEOUT_MS = 3000;

// Namespaced so one Redis can safely back more than one deployment (and so the
// tests can isolate themselves without flushing a database they do not own).
const votersKey = (prefix, day, group) => `${prefix}:${day}:g${group}:voters`;
const countsKey = (prefix, day, group) => `${prefix}:${day}:g${group}:counts`;

/**
 * Dedupe the voter and bump the counter in one atomic step, then return the
 * whole tally.
 *
 * As two round trips this has a gap: a crash or a dropped connection between
 * the SADD and the HINCRBY would leave a player recorded as having voted with
 * no vote counted — permanently, since they can never vote again. Read-modify-
 * write from the application would be worse still, losing votes whenever two
 * machines answered at once.
 */
const RECORD_SCRIPT = `
local added = redis.call('SADD', KEYS[1], ARGV[1])
if added == 1 then
  redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return redis.call('HGETALL', KEYS[2])
`;

/**
 * A connected-but-unresponsive server would stall a request just as surely as a
 * disconnected one, so every command gets a ceiling of its own.
 */
function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`redis ${label} timed out`)), COMMAND_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** HGETALL comes back as a flat [field, value, …] array (or an object). */
function countsFrom(reply) {
  const counts = new Array(OPTIONS).fill(0);
  const pairs = Array.isArray(reply)
    ? reply
    : Object.entries(reply ?? {}).flat();
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const index = Number(pairs[i]);
    const value = Number(pairs[i + 1]);
    if (isIndex(index, OPTIONS) && Number.isFinite(value)) counts[index] = value;
  }
  return counts;
}

export class RedisGuessStore {
  constructor(url, { prefix = process.env.REDIS_PREFIX ?? 'axc' } = {}) {
    this.url = url;
    this.prefix = prefix;
    this.client = null;
    this.ready = null;
  }

  /**
   * Connects on first use rather than at boot, so an unreachable Redis delays
   * the split rather than stopping the game from starting.
   */
  async #connect() {
    if (!this.ready) {
      this.client = createClient({
        url: this.url,
        // Without this, commands issued while the socket is down are queued
        // until it comes back — so a Redis outage turns every guess into a
        // hanging request instead of a fast failure the client can shrug off.
        disableOfflineQueue: true,
        socket: {
          connectTimeout: 3000,
          reconnectStrategy: (retries) => Math.min(200 * 2 ** retries, 15_000),
        },
      });
      // Without a listener a connection error is an unhandled 'error' event,
      // which would take the process down.
      this.client.on('error', (error) => console.warn('[stats] redis:', error.message));
      this.ready = this.client.connect().catch((error) => {
        this.ready = null;   // let the next request try again
        throw error;
      });
    }
    return this.ready;
  }

  async record(day, player, group, pick) {
    if (!isValidDay(day) || !isValidPlayer(player)) throw new Error('bad request');
    if (!isIndex(group, GROUPS) || !isIndex(pick, OPTIONS)) throw new Error('bad request');

    await withTimeout(this.#connect(), 'connect');
    const reply = await withTimeout(this.client.eval(RECORD_SCRIPT, {
      keys: [votersKey(this.prefix, day, group), countsKey(this.prefix, day, group)],
      arguments: [player, String(pick), String(TTL_SECONDS)],
    }), 'record');
    return shapeTally(group, countsFrom(reply));
  }

  async tallies(day) {
    if (!isValidDay(day)) throw new Error('bad request');

    await withTimeout(this.#connect(), 'connect');
    const replies = await withTimeout(Promise.all(
      Array.from({ length: GROUPS }, (_, group) =>
        this.client.hGetAll(countsKey(this.prefix, day, group))),
    ), 'tallies');
    const groups = {};
    replies.forEach((reply, group) => { groups[group] = shapeTally(group, countsFrom(reply)); });
    return { day, minRespondents: MIN_RESPONDENTS, groups };
  }

  async flush() { /* writes are synchronous from the caller's point of view */ }

  /**
   * Never hangs and never throws. `quit()` waits to flush pending commands,
   * which on an offline client means waiting forever — enough to stall a test
   * run or a shutdown behind a Redis that is already gone.
   */
  async close() {
    const client = this.client;
    this.client = null;
    this.ready = null;
    if (!client) return;
    try {
      if (client.isOpen) await withTimeout(client.quit(), 'quit');
    } catch { /* fall through to a hard close */ }
    try {
      await client.disconnect();
    } catch { /* already closed */ }
  }
}
