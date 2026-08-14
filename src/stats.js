import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Records which title each player accused in each group, so the game can show
 * "63% of players picked this one" once enough people have answered.
 *
 * One JSON file per day. Players are identified by a random id the browser
 * generates for itself — there is nothing here to tie a row to a person.
 */

export const MIN_RESPONDENTS = 10;   // below this a group's split stays hidden
const MAX_PLAYERS_PER_DAY = 20_000;  // guard against a runaway file
const GROUPS = 4;
const OPTIONS = 4;

export const isValidDay = (day) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day);
export const isValidPlayer = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
const isIndex = (n, max) => Number.isInteger(n) && n >= 0 && n < max;

export class GuessStore {
  constructor(dir) {
    this.dir = dir;
    this.days = new Map();        // day -> { players: {id: [pick|null x4]} }
    this.writes = Promise.resolve();  // serialises writes; one process, one queue
  }

  #pathFor(day) {
    return path.join(this.dir, `guesses-${day}.json`);
  }

  /**
   * Cache the *promise*, not the resolved value. Concurrent first-hits would
   * otherwise each miss the cache, each build their own state object, and the
   * last one to finish would silently discard the rest.
   */
  #load(day) {
    if (!this.days.has(day)) {
      this.days.set(day, (async () => {
        try {
          const parsed = JSON.parse(await readFile(this.#pathFor(day), 'utf8'));
          if (parsed && typeof parsed.players === 'object') return { players: parsed.players };
        } catch { /* first guess of the day */ }
        return { players: {} };
      })());
    }
    return this.days.get(day);
  }

  /** Serialised, and written via a temp file so a crash cannot truncate the real one. */
  #persist(day, data) {
    this.writes = this.writes.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const target = this.#pathFor(day);
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ day, players: data.players }));
      await rename(temp, target);
    }).catch((error) => {
      console.warn('[stats] could not persist guesses:', error.message);
    });
    return this.writes;
  }

  /**
   * Records one accusation. A player's first answer for a group is final —
   * later submissions for the same group are ignored rather than overwriting,
   * so a reload or a replay cannot skew the split.
   *
   * Returns the tally for that group, including the caller's own guess.
   */
  async record(day, player, group, pick) {
    if (!isValidDay(day) || !isValidPlayer(player)) throw new Error('bad request');
    if (!isIndex(group, GROUPS) || !isIndex(pick, OPTIONS)) throw new Error('bad request');

    const data = await this.#load(day);
    const known = Object.hasOwn(data.players, player);
    if (!known && Object.keys(data.players).length >= MAX_PLAYERS_PER_DAY) {
      return this.#tallyFor(data, group);
    }

    const picks = known ? data.players[player] : new Array(GROUPS).fill(null);
    if (picks[group] === null || picks[group] === undefined) {
      picks[group] = pick;
      data.players[player] = picks;
      await this.#persist(day, data);
    }
    return this.#tallyFor(data, group);
  }

  #tallyFor(data, group) {
    const counts = new Array(OPTIONS).fill(0);
    let total = 0;
    for (const picks of Object.values(data.players)) {
      const pick = picks?.[group];
      if (isIndex(pick, OPTIONS)) { counts[pick]++; total++; }
    }
    const enough = total >= MIN_RESPONDENTS;
    // Counts stay hidden below the threshold so a small sample cannot be read
    // off the wire before it is meaningful.
    return enough ? { group, total, enough, counts } : { group, total, enough };
  }

  /** Tallies for every group of a day. */
  async tallies(day) {
    if (!isValidDay(day)) throw new Error('bad request');
    const data = await this.#load(day);
    const groups = {};
    for (let group = 0; group < GROUPS; group++) groups[group] = this.#tallyFor(data, group);
    return { day, minRespondents: MIN_RESPONDENTS, groups };
  }

  /** Waits for queued writes — used by tests. */
  async flush() {
    await this.writes;
  }
}
