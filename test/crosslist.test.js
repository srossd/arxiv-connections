import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A category can announce plenty of papers and still be unusable in a
 * particular quartet, because the build drops papers that cross-list into any
 * of the other three. Planning ignored that and produced quartets the build
 * then refused, which took the live site down to yesterday's puzzle:
 *
 *   [puzzle] build failed for 2026-08-20, serving 2026-08-19:
 *            math-ph lost too many papers to cross-listing for 2026-08-20
 *
 * The stub here cross-lists, which the other suites' stub does not — that is
 * why they all passed while the real thing broke.
 */

// Everything cross-lists into this one, so pairing anything with it is fatal.
const MAGNET = 'math-ph';
const PER_FEED = 5;
let pubDate = 'Thu, 20 Aug 2026 00:00:00 -0400';
let empty = false;

/** Most of a category's papers also list MAGNET, so a quartet with it starves. */
const categoriesFor = (category, n) =>
  (category === MAGNET || n > 4 ? [category] : [category, MAGNET]);

const item = (category, n) => `
  <item>
    <title>Paper ${n} in ${category}</title>
    <link>https://arxiv.org/abs/2608.${String(n).padStart(5, '0')}</link>
    <guid isPermaLink="false">oai:arXiv.org:${category}.${n}v1</guid>
    ${categoriesFor(category, n).map((c) => `<category>${c}</category>`).join('')}
    <arxiv:announce_type>new</arxiv:announce_type>
    <dc:creator>Ada Lovelace</dc:creator>
  </item>`;

const server = http.createServer((req, res) => {
  const category = decodeURIComponent(req.url.replace(/^\//, ''));
  const items = empty ? '' : Array.from({ length: PER_FEED }, (_, i) => item(category, i + 1)).join('');
  res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
  res.end(`<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel><title>${category}</title><pubDate>${pubDate}</pubDate>${items}</channel>
</rss>`);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.ARXIV_FEED_BASE = `http://127.0.0.1:${server.address().port}/`;
process.env.ARXIV_LISTING_BASE = 'http://127.0.0.1:9/';
process.env.ARXIV_REQUEST_GAP_MS = '0';
const { buildPuzzle } = await import('../src/puzzle.js');
const { FeedCache } = await import('../src/feed-cache.js');

test('a plan never contains a quartet the build would refuse', async (t) => {
  const feedCache = new FeedCache(await mkdtemp(path.join(tmpdir(), 'axc-xlist-')));

  const first = await buildPuzzle('2026-08-20', { previous: [], feedCache });
  assert.equal(first.groups.length, 4);
  for (const group of first.groups) {
    assert.ok(group.papers.filter((p) => !p.fake).length === 3,
      `${group.id} should have three real papers`);
  }

  const plan = await feedCache.loadPlan('2026-08-20');
  assert.ok(plan.length >= 4, 'a plan was made');
  assert.ok(!plan.includes(MAGNET),
    `${MAGNET} starves every quartet it joins, so it must not be planned`);

  // Every planned quartet has to be buildable, not just the first.
  empty = true;                                  // drought: run off the saved feeds
  const run = [first];
  for (let index = 1; index < plan.length / 4; index++) {
    const day = `2026-08-${20 + index}`;
    const puzzle = await buildPuzzle(day, { previous: [...run].reverse(), feedCache });
    assert.equal(puzzle.planIndex, index);
    assert.equal(puzzle.groups.length, 4, `${day} built`);
    for (const group of puzzle.groups) {
      assert.equal(group.papers.filter((p) => !p.fake).length, 3,
        `${day} ${group.id} kept three real papers after trimming`);
    }
    run.push(puzzle);
    t.diagnostic(`${day}: ${puzzle.groups.map((g) => g.id).sort().join(', ')}`);
  }
  empty = false;
});

test('a paper never appears in two groups of the same puzzle', async () => {
  const feedCache = new FeedCache(await mkdtemp(path.join(tmpdir(), 'axc-xlist-')));
  pubDate = 'Fri, 28 Aug 2026 00:00:00 -0400';
  const puzzle = await buildPuzzle('2026-08-28', { previous: [], feedCache });

  const ids = puzzle.groups.flatMap((g) => g.papers.filter((p) => !p.fake).map((p) => p.id));
  assert.equal(new Set(ids).size, ids.length, 'no paper is in two groups');
});

test.after(() => server.close());
