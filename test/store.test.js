import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point the fetcher at a host that cannot resolve, so every build fails.
process.env.ARXIV_FEED_BASE = 'http://127.0.0.1:9/';
// The listing page is a second source; stub it out too, or these tests
// would quietly reach the real arXiv.
process.env.ARXIV_LISTING_BASE = 'http://127.0.0.1:9/';
process.env.ARXIV_MAX_ATTEMPTS = '1';
process.env.ARXIV_REQUEST_GAP_MS = '0';
const { PuzzleStore, isUsablePuzzle } = await import('../src/puzzle.js');

/** A minimal payload in the current format: three real papers + one impostor. */
const seed = (day) => ({
  day, format: 2, announcedOn: `${day} 00:00:00 -0400`, generatedAt: new Date().toISOString(),
  groups: [0, 1, 2, 3].map((g) => ({
    id: `x.G${g}`, name: `Group ${g}`,
    papers: [
      ...[0, 1, 2].map((p) => ({ id: `${g}${p}`, title: `t${g}${p}`, url: 'u', authors: [] })),
      { title: `fake${g}`, fake: true },
    ],
  })),
  order: [...Array(16).keys()],
});

test('a cached day is served without touching the network', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'axc-'));
  await writeFile(path.join(dir, 'puzzle-2026-05-05.json'), JSON.stringify(seed('2026-05-05')));
  const puzzle = await new PuzzleStore(dir).get('2026-05-05');
  assert.equal(puzzle.day, '2026-05-05');
  assert.ok(!puzzle.stale);
});

test('when arXiv is unreachable, the newest cached puzzle is served as stale', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'axc-'));
  await writeFile(path.join(dir, 'puzzle-2026-05-04.json'), JSON.stringify(seed('2026-05-04')));
  await writeFile(path.join(dir, 'puzzle-2026-05-05.json'), JSON.stringify(seed('2026-05-05')));
  const puzzle = await new PuzzleStore(dir).get('2026-05-06');
  assert.equal(puzzle.day, '2026-05-05', 'should fall back to the newest cached day');
  assert.equal(puzzle.stale, true);
  const files = await readdir(dir);
  assert.equal(files.length, 2, 'a failed build must not write a cache file');
});

test('with an empty cache and no network, the error propagates', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'axc-'));
  await assert.rejects(() => new PuzzleStore(dir).get('2026-05-06'));
});

test('concurrent requests for the same day share one build', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'axc-'));
  await writeFile(path.join(dir, 'puzzle-2026-05-05.json'), JSON.stringify(seed('2026-05-05')));
  const store = new PuzzleStore(dir);
  const results = await Promise.all([store.get('2026-05-06'), store.get('2026-05-06'), store.get('2026-05-06')]);
  for (const r of results) assert.equal(r.day, '2026-05-05');
});

test('a cached puzzle from an older format is rejected, not served', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'axc-'));
  const stale = seed('2026-05-05');
  delete stale.format;                                   // pre-impostor payload
  for (const group of stale.groups) group.papers = group.papers.map((p) => ({ ...p, fake: false }));
  await writeFile(path.join(dir, 'puzzle-2026-05-05.json'), JSON.stringify(stale));

  // Network is stubbed to fail, so a rebuild cannot succeed — the point is that
  // the stale file is NOT handed back as if it were playable.
  await assert.rejects(() => new PuzzleStore(dir).get('2026-05-05'));
});

test('a stale-format file does not shadow an older playable one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'axc-'));
  const good = seed('2026-05-04');
  const stale = seed('2026-05-05');
  delete stale.format;
  await writeFile(path.join(dir, 'puzzle-2026-05-04.json'), JSON.stringify(good));
  await writeFile(path.join(dir, 'puzzle-2026-05-05.json'), JSON.stringify(stale));

  const puzzle = await new PuzzleStore(dir).get('2026-05-06');
  assert.equal(puzzle.day, '2026-05-04', 'should skip the newer unplayable file');
  assert.equal(puzzle.stale, true);
});

test('a group missing its impostor makes the whole payload unusable', () => {
  const puzzle = seed('2026-05-05');
  assert.equal(isUsablePuzzle(puzzle), true);

  const noFake = seed('2026-05-05');
  noFake.groups[2].papers = noFake.groups[2].papers.map((p) => ({ ...p, fake: false, url: 'u' }));
  assert.equal(isUsablePuzzle(noFake), false);

  const twoFakes = seed('2026-05-05');
  twoFakes.groups[1].papers[0].fake = true;
  assert.equal(isUsablePuzzle(twoFakes), false);
});
