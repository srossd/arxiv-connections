#!/usr/bin/env node
/**
 * Compiles harvested corpora into per-category title grammars.
 *
 *   node scripts/build-grammars.js            # every corpus in data/corpus
 *   node scripts/build-grammars.js hep-th     # just these
 *
 * Grammars are written gzipped to data/grammars/<category>.json.gz — they are
 * read once per category per day, so the decompression is free and it keeps the
 * whole set to a few MB instead of tens.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrammar, generateBestTitle } from '../src/grammar.js';
import { cleanTitle } from '../src/arxiv.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORPUS_DIR = path.join(ROOT, 'data', 'corpus');
const GRAMMAR_DIR = path.join(ROOT, 'data', 'grammars');

const MIN_CORPUS = 300;      // below this the grammar just parrots the corpus
const OPTIONS = { maxTemplates: 900, maxPhrasesPerContext: 60, maxMath: 150 };

const wanted = process.argv.slice(2);
const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.json'));
const categories = wanted.length ? wanted : files.map((f) => f.replace(/\.json$/, ''));

await mkdir(GRAMMAR_DIR, { recursive: true });

let built = 0;
const skipped = [];
let totalBytes = 0;

for (const category of categories) {
  let titles;
  try {
    ({ titles } = JSON.parse(await readFile(path.join(CORPUS_DIR, `${category}.json`), 'utf8')));
  } catch {
    skipped.push(`${category} (no corpus)`);
    continue;
  }
  if (titles.length < MIN_CORPUS) {
    skipped.push(`${category} (${titles.length} titles)`);
    continue;
  }

  // Corpora are cleaned at harvest time, but re-clean here so improvements to
  // cleanTitle apply without re-harvesting 400k titles.
  const grammar = buildGrammar(category, titles.map(cleanTitle), OPTIONS);
  const usable = grammar.styles.title.templates.length + grammar.styles.sentence.templates.length;
  if (usable < 50) {
    skipped.push(`${category} (only ${usable} templates)`);
    continue;
  }

  // Smoke-test: a grammar that cannot produce a title is worse than none.
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const sample = generateBestTitle(grammar, rand, { avoid: titles, candidates: 40 });
  if (!sample) {
    skipped.push(`${category} (generates nothing)`);
    continue;
  }

  const packed = gzipSync(Buffer.from(JSON.stringify(grammar)), { level: 9 });
  await writeFile(path.join(GRAMMAR_DIR, `${category}.json.gz`), packed);
  totalBytes += packed.length;
  built++;
  console.log(`${category.padEnd(20)} ${String(titles.length).padStart(5)} titles  `
    + `${String(usable).padStart(4)} templates  ${(packed.length / 1024).toFixed(0).padStart(4)}KB`);
  console.log(`${' '.repeat(20)} e.g. "${sample}"`);
}

console.log(`\n${built} grammars, ${(totalBytes / 1048576).toFixed(1)}MB total`);
if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`);
