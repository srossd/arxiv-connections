import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrammar, generateTitle, generateBestTitle } from '../src/grammar.js';

// A miniature corpus with a deliberately repetitive shape, so the induced
// templates and phrases are predictable.
const CORPUS = [
  'Spectral properties of neutron stars in binary systems',
  'Thermal properties of white dwarfs in globular clusters',
  'Magnetic properties of neutron stars in accretion discs',
  'Spectral analysis of white dwarfs in the solar neighbourhood',
  'Numerical simulation of stellar convection in massive stars',
  'Observational constraints on stellar convection in binary systems',
  'A new model of accretion discs in cataclysmic variables',
  'The formation of globular clusters in dwarf galaxies',
  'On the structure of neutron star crusts in strong fields',
  'Measurements of magnetic fields in accretion discs',
];

const seeded = (n = 1) => {
  let s = n;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
};

test('induction splits titles into templates and phrases', () => {
  const g = buildGrammar('test.CAT', CORPUS);
  const all = [...g.styles.title.templates, ...g.styles.sentence.templates];
  assert.ok(all.length > 0, 'should induce at least one template');
  // "{} of {} in {}" is the dominant shape in this corpus.
  const shapes = all.map(([json]) => JSON.parse(json).map((t) => (t === null ? '{}' : t)).join(' '));
  assert.ok(shapes.some((s) => s === '{} of {} in {}'), `expected "{} of {} in {}" among ${shapes.slice(0, 5)}`);
});

test('generated titles reuse the corpus vocabulary but are not corpus titles', () => {
  const g = buildGrammar('test.CAT', CORPUS);
  const rand = seeded(7);
  let produced = 0;
  for (let i = 0; i < 40; i++) {
    const title = generateTitle(g, rand, { avoid: CORPUS });
    if (!title) continue;
    produced++;
    assert.ok(!CORPUS.includes(title), `regurgitated a real title: ${title}`);
  }
  assert.ok(produced > 0, 'should produce at least one title');
});

test('a fake never closely paraphrases a title it was told to avoid', () => {
  const g = buildGrammar('test.CAT', CORPUS);
  const rand = seeded(11);
  const wordsOf = (s) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  for (let i = 0; i < 40; i++) {
    const title = generateTitle(g, rand, { avoid: CORPUS, maxOverlap: 0.7 });
    if (!title) continue;
    for (const real of CORPUS) {
      const a = wordsOf(title);
      const b = wordsOf(real);
      const shared = [...a].filter((w) => b.has(w)).length;
      assert.ok(shared / a.size <= 0.7, `"${title}" overlaps "${real}"`);
    }
  }
});

test('generation is deterministic for a given seed', () => {
  const g = buildGrammar('test.CAT', CORPUS);
  const a = generateBestTitle(g, seeded(99), { avoid: CORPUS, candidates: 30 });
  const b = generateBestTitle(g, seeded(99), { avoid: CORPUS, candidates: 30 });
  assert.equal(a, b);
});

test('math welded into a word survives instead of being severed', () => {
  const mathCorpus = [
    'On $p$-adic properties of modular forms over number fields',
    'The $L$-functions of elliptic curves over function fields',
    'A study of $p$-adic families of modular forms over global fields',
    'Congruences for $L$-functions of abelian varieties over number fields',
    'On $p$-adic heights of elliptic curves over local fields',
    'Bounds for $L$-functions of modular forms over local fields',
  ];
  const g = buildGrammar('test.MATH', mathCorpus);
  const rand = seeded(5);
  for (let i = 0; i < 40; i++) {
    const title = generateTitle(g, rand, { avoid: mathCorpus });
    if (!title) continue;
    assert.ok(!/(^|\s)-adic/.test(title), `severed math in: ${title}`);
    assert.ok(!/(^|\s)-functions/.test(title), `severed math in: ${title}`);
  }
});

test('junk fragments are kept out of slots', () => {
  const noisy = [
    'Observations of the Crab Nebula. I',
    'Observations of the Crab Nebula. II',
    'Spectroscopy of the Orion Nebula in the infrared',
    'Photometry of the Crab Nebula in the optical',
    'Spectroscopy of young stars in nearby clusters',
    'Photometry of young stars in distant clusters',
  ];
  const g = buildGrammar('test.NOISE', noisy);
  const rand = seeded(3);
  for (let i = 0; i < 40; i++) {
    const title = generateTitle(g, rand, { avoid: noisy });
    if (!title) continue;
    assert.ok(!/\b[IVX]+$/.test(title.trim()), `trailing part number in: ${title}`);
  }
});

test('a corpus too small to generalise yields no usable grammar rather than nonsense', () => {
  const g = buildGrammar('test.TINY', ['One short title here']);
  const total = g.styles.title.templates.length + g.styles.sentence.templates.length;
  assert.equal(total, 0);
  assert.equal(generateBestTitle(g, seeded(1), { candidates: 10 }), null);
});

test('a generated title is never a real title from the corpus', () => {
  const g = buildGrammar('test.CAT', CORPUS);
  assert.ok(g.titleHashes.length > 0, 'grammar should carry corpus hashes');
  const rand = seeded(23);
  const real = new Set(CORPUS.map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
  for (let i = 0; i < 200; i++) {
    const title = generateTitle(g, rand, { avoid: [] });  // no avoid list at all
    if (!title) continue;
    assert.ok(!real.has(title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()),
      `generated a real title: ${title}`);
  }
});
