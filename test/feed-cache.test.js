import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FeedCache, fetchFeedWithFallback } from '../src/feed-cache.js';

const freshCache = async (options) => new FeedCache(await mkdtemp(path.join(tmpdir(), 'axc-feed-')), options);

const feed = (n, announcedOn = 'Fri, 14 Aug 2026 00:00:00 -0400') => ({
  announcedOn,
  papers: Array.from({ length: n }, (_, i) => ({
    id: `2608.0000${i}v1`, title: `Paper ${i}`, url: `https://arxiv.org/abs/2608.0000${i}`,
    authors: ['Ada Lovelace'], categories: ['hep-th'],
  })),
});

test('a saved feed comes back intact', async () => {
  const cache = await freshCache();
  assert.equal(await cache.save('hep-th', feed(9)), true);

  const loaded = await cache.load('hep-th');
  assert.equal(loaded.papers.length, 9);
  assert.equal(loaded.announcedOn, 'Fri, 14 Aug 2026 00:00:00 -0400');
  assert.ok(loaded.savedAt);
});

test('an empty feed never overwrites a good one', async () => {
  const cache = await freshCache();
  await cache.save('hep-th', feed(9));
  assert.equal(await cache.save('hep-th', feed(0)), false, 'refused');
  assert.equal((await cache.load('hep-th')).papers.length, 9, 'the good copy survives');
});

test('a missing category loads as null', async () => {
  const cache = await freshCache();
  assert.equal(await cache.load('never-seen'), null);
});

test('a copy older than the limit is not used', async () => {
  const cache = await freshCache({ maxAgeDays: 7 });
  await cache.save('hep-th', feed(9));

  const sixDays = Date.now() + 6 * 24 * 3600_000;
  const eightDays = Date.now() + 8 * 24 * 3600_000;
  assert.ok(await cache.load('hep-th', sixDays), 'six days old is still usable');
  assert.equal(await cache.load('hep-th', eightDays), null, 'eight days old is not');
});

test('category ids with dots are safe as filenames', async () => {
  const cache = await freshCache();
  await cache.save('cond-mat.mes-hall', feed(7));
  assert.equal((await cache.load('cond-mat.mes-hall')).papers.length, 7);
  const files = await readdir(cache.dir);
  assert.deepEqual(files, ['feed-cond-mat.mes-hall.json']);
});

// --- the fallback path itself ---

test('a live feed is used and saved', async () => {
  const cache = await freshCache();
  const result = await fetchFeedWithFallback('hep-th', async () => feed(9), cache);
  assert.equal(result.fromCache, false);
  assert.equal(result.papers.length, 9);
  assert.equal((await cache.load('hep-th')).papers.length, 9, 'and was written through');
});

test('an empty live feed falls back to the saved copy', async () => {
  const cache = await freshCache();
  await cache.save('hep-th', feed(9));

  const result = await fetchFeedWithFallback('hep-th',
    async () => feed(0, 'Sat, 15 Aug 2026 00:00:00 -0400'), cache);
  assert.equal(result.fromCache, true);
  assert.equal(result.papers.length, 9);
  assert.equal(result.announcedOn, 'Fri, 14 Aug 2026 00:00:00 -0400',
    'the mailing date comes from the papers, not the empty response');
});

test('a failed fetch falls back to the saved copy', async () => {
  const cache = await freshCache();
  await cache.save('hep-th', feed(9));

  const result = await fetchFeedWithFallback('hep-th', async () => {
    throw new Error('HTTP 503');
  }, cache);
  assert.equal(result.fromCache, true);
  assert.equal(result.papers.length, 9);
});

test('a failed fetch with nothing saved still throws', async () => {
  const cache = await freshCache();
  await assert.rejects(
    () => fetchFeedWithFallback('hep-th', async () => { throw new Error('HTTP 503'); }, cache),
    /HTTP 503/,
  );
});

test('an empty feed with nothing saved is passed through, not invented', async () => {
  const cache = await freshCache();
  const result = await fetchFeedWithFallback('hep-th', async () => feed(0), cache);
  assert.equal(result.papers.length, 0, 'the caller decides to skip this category');
  assert.equal(result.fromCache, false);
});

test('with no cache configured the live feed is simply returned', async () => {
  const result = await fetchFeedWithFallback('hep-th', async () => feed(4), null);
  assert.equal(result.papers.length, 4);
  assert.equal(result.fromCache, false);
});

// --- the listing page, which outranks a copy on disk ---

test('an empty feed prefers the listing page over a saved copy', async () => {
  const cache = await freshCache();
  await cache.save('hep-th', feed(9, 'Old, 01 Aug 2026 00:00:00 -0400'));

  const listed = feed(5, '2026-08-14T12:00:00Z');
  const result = await fetchFeedWithFallback('hep-th',
    async () => feed(0), cache, async () => listed);

  assert.equal(result.fromListing, true);
  assert.equal(result.fromCache, false);
  assert.equal(result.papers.length, 5);
  assert.equal(result.announcedOn, '2026-08-14T12:00:00Z');
  assert.equal((await cache.load('hep-th')).papers.length, 5, 'and refreshes the copy on disk');
});

test('an empty listing page falls through to the saved copy', async () => {
  const cache = await freshCache();
  await cache.save('hep-th', feed(9));
  const result = await fetchFeedWithFallback('hep-th',
    async () => feed(0), cache, async () => feed(0));
  assert.equal(result.fromCache, true);
  assert.equal(result.papers.length, 9);
});

test('a failing listing page falls through rather than throwing', async () => {
  const cache = await freshCache();
  await cache.save('hep-th', feed(9));
  const result = await fetchFeedWithFallback('hep-th',
    async () => feed(0), cache, async () => { throw new Error('HTTP 500'); });
  assert.equal(result.fromCache, true);
});

test('a healthy feed never bothers the listing page', async () => {
  let asked = false;
  const result = await fetchFeedWithFallback('hep-th', async () => feed(9), null,
    async () => { asked = true; return feed(5); });
  assert.equal(asked, false);
  assert.equal(result.papers.length, 9);
});
