import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MailLog, normalise, readUnsubscribe, unsubscribeLink } from '../src/mail-list.js';
import { plainTitle, renderAnnouncement } from '../src/mail-template.js';
import { categoryChances, chanceForPaper, formatPercent } from '../src/odds.js';

const SECRET = 'test-secret';
const SITE = 'https://arxiv-connections.fly.dev';
const freshLog = async () => new MailLog(await mkdtemp(path.join(tmpdir(), 'axc-mail-')));

const PAPER = {
  id: '2608.12994',
  title: 'Time-Domain Benchmark Solutions for $\\eta$-Bernstein Waves',
  url: 'https://arxiv.org/abs/2608.12994',
};
const GROUP = { id: 'physics.plasm-ph', name: 'Plasma Physics', poolSize: 21 };
const FROM = { name: 'Ross', address: 'ross@example.com', postalAddress: '1 Example St, Anytown' };

const render = (overrides = {}) => renderAnnouncement({
  paper: PAPER, group: GROUP, day: '2026-08-16', from: FROM,
  links: { site: SITE, unsubscribe: `${SITE}/unsubscribe?a=x&t=y` },
  ...overrides,
});

// --- the odds ---------------------------------------------------------------

test('every category has a chance of being drawn, and they are not uniform', () => {
  const chances = categoryChances();
  const values = [...chances.values()];
  assert.ok(values.every((v) => v > 0 && v < 1), 'all between 0 and 1');
  // Four of ninety-odd categories are drawn each day.
  const total = values.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 4) < 0.05, `expected the four picks to sum to ~4, got ${total}`);
  // A lone archive competes with nobody in its own archive, so it wins more often.
  assert.ok(chances.get('quant-ph') > chances.get('cs.CC'),
    'a singleton archive beats one of many cs categories');
});

test('a paper in a crowded category is longer odds than one in a quiet category', () => {
  const crowded = chanceForPaper('cs.LG', 96);
  const quiet = chanceForPaper('cs.LG', 5);
  assert.ok(quiet.probability > crowded.probability);
  assert.ok(crowded.oneIn > quiet.oneIn);
});

test('the odds are three-in-pool times the category chance', () => {
  const odds = chanceForPaper('physics.plasm-ph', 21);
  const expected = categoryChances().get('physics.plasm-ph') * (3 / 21);
  assert.ok(Math.abs(odds.probability - expected) < 1e-12);
  assert.equal(odds.oneIn, Math.round(1 / expected));
});

test('a category smaller than a group cannot exceed certainty', () => {
  const odds = chanceForPaper('hep-th', 2);   // fewer papers than a group needs
  assert.ok(odds.probability <= 1);
});

test('percentages keep a significant figure however small', () => {
  assert.equal(formatPercent(23.4), '23%');
  assert.equal(formatPercent(4.27), '4.3%');
  assert.equal(formatPercent(0.61), '0.61%');
});

// --- the message ------------------------------------------------------------

test('LaTeX is stripped from the title', () => {
  assert.equal(plainTitle(PAPER.title), 'Time-Domain Benchmark Solutions for -Bernstein Waves');
  assert.equal(plainTitle('The $L^2$ metric for {hyperbolic} monopoles'),
    'The L^2 metric for hyperbolic monopoles');
});

