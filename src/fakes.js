import { readFile, access } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBestTitle } from './grammar.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GRAMMAR_DIR = process.env.ARXIV_GRAMMAR_DIR ?? path.join(ROOT, 'data', 'grammars');

const grammarPath = (category) => path.join(GRAMMAR_DIR, `${category}.json.gz`);

const loaded = new Map();   // category -> grammar
const present = new Map();  // category -> boolean

/** Does this category have a compiled grammar? Cached; used to gate selection. */
export async function hasGrammar(category) {
  if (!present.has(category)) {
    present.set(category, await access(grammarPath(category)).then(() => true, () => false));
  }
  return present.get(category);
}

export async function loadGrammar(category) {
  if (!loaded.has(category)) {
    const packed = await readFile(grammarPath(category));
    loaded.set(category, JSON.parse(gunzipSync(packed).toString('utf8')));
  }
  return loaded.get(category);
}

/**
 * One plausible fake title for `category`.
 *
 * `avoid` should be every real title in the puzzle: a fake that paraphrases a
 * real neighbour is both unfair and a giveaway. Returns null if the grammar
 * cannot produce a clean title, which the caller must treat as a reason to drop
 * the category rather than ship a short group.
 */
export async function makeFakeTitle(category, rand, avoid) {
  const grammar = await loadGrammar(category);
  return generateBestTitle(grammar, rand, { avoid, candidates: 150 });
}
