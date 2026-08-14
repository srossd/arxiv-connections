#!/usr/bin/env node
/**
 * One-time corpus build: harvest historical paper titles per arXiv category.
 *
 *   node scripts/harvest-corpus.js              # every category in the pool
 *   node scripts/harvest-corpus.js hep-th cs.SD # just these
 *
 * Uses arXiv's OAI-PMH interface, which exposes a set per subject class
 * (cs.SD -> cs:cs:SD), so each category is harvested directly rather than by
 * sweeping a whole archive. Titles land in data/corpus/<category>.json.
 *
 * Re-running is cheap: a category already at its target is skipped, so an
 * interrupted harvest can simply be restarted.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CATEGORIES } from '../src/categories.js';
import { cleanTitle, canonical } from '../src/arxiv.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORPUS_DIR = path.join(ROOT, 'data', 'corpus');
const OAI = 'https://export.arxiv.org/oai2';
const UA = 'arxiv-connections/1.0 (one-time corpus build; +https://arxiv.org)';
const TARGET = Number(process.env.CORPUS_TARGET ?? 4000);
const GAP_MS = Number(process.env.CORPUS_GAP_MS ?? 3000);

// arXiv groups its OAI sets by top-level group, then archive, then class.
const GROUP_OF = {
  'astro-ph': 'physics', 'cond-mat': 'physics', 'gr-qc': 'physics',
  'hep-ex': 'physics', 'hep-lat': 'physics', 'hep-ph': 'physics',
  'hep-th': 'physics', 'math-ph': 'physics', nlin: 'physics',
  'nucl-ex': 'physics', 'nucl-th': 'physics', physics: 'physics',
  'quant-ph': 'physics',
  math: 'math', cs: 'cs', stat: 'stat', eess: 'eess',
  'q-bio': 'q-bio', 'q-fin': 'q-fin', econ: 'econ',
};

/** 'cs.SD' -> 'cs:cs:SD';  'hep-th' -> 'physics:hep-th' */
export function setSpecFor(categoryId) {
  const [archive, subclass] = categoryId.split('.');
  const group = GROUP_OF[archive];
  if (!group) throw new Error(`no OAI group known for ${categoryId}`);
  return subclass ? `${group}:${archive}:${subclass}` : `${group}:${archive}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oaiFetch(url, attempt = 1) {
  const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120_000) });
  // OAI-PMH uses 503 + Retry-After as its flow-control signal.
  if (response.status === 503 || response.status === 429) {
    const wait = Number(response.headers.get('retry-after') ?? 20);
    if (attempt > 6) throw new Error(`${url} still throttled after ${attempt} attempts`);
    console.log(`      throttled, waiting ${wait}s…`);
    await sleep(wait * 1000);
    return oaiFetch(url, attempt + 1);
  }
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.text();
}

const between = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
};

const unescapeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

/**
 * Titles whose PRIMARY category is `categoryId` — the same rule the game uses.
 *
 * OAI reports whichever alias the author filed under (stat.TH papers come back
 * as math.ST), so both sides are canonicalised before comparing.
 */
function parseRecords(xml, categoryId) {
  const wanted = canonical(categoryId);
  const out = [];
  for (const [, record] of xml.matchAll(/<record>([\s\S]*?)<\/record>/g)) {
    const categories = (between(record, 'categories') ?? '').trim().split(/\s+/);
    if (canonical(categories[0]) !== wanted) continue;
    const rawTitle = between(record, 'title');
    if (!rawTitle) continue;
    const title = cleanTitle(unescapeXml(rawTitle).replace(/\s+/g, ' ').trim());
    if (title.length >= 20) out.push(title);
  }
  return out;
}

async function harvest(categoryId) {
  const file = path.join(CORPUS_DIR, `${categoryId}.json`);
  try {
    const existing = JSON.parse(await readFile(file, 'utf8'));
    if (existing.titles.length >= TARGET) {
      console.log(`  ${categoryId}: already have ${existing.titles.length}, skipping`);
      return existing.titles.length;
    }
  } catch { /* not harvested yet */ }

  const set = setSpecFor(categoryId);
  const seen = new Set();
  let url = `${OAI}?verb=ListRecords&metadataPrefix=arXiv&set=${encodeURIComponent(set)}`;
  let pages = 0;

  while (url && seen.size < TARGET) {
    const xml = await oaiFetch(url);
    pages++;
    for (const title of parseRecords(xml, categoryId)) seen.add(title);

    const token = (xml.match(/<resumptionToken[^>]*>([^<]+)</) ?? [])[1];
    process.stdout.write(`\r  ${categoryId}: ${seen.size} titles (${pages} pages)   `);
    if (!token) break;
    url = `${OAI}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`;
    await sleep(GAP_MS);
  }

  const titles = [...seen];
  await mkdir(CORPUS_DIR, { recursive: true });
  await writeFile(file, JSON.stringify({ category: categoryId, set, harvested: new Date().toISOString(), titles }, null, 1));
  console.log(`\r  ${categoryId}: ${titles.length} titles (${pages} pages) -> data/corpus/${categoryId}.json`);
  return titles.length;
}

export async function main(argv = process.argv.slice(2)) {
  const wanted = argv.length ? argv : CATEGORIES.map((c) => c.id);
  console.log(`Harvesting ${wanted.length} categories, target ${TARGET} titles each\n`);
  const thin = [];
  for (const id of wanted) {
    try {
      const n = await harvest(id);
      if (n < 500) thin.push(`${id} (${n})`);
    } catch (error) {
      console.error(`  ${id}: FAILED — ${error.message}`);
      thin.push(`${id} (failed)`);
    }
    await sleep(GAP_MS);
  }
  if (thin.length) console.log(`\nThin or failed corpora: ${thin.join(', ')}`);
}

// Only harvest when run as a script — importing this module (for setSpecFor,
// or from a test) must not kick off a multi-hour network job.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