test('the message names the paper, the odds and the game', () => {
  const { subject, text, html } = render();
  assert.match(subject, /arXiv Connections/);
  assert.match(text, /Time-Domain Benchmark Solutions/);
  assert.match(text, /one of only 12 papers/);
  // Three of the category's papers make it in, not twelve.
  assert.match(text, /three of its 21 papers/);
  assert.match(text, /Plasma Physics \(physics\.plasm-ph\) was one of the four categories/);
  assert.match(text, /1 in \d+/);
  assert.ok(!/12 papers drawn from the 21/.test(text), 'must not imply 12 came from one category');
  assert.ok(text.includes(SITE), 'links to the game');
  assert.match(html, /Play today's arXiv Connections/);
});

test('the message says why it arrived and how to stop', () => {
  const { text, html } = render();
  assert.match(text, /receiving this once/);
  assert.match(text, /lists this address for/);
  assert.ok(text.includes('/unsubscribe?a=x&t=y'), 'carries the opt-out link');
  assert.ok(text.includes(FROM.postalAddress), 'carries a postal address');
  assert.ok(html.includes(FROM.postalAddress));
});

test('a title with markup cannot inject HTML', () => {
  const { html } = render({
    paper: { ...PAPER, title: '<script>alert(1)</script> & "quoted"' },
  });
  assert.ok(!html.includes('<script>'), 'escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;'));
});

test('an unknown pool size still produces a sendable message', () => {
  const { text, odds } = render({ group: { ...GROUP, poolSize: undefined } });
  assert.equal(odds, null);
  assert.match(text, /one of only 12 papers/);
  assert.ok(!/NaN|undefined/.test(text));
});

// --- who may be written to --------------------------------------------------

test('an address is written to once, ever', async () => {
  const log = await freshLog();
  assert.equal((await log.mayContact('Alice@Uni.EDU')).ok, true);
  await log.markSent('Alice@Uni.EDU');

  const second = await log.mayContact('alice@uni.edu');   // same person, typed differently
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already written to');
});

test('opting out blocks a first contact too', async () => {
  const log = await freshLog();
  await log.suppress('bob@uni.edu');
  const decision = await log.mayContact('bob@uni.edu');
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'opted out');
});

test('the lists survive a restart and hold no addresses in the clear', async () => {
  const log = await freshLog();
  await log.markSent('carol@uni.edu');
  await log.suppress('dave@uni.edu');

  const reopened = new MailLog(log.dir);
  assert.equal((await reopened.mayContact('carol@uni.edu')).ok, false);
  assert.equal((await reopened.mayContact('dave@uni.edu')).ok, false);
  assert.deepEqual(await reopened.counts(), { sent: 1, suppressed: 1 });

  const onDisk = await readFile(path.join(log.dir, 'sent.json'), 'utf8');
  assert.ok(!onDisk.includes('carol'), 'the address itself is not stored');
});

test('a malformed address is never contacted', async () => {
  const log = await freshLog();
  for (const bad of ['not-an-address', 'a@b', '', 'two@@at.com']) {
    assert.equal((await log.mayContact(bad)).ok, false, `should refuse ${bad}`);
  }
});

// --- the opt-out link -------------------------------------------------------

test('an opt-out link round-trips', () => {
  const link = unsubscribeLink(SITE, 'Eve@Uni.EDU', SECRET);
  const { searchParams } = new URL(link);
  const recovered = readUnsubscribe(
    { a: searchParams.get('a'), t: searchParams.get('t') }, SECRET);
  assert.equal(recovered, 'eve@uni.edu', 'normalised on the way back');
});

test('an opt-out link cannot be forged or replayed for someone else', () => {
  const link = new URL(unsubscribeLink(SITE, 'eve@uni.edu', SECRET));
  const signature = link.searchParams.get('t');

  const other = Buffer.from('victim@uni.edu').toString('base64url');
  assert.equal(readUnsubscribe({ a: other, t: signature }, SECRET), null,
    'someone else\'s address with this signature');
  assert.equal(readUnsubscribe({ a: link.searchParams.get('a'), t: 'wrong' }, SECRET), null);
  assert.equal(readUnsubscribe({ a: link.searchParams.get('a'), t: signature }, 'other-secret'), null);
  assert.equal(readUnsubscribe({ a: null, t: null }, SECRET), null);
  assert.equal(readUnsubscribe({ a: Buffer.from('nonsense').toString('base64url'), t: signature }, SECRET), null);
});

test('normalising is what makes "written to once" hold', () => {
  assert.equal(normalise('  Alice@Uni.EDU '), 'alice@uni.edu');
});
