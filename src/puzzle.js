import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CATEGORIES, compatible } from './categories.js';
import { fetchCategoryFeed, canonical } from './arxiv.js';
import { hasGrammar, makeFakeTitle } from './fakes.js';

const ROLLOVER_HOUR = 2;              // new puzzle at 2am US Eastern
const TIME_ZONE = 'America/New_York';
const GROUPS = 4;                     // categories per puzzle
const PER_GROUP = 4;                  // tiles per category
const REAL_PER_GROUP = 3;             // ...of which three are real papers
const MIN_POOL = 6;                   // ignore categories with a thin day
const MAX_FEED_FETCHES = 18;          // hard cap on feeds pulled per build

// Bumped whenever the payload shape changes. Cache files are keyed by date
// alone, so without this a day already cached under an older shape would keep
// being served after a format change — which is exactly how a puzzle with no
// impostors survived the round-two release.
const PUZZLE_FORMAT = 2;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** The puzzle date (YYYY-MM-DD in US Eastern) in effect at `now`. */
export function puzzleDayFor(now = new Date()) {
  return dayFormatter.format(new Date(now.getTime() - ROLLOVER_HOUR * 3600_000));
}

/** Milliseconds until the next 2am Eastern rollover. */
export function msUntilRollover(now = new Date()) {
  let probe = now.getTime();
  const today = puzzleDayFor(now);
  // Walk forward in coarse then fine steps; cheap and DST-safe.
  for (const step of [3600_000, 60_000, 1000]) {
    while (puzzleDayFor(new Date(probe)) === today) probe += step;
    probe -= step;
  }
  return probe + 1000 - now.getTime();
}

// --- deterministic RNG (xmur3 seed + mulberry32) ------------------------------

