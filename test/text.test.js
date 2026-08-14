import test from 'node:test';
import assert from 'node:assert/strict';
import { deTeX, cleanTitle, canonical } from '../src/arxiv.js';

test('deTeX folds TeX accents in author names', () => {
  assert.equal(deTeX(String.raw`Martin L\"udtke`), 'Martin Lüdtke');
  assert.equal(deTeX(String.raw`Fran\c{c}ois M\"uller`), 'François Müller');
  assert.equal(deTeX(String.raw`Erd\H{o}s P\'al`), 'Erdős Pál');
  assert.equal(deTeX(String.raw`Stanis{\l}aw Ulam`), 'Stanisław Ulam');
  assert.equal(deTeX('Plain Name'), 'Plain Name');
});

test('cleanTitle leaves math spans byte-for-byte', () => {
  const title = String.raw`Krylov complexity for $\eta$ deformed backgrounds`;
  assert.equal(cleanTitle(title), title);
  assert.equal(
    cleanTitle(String.raw`Macroscopic origin on $T^2 \times \Sigma_{\mathfrak{g}}$`),
    String.raw`Macroscopic origin on $T^2 \times \Sigma_{\mathfrak{g}}$`,
  );
});

test('cleanTitle folds TeX outside math but keeps the spaces around it', () => {
  assert.equal(
    cleanTitle(String.raw`Schr\"odinger operators on $\mathbb{R}^n$ with {BEC} phases`),
    'Schrödinger operators on $\\mathbb{R}^n$ with BEC phases',
  );
  assert.equal(
    cleanTitle(String.raw`Twist-Reconfigurable Moir\'e Crystals`),
    'Twist-Reconfigurable Moiré Crystals',
  );
});

test('alias categories collapse to one canonical id', () => {
  assert.equal(canonical('math.MP'), 'math-ph');
  assert.equal(canonical('math.IT'), 'cs.IT');
  assert.equal(canonical('hep-th'), 'hep-th');
});
