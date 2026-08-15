import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Builds real puzzles against a stub arXiv, so a weekend can be simulated:
 * the same mailing served on consecutive days must still yield a fresh game.
 */

// The stub answers every category, so selection behaves as it does live.
let pubDate = 'Fri, 14 Aug 2026 00:00:00 -0400';
let itemsPerFeed = 9;      // set to 0 to simulate arXiv serving an empty feed

const item = (category, n) => `
  <item>
    <title>A study of thing number ${n} in ${category}</title>
    <link>https://arxiv.org/abs/2608.${String(n).padStart(5, '0')}</link>
    <guid isPermaLink="false">oai:arXiv.org:2608.${String(n).padStart(5, '0')}v1</guid>
    <category>${category}</category>
    <arxiv:announce_type>new</arxiv:announce_type>
    <dc:creator>Ada Lovelace, Alan Turing</dc:creator>
  </item>`;

const feedFor = (category) => `<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>${category} updates on arXiv.org</title>
    <pubDate>${pubDate}</pubDate>
    ${Array.from({ length: itemsPerFeed }, (_, i) => item(category, i + 1)).join('')}
  </channel>
</rss>`;

const server = http.createServer((req, res) => {
  const category = decodeURIComponent(req.url.replace(/^\//, ''));
  res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
  res.end(feedFor(category));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

process.env.ARXIV_FEED_BASE = `http://127.0.0.1:${port}/`;
process.env.ARXIV_REQUEST_GAP_MS = '0';
const { buildPuzzle } = await import('../src/puzzle.js');
const { FeedCache } = await import('../src/feed-cache.js');

const ids = (puzzle) => puzzle.groups.map((g) => g.id).sort();
const overlap = (a, b) => ids(a).filter((id) => ids(b).includes(id));

test('a weekend still produces a fresh game from the last mailing', async (t) => {
  // Friday: the mailing is new.
  const friday = await buildPuzzle('2026-08-14', { previous: [] });
  assert.equal(friday.mailingDay, '2026-08-14');
  assert.equal(friday.freshMailing, true);
  assert.equal(friday.announcedDay, '2026-08-14');
  assert.equal(friday.groups.length, 4);

  // Saturday: arXiv has not announced, so the feed still carries Friday's date.
  const saturday = await buildPuzzle('2026-08-15', { previous: [friday] });
  assert.equal(saturday.mailingDay, '2026-08-14', 'same mailing');
  assert.equal(saturday.freshMailing, false);
  assert.deepEqual(overlap(saturday, friday), [], 'must not reuse Friday\'s categories');
  assert.equal(saturday.groups.length, 4, 'still a full puzzle');
  assert.equal(saturday.announcedDay, '2026-08-14', 'header credits Friday, not Saturday');

  // Sunday: must differ from both earlier days of the run.
  const sunday = await buildPuzzle('2026-08-16', { previous: [saturday, friday] });
  assert.equal(sunday.freshMailing, false);
  assert.deepEqual(overlap(sunday, saturday), [], 'differs from Saturday');
  assert.deepEqual(overlap(sunday, friday), [], 'and from Friday');
  assert.equal(sunday.announcedDay, '2026-08-14');

  // And the papers themselves are different, not just the labels.
  const titlesOf = (p) => p.groups.flatMap((g) => g.papers.map((x) => x.title));
  const shared = titlesOf(sunday).filter((x) => titlesOf(friday).includes(x));
  assert.deepEqual(shared, [], 'no paper appears in two puzzles of the run');

  t.diagnostic(`fri ${ids(friday)} | sat ${ids(saturday)} | sun ${ids(sunday)}`);
});

test('a fresh mailing lifts the restriction', async () => {
  const before = await buildPuzzle('2026-08-16', { previous: [] });

  pubDate = 'Mon, 17 Aug 2026 00:00:00 -0400';       // arXiv announces again
  const monday = await buildPuzzle('2026-08-17', { previous: [before] });
  assert.equal(monday.mailingDay, '2026-08-17');
  assert.equal(monday.freshMailing, true);
  assert.equal(monday.announcedDay, '2026-08-17');
  // Nothing is excluded, so Monday is free to pick whatever the seed gives it.
  assert.equal(monday.groups.length, 4);
});

test('the header never claims a date later than the puzzle day', async () => {
  // Between midnight and 2am Eastern the feed is already dated tomorrow.
  pubDate = 'Wed, 19 Aug 2026 00:00:00 -0400';
  const puzzle = await buildPuzzle('2026-08-18', { previous: [] });
  assert.equal(puzzle.mailingDay, '2026-08-19');
  assert.equal(puzzle.announcedDay, '2026-08-18', 'clamped to the puzzle day');
});

test('one mailing carries five days, quartet by quartet, never repeating', async (t) => {
  const feedCache = new FeedCache(await mkdtemp(path.join(tmpdir(), 'axc-feeds-')));

  pubDate = 'Fri, 21 Aug 2026 00:00:00 -0400';
  itemsPerFeed = 9;
  const friday = await buildPuzzle('2026-08-21', { previous: [], feedCache });
  assert.equal(friday.planIndex, 0, 'the first four');
  assert.equal(friday.planDays, 5, 'five days planned');
  assert.equal(friday.usedSavedFeeds, false);

  const plan = await feedCache.loadPlan('2026-08-21');
  assert.equal(plan.length, 20, 'twenty categories saved for the mailing');
  assert.deepEqual(ids(friday), plan.slice(0, 4).sort(), 'today used the first quartet');

  // arXiv now answers with nothing at all, for days on end.
  itemsPerFeed = 0;
  const run = [friday];
  const seen = new Set(ids(friday));

  for (let index = 1; index < 5; index++) {
    const day = `2026-08-${21 + index}`;
    pubDate = `Sat, ${21 + index} Aug 2026 00:00:00 -0400`;
    const puzzle = await buildPuzzle(day, { previous: [...run].reverse(), feedCache });

    assert.equal(puzzle.usedSavedFeeds, true, `${day} ran on saved feeds`);
    assert.equal(puzzle.planIndex, index, `${day} took quartet ${index}`);
    assert.deepEqual(ids(puzzle), plan.slice(index * 4, index * 4 + 4).sort(),
      `${day} used its quartet by position`);
    assert.equal(puzzle.groups.length, 4, `${day} is a complete puzzle`);
    assert.equal(puzzle.mailingDay, '2026-08-21', `${day} is dated by the papers it used`);
    assert.equal(puzzle.announcedDay, '2026-08-21');
    for (const id of ids(puzzle)) {
      assert.ok(!seen.has(id), `${day} reused ${id}`);
      seen.add(id);
    }
    run.push(puzzle);
    t.diagnostic(`${day} (quartet ${index}): ${ids(puzzle)}`);
  }
  assert.equal(seen.size, 20, 'five days, twenty distinct categories');

  // A sixth day has nothing left, and will not repeat to fill the gap.
  pubDate = 'Wed, 26 Aug 2026 00:00:00 -0400';
  await assert.rejects(() => buildPuzzle('2026-08-26', { previous: [...run].reverse(), feedCache }),
    /no day 6 left in its plan/, 'declines rather than repeating');

  itemsPerFeed = 9;
});

test('every planned category has enough papers to fill a group', async () => {
  const feedCache = new FeedCache(await mkdtemp(path.join(tmpdir(), 'axc-feeds-')));
  pubDate = 'Fri, 04 Sep 2026 00:00:00 -0400';
  itemsPerFeed = 3;                       // exactly the three real papers a group needs
  const puzzle = await buildPuzzle('2026-09-04', { previous: [], feedCache });
  assert.equal(puzzle.planDays, 5, 'three papers is enough to qualify');
  assert.equal(puzzle.groups.every((g) => g.papers.length === 4), true);
  assert.equal(puzzle.groups.every((g) => g.papers.filter((p) => p.fake).length === 1), true);

  itemsPerFeed = 2;                       // one short
  const thin = await buildPuzzle('2026-09-05', { previous: [], feedCache: new FeedCache(await mkdtemp(path.join(tmpdir(), 'axc-feeds-'))) })
    .then(() => 'built', (error) => error.message);
  assert.match(thin, /no usable feed|no day|plan/, `two papers should not qualify: ${thin}`);
  itemsPerFeed = 9;
});

test.after(() => server.close());