function seedFrom(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (Math.imul(h ^ (h >>> 16), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0;
}

function rngFrom(text) {
  let a = seedFrom(text);
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- puzzle construction -----------------------------------------------------

/**
 * A paper belongs to a group only if it is unambiguous: its category list must
 * not touch any of the *other* chosen categories. Otherwise a cross-listed
 * paper would be a legitimate member of two groups at once.
 */
function trimPool(pool, otherIds) {
  return pool.filter((paper) => !paper.categories.some((c) => otherIds.has(canonical(c))));
}

export async function buildPuzzle(day) {
  const rand = rngFrom(`arxiv-connections/${day}`);
  const candidates = shuffled(CATEGORIES, rand);

  const chosen = [];  // { category, pool }
  let announcedOn = null;
  let fetches = 0;

  for (const category of candidates) {
    if (chosen.length === GROUPS) break;
    if (fetches >= MAX_FEED_FETCHES) break;
    if (!compatible(category, chosen.map((c) => c.category))) continue;
    // Every group needs a fake, so a category without a compiled grammar can
    // never be used — skip it before spending a feed request on it.
    if (!(await hasGrammar(category.id))) continue;

    fetches++;
    let feed;
    try {
      feed = await fetchCategoryFeed(category.id);
    } catch (error) {
      console.warn(`[puzzle] skipping ${category.id}: ${error.message}`);
      continue;
    }
    announcedOn ??= feed.announcedOn;
    if (feed.papers.length < MIN_POOL) continue;

    // Tentatively add, then re-check every group under the new category set.
    const ids = new Set([...chosen.map((c) => c.category.id), category.id]);
    const candidatePool = trimPool(feed.papers, new Set([...ids].filter((i) => i !== category.id)));
    if (candidatePool.length < REAL_PER_GROUP) continue;

    const rescored = chosen.map((entry) => ({
      ...entry,
      pool: trimPool(entry.pool, new Set([...ids].filter((i) => i !== entry.category.id))),
    }));
    if (rescored.some((entry) => entry.pool.length < REAL_PER_GROUP)) continue;

    chosen.splice(0, chosen.length, ...rescored, { category, pool: candidatePool });
  }

  if (chosen.length < GROUPS) {
    throw new Error(`only found ${chosen.length}/${GROUPS} usable categories for ${day}`);
  }

  // Three real papers per category...
  const groups = shuffled(chosen, rand).map(({ category, pool }) => ({
    id: category.id,
    name: category.name,
    papers: shuffled(pool, rand).slice(0, REAL_PER_GROUP).map((paper) => ({
      id: paper.id,
      title: paper.title,
      url: paper.url,
      authors: paper.authors,
    })),
  }));

  // ...plus one impostor each, generated from that category's own grammar. The
  // fake is checked against every real title in the puzzle, not just its own
  // group, so it can't echo a neighbour.
  const realTitles = groups.flatMap((group) => group.papers.map((paper) => paper.title));
  for (const group of groups) {
    const fake = await makeFakeTitle(group.id, rand, realTitles);
    if (!fake) throw new Error(`could not generate a fake title for ${group.id} on ${day}`);
    realTitles.push(fake);
    // Position within the group is irrelevant — the grid order is shuffled —
    // but keep it last so the payload is not sorted by realness.
    group.papers.push({ title: fake, fake: true });
    group.papers = shuffled(group.papers, rand);
  }

  const order = shuffled([...Array(GROUPS * PER_GROUP).keys()], rand);
  return {
    day,
    format: PUZZLE_FORMAT,
    announcedOn,
    generatedAt: new Date().toISOString(),
    groups,
    order,
  };
}

// --- caching -----------------------------------------------------------------

/**
 * Is a cached payload still playable by the current client?
 *
 * The version stamp catches format changes; the structural check catches a
 * truncated, hand-edited or half-written file. Anything that fails is treated
 * as a cache miss and rebuilt.
 */
export function isUsablePuzzle(puzzle) {
  return Boolean(
    puzzle
    && puzzle.format === PUZZLE_FORMAT
    && Array.isArray(puzzle.groups)
    && puzzle.groups.length === GROUPS
    && puzzle.groups.every((group) =>
      Array.isArray(group.papers)
      && group.papers.length === PER_GROUP
      && group.papers.filter((paper) => paper.fake).length === 1
      && group.papers.filter((paper) => !paper.fake && paper.url).length === PER_GROUP - 1)
    && Array.isArray(puzzle.order)
    && puzzle.order.length === GROUPS * PER_GROUP,
  );
}

export class PuzzleStore {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.inFlight = new Map();
  }

  #pathFor(day) {
    return path.join(this.cacheDir, `puzzle-${day}.json`);
  }

  async #readCached(day) {
    let puzzle;
    try {
      puzzle = JSON.parse(await readFile(this.#pathFor(day), 'utf8'));
    } catch {
      return null;
    }
    if (!isUsablePuzzle(puzzle)) {
      console.warn(`[puzzle] cached ${day} is stale or malformed — rebuilding`);
      return null;
    }
    return puzzle;
  }

  /**
   * Most recent *playable* cached puzzle of any day — used if arXiv is
   * unreachable. Walks backwards so a stale-format file does not shadow an
   * older one that the current client can still play.
   */
  async #readNewestCached() {
    let files;
    try {
      files = (await readdir(this.cacheDir))
        .filter((f) => /^puzzle-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort();
    } catch {
      return null;
    }
    for (const file of files.reverse()) {
      try {
        const puzzle = JSON.parse(await readFile(path.join(this.cacheDir, file), 'utf8'));
        if (isUsablePuzzle(puzzle)) return puzzle;
      } catch { /* skip unreadable files */ }
    }
    return null;
  }

  /**
   * Today's puzzle: served from the day's cache file if present, otherwise
   * built (once — concurrent callers share the same build) and written out.
   */
  async get(day = puzzleDayFor()) {
    const cached = await this.#readCached(day);
    if (cached) return cached;

    if (!this.inFlight.has(day)) {
      const build = (async () => {
        const puzzle = await buildPuzzle(day);
        await mkdir(this.cacheDir, { recursive: true });
        await writeFile(this.#pathFor(day), JSON.stringify(puzzle, null, 2));
        return puzzle;
      })().finally(() => this.inFlight.delete(day));
      this.inFlight.set(day, build);
    }

    try {
      return await this.inFlight.get(day);
    } catch (error) {
      const fallback = await this.#readNewestCached();
      if (fallback) {
        console.warn(`[puzzle] build failed for ${day}, serving ${fallback.day}: ${error.message}`);
        return { ...fallback, stale: true };
      }
      throw error;
    }
  }
}
