import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CATEGORIES, compatible } from './categories.js';
import { fetchCategoryFeed, fetchCategoryListing, canonical } from './arxiv.js';
import { hasGrammar, makeFakeTitle } from './fakes.js';
import { FeedCache, fetchFeedWithFallback } from './feed-cache.js';

const ROLLOVER_HOUR = 2;              // new puzzle at 2am US Eastern
const TIME_ZONE = 'America/New_York';
const GROUPS = 4;                     // categories per puzzle
const PER_GROUP = 4;                  // tiles per category
const REAL_PER_GROUP = 3;             // ...of which three are real papers
const MIN_POOL = REAL_PER_GROUP;      // a category needs at least its three real papers
const MAX_FEED_FETCHES = 60;          // hard cap on feeds pulled per build
const PLAN_DAYS = 5;                  // quartets per mailing: today plus four drought days

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

/**
 * The date arXiv labelled a mailing with, e.g. "Fri, 14 Aug 2026 00:00:00 -0400"
 * -> "2026-08-14". Two puzzles built from the same mailing share this, which is
 * how a day with no fresh announcement is recognised.
 */
export function mailingDayOf(pubDate) {
  const parsed = new Date(pubDate ?? '');
  return Number.isNaN(parsed.getTime()) ? null : dayFormatter.format(parsed);
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

/**
 * Chooses the category order for one mailing: `PLAN_DAYS` quartets, twenty
 * categories in all, taken from a seeded permutation and kept only if the
 * category actually announced enough papers to fill a group.
 *
 * A day then uses its quartet by position — the first four today, the next four
 * if tomorrow brings no announcement, and so on. Positional quartets are what
 * make the guarantee hold: picking greedily from a pool of twenty can strand an
 * incompatible remainder, and measured over forty seeds that delivered five
 * days only 43% of the time.
 *
 * Each quartet is internally compatible (four different archives, no confusable
 * pair), because that is what makes a puzzle fair to play.
 *
 * Every feed fetched along the way is saved, so the whole plan is playable from
 * disk once arXiv stops answering.
 */
export async function buildPlan(mailingDay, { rand, feedCache, days = PLAN_DAYS, exclude = [] }) {
  const skip = new Set(exclude);
  const pool = shuffled(CATEGORIES, rand);
  const quartets = [];
  let quartet = [];
  let fetches = 0;

  for (const category of pool) {
    if (quartets.length === days) break;
    if (fetches >= MAX_FEED_FETCHES) break;
    if (skip.has(category.id)) continue;
    if (!compatible(category, quartet)) continue;
    if (!(await hasGrammar(category.id))) continue;

    let feed;
    try {
      fetches++;
      feed = await fetchFeedWithFallback(
        category.id, fetchCategoryFeed, feedCache, fetchCategoryListing);
    } catch (error) {
      console.warn(`[puzzle] skipping ${category.id}: ${error.message}`);
      continue;
    }
    if (feed.papers.length < MIN_POOL) continue;   // too thin to fill a group

    quartet.push(category);
    if (quartet.length === GROUPS) {
      quartets.push(quartet);
      quartet = [];
    }
  }

  const plan = quartets.flat().map((c) => c.id);
  console.log(`[puzzle] plan for mailing ${mailingDay}: ${quartets.length} days `
    + `(${plan.length} categories, ${fetches} feeds fetched)`);
  if (feedCache) await feedCache.savePlan(mailingDay, plan);
  return plan;
}

export async function buildPuzzle(day, { previous = [], feedCache = null } = {}) {
  const rand = rngFrom(`arxiv-connections/${day}`);
  const candidates = shuffled(CATEGORIES, rand);

  let announcedOn = null;
  let mailingDay = null;
  let usedSavedFeeds = false;
  let fetches = 0;

  const feeds = new Map();
  const feedFor = async (categoryId) => {
    if (!feeds.has(categoryId)) {
      fetches++;
      const feed = await fetchFeedWithFallback(
        categoryId, fetchCategoryFeed, feedCache, fetchCategoryListing);
      if (feed.fromCache) usedSavedFeeds = true;
      // Date the mailing by a feed that actually has papers in it. An empty
      // response still carries a pubDate, and trusting it would label the
      // puzzle with a day nothing was announced on.
      if (feed.papers.length > 0) {
        announcedOn ??= feed.announcedOn;
        mailingDay ??= mailingDayOf(feed.announcedOn);
      }
      feeds.set(categoryId, feed);
    }
    return feeds.get(categoryId);
  };

  // Probe until a feed with papers in it turns up. That settles the mailing
  // date — and therefore whether this is a new announcement — and, if arXiv is
  // answering with nothing, that only saved copies can be used.
  let liveIsEmpty = false;
  for (const category of candidates) {
    if (fetches >= MAX_FEED_FETCHES) break;
    if (!(await hasGrammar(category.id))) continue;
    if (liveIsEmpty && !(await feedCache?.has(category.id))) continue;

    let feed;
    try {
      feed = await feedFor(category.id);
    } catch (error) {
      console.warn(`[puzzle] skipping ${category.id}: ${error.message}`);
      continue;
    }
    if (feed.papers.length > 0) break;   // the mailing is known
    liveIsEmpty = true;                  // arXiv answered, with nothing in it
  }
  if (!mailingDay) throw new Error(`no usable feed for ${day}`);

  // A puzzle already built from this mailing means arXiv has not announced
  // since; this day takes the next quartet of that mailing's plan.
  const prior = previous.find((p) => p.mailingDay === mailingDay);
  const planIndex = prior ? (prior.planIndex ?? 0) + 1 : 0;

  let plan = prior ? await feedCache?.loadPlan(mailingDay) : null;
  let planOffset = 0;
  if (!plan) {
    // A fresh mailing, or a plan we no longer hold. Rebuilding one mid-run must
    // not hand back a category the run has already used, so those are excluded
    // and this day takes the plan's first quartet.
    const alreadyUsed = previous
      .filter((p) => p.mailingDay === mailingDay)
      .flatMap((p) => p.groups.map((g) => g.id));
    plan = await buildPlan(mailingDay, {
      rand: rngFrom(`arxiv-connections/plan/${mailingDay}`),
      feedCache,
      exclude: alreadyUsed,
      days: Math.max(1, PLAN_DAYS - planIndex),
    });
    planOffset = planIndex;   // the plan starts where this day does
  }

  const slot = planIndex - planOffset;
  const wanted = plan.slice(slot * GROUPS, slot * GROUPS + GROUPS);
  if (wanted.length < GROUPS) {
    throw new Error(`mailing ${mailingDay} has no day ${planIndex + 1} left in its plan `
      + `(${plan.length / GROUPS + planOffset} days planned) for ${day}`);
  }
  if (planIndex > 0) {
    console.log(`[puzzle] ${day}: no fresh mailing (still ${mailingDay}); `
      + `using plan day ${planIndex + 1}: ${wanted.join(', ')}`);
  }

  const byId = new Map(CATEGORIES.map((c) => [c.id, c]));
  const chosen = [];
  for (const id of wanted) {
    const feed = await feedFor(id);
    if (feed.papers.length < MIN_POOL) {
      throw new Error(`planned category ${id} has only ${feed.papers.length} papers for ${day}`);
    }
    chosen.push({ category: byId.get(id), pool: feed.papers });
  }

  // A paper cross-listed to another chosen category would belong to two groups
  // at once, so trim each pool against the rest of the quartet.
  const ids = new Set(wanted);
  for (const entry of chosen) {
    entry.pool = trimPool(entry.pool, new Set([...ids].filter((i) => i !== entry.category.id)));
    if (entry.pool.length < REAL_PER_GROUP) {
      throw new Error(`${entry.category.id} lost too many papers to cross-listing for ${day}`);
    }
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
    mailingDay,
    // What the header shows. Clamped to the puzzle day so it never runs ahead:
    // arXiv relabels the feed at midnight Eastern while the game rolls over at
    // 2am, and in that window the mailing is already dated tomorrow.
    announcedDay: mailingDay && mailingDay < day ? mailingDay : day,
    freshMailing: !previous.some((p) => p.mailingDay === mailingDay),
    // True when arXiv gave us nothing and a saved copy stood in.
    usedSavedFeeds,
    // Which quartet of the mailing's plan this day used; the next day of a
    // drought takes the one after.
    planIndex,
    planDays: plan.length / GROUPS + planOffset,
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
  constructor(cacheDir, { feedCacheDir = path.join(cacheDir, 'feeds') } = {}) {
    this.cacheDir = cacheDir;
    this.inFlight = new Map();
    // Lives beside the puzzles, so whatever makes those persist covers it too.
    this.feedCache = new FeedCache(feedCacheDir);
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

  /** Cached day files, newest first. */
  async #cachedDays() {
    try {
      return (await readdir(this.cacheDir))
        .filter((f) => /^puzzle-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * The puzzles immediately before `day`, newest first, so a build can tell
   * whether today's mailing is new and which categories the run already used.
   */
  async #recentBefore(day, limit = 6) {
    const out = [];
    for (const file of await this.#cachedDays()) {
      if (file >= `puzzle-${day}.json`) continue;
      try {
        out.push(JSON.parse(await readFile(path.join(this.cacheDir, file), 'utf8')));
      } catch { /* skip unreadable files */ }
      if (out.length === limit) break;
    }
    return out;
  }

  /**
   * Most recent *playable* cached puzzle of any day — used if arXiv is
   * unreachable. Walks backwards so a stale-format file does not shadow an
   * older one that the current client can still play.
   */
  async #readNewestCached() {
    for (const file of await this.#cachedDays()) {
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
        const puzzle = await buildPuzzle(day, {
          previous: await this.#recentBefore(day),
          feedCache: this.feedCache,
        });
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
