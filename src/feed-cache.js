import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Keeps the last usable copy of each category's feed on disk.
 *
 * The weekend handling assumes arXiv keeps serving the previous mailing on days
 * it does not announce. If it ever serves an empty feed instead — or is simply
 * unreachable — there would be nothing to build a puzzle from, and the game
 * would fall back to repeating an old puzzle wholesale. With a saved copy it can
 * still assemble a fresh game from the last real mailing.
 *
 * The parsed feed is stored rather than the raw XML: it is what the builder
 * consumes, it is a fraction of the size, and it cannot re-introduce a parsing
 * bug on the fallback path.
 */

const MAX_AGE_DAYS = 7;

/** Category ids are filename-safe already, but do not trust that blindly. */
const fileFor = (dir, categoryId) =>
  path.join(dir, `feed-${categoryId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

export class FeedCache {
  constructor(dir, { maxAgeDays = MAX_AGE_DAYS } = {}) {
    this.dir = dir;
    this.maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  }

  /**
   * Stores a feed that actually had papers in it. An empty or failed fetch must
   * never overwrite a good copy — that is the whole point of keeping one.
   */
  async save(categoryId, feed) {
    if (!feed?.papers?.length) return false;
    try {
      await mkdir(this.dir, { recursive: true });
      const target = fileFor(this.dir, categoryId);
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({
        category: categoryId,
        savedAt: new Date().toISOString(),
        announcedOn: feed.announcedOn,
        papers: feed.papers,
      }));
      await rename(temp, target);
      return true;
    } catch (error) {
      console.warn(`[feeds] could not save ${categoryId}: ${error.message}`);
      return false;
    }
  }

  /**
   * The last saved copy, or null when there is none or it has gone stale.
   * A months-old feed would quietly present ancient papers as today's.
   */
  async load(categoryId, now = Date.now()) {
    let saved;
    try {
      saved = JSON.parse(await readFile(fileFor(this.dir, categoryId), 'utf8'));
    } catch {
      return null;
    }
    if (!Array.isArray(saved?.papers) || saved.papers.length === 0) return null;

    const age = now - new Date(saved.savedAt ?? 0).getTime();
    if (!Number.isFinite(age) || age > this.maxAgeMs) return null;

    return { announcedOn: saved.announcedOn, papers: saved.papers, savedAt: saved.savedAt };
  }

  /**
   * The category order chosen for a mailing: five compatible quartets, used one
   * per day for as long as arXiv keeps serving that same mailing.
   */
  async savePlan(mailingDay, categories) {
    try {
      await mkdir(this.dir, { recursive: true });
      const target = path.join(this.dir, `plan-${mailingDay}.json`);
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ mailingDay, categories, savedAt: new Date().toISOString() }));
      await rename(temp, target);
      return true;
    } catch (error) {
      console.warn(`[feeds] could not save the plan for ${mailingDay}: ${error.message}`);
      return false;
    }
  }

  async loadPlan(mailingDay) {
    try {
      const saved = JSON.parse(await readFile(path.join(this.dir, `plan-${mailingDay}.json`), 'utf8'));
      return Array.isArray(saved?.categories) && saved.categories.length ? saved.categories : null;
    } catch {
      return null;
    }
  }

  /** Is there a usable copy for this category? */
  async has(categoryId, now = Date.now()) {
    return (await this.load(categoryId, now)) !== null;
  }
}

/**
 * Fetches a category feed, falling back to the last saved copy when the live one
 * is empty or unreachable. Returns the feed plus whether it came from disk.
 */
export async function fetchFeedWithFallback(categoryId, fetchFeed, cache) {
  const useCached = async (reason) => {
    if (!cache) return null;
    const cached = await cache.load(categoryId);
    if (!cached) return null;
    console.warn(`[feeds] ${categoryId}: ${reason}; using the copy saved ${cached.savedAt}`);
    return { ...cached, fromCache: true };
  };

  let live;
  try {
    live = await fetchFeed(categoryId);
  } catch (error) {
    const fallback = await useCached(`fetch failed (${error.message})`);
    if (fallback) return fallback;
    throw error;
  }

  if (live.papers.length > 0) {
    if (cache) await cache.save(categoryId, live);
    return { ...live, fromCache: false };
  }
  return (await useCached('feed came back empty')) ?? { ...live, fromCache: false };
}
