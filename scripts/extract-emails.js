#!/usr/bin/env node
/**
 * Finds corresponding-author addresses for the real papers in a day's puzzle.
 *
 *   node scripts/extract-emails.js                  # today's twelve
 *   node scripts/extract-emails.js 2608.12994 …     # specific papers
 *   node scripts/extract-emails.js --json           # machine-readable
 *   node scripts/extract-emails.js --pdf-always     # consult the PDF as well
 *
 * Source is tried first: the LaTeX marks addresses up (\email, \thanks,
 * \correspondingauthor) in a way that says which author they belong to. The PDF
 * is the fallback — its mailto: link annotations, then its rendered text.
 *
 * Nothing is kept. Each paper goes to a temp directory that is removed before
 * the next is fetched, so no arXiv content is stored or served. Downloads use
 * export.arxiv.org, as the API terms ask, one every few seconds.
 *
 * The matching rules live in src/emails.js and are unit-tested against the
 * false positives a real run turned up.
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { documentFiles, harvest, pdfMailtoLinks, rank } from '../src/emails.js';

const run = promisify(execFile);
const EXPORT = 'https://export.arxiv.org';
const UA = 'arxiv-connections/1.0 (author contact for a daily puzzle; rossd97@gmail.com)';
const GAP_MS = Number(process.env.ARXIV_PAPER_GAP_MS ?? 3000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function download(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function addressesFor(id, { pdfAlways = false } = {}) {
  const found = new Map();
  const notes = [];
  const workDir = await mkdtemp(path.join(tmpdir(), 'axc-paper-'));

  try {
    try {
      const files = documentFiles(await download(`${EXPORT}/e-print/${id}`));
      for (const file of files) {
        // The file with \begin{document} is the paper itself; the rest are
        // includes, and are worth less when two addresses disagree.
        harvest(file.text, { source: 'tex', weight: file.isMain ? 3 : 2, found });
      }
      notes.push(files.length ? `source: ${files.length} document file(s)` : 'source: PDF-only submission');
    } catch (error) {
      notes.push(`source: ${error.message}`);
    }

    if (pdfAlways || found.size === 0) {
      await sleep(GAP_MS);
      try {
        const pdf = await download(`${EXPORT}/pdf/${id}`);
        const file = path.join(workDir, 'paper.pdf');
        await writeFile(file, pdf);

        // A mailto: link is nearly always the corresponding author.
        for (const address of pdfMailtoLinks(pdf)) {
          harvest(address, { source: 'pdf-link', weight: 4, found });
        }

        const textFile = path.join(workDir, 'paper.txt');
        await run('pdftotext', ['-q', '-f', '1', '-l', '2', file, textFile]);
        const text = (await readFile(textFile, 'utf8'))
          .replace(/-\r?\n/g, '')      // rejoin hyphenated line breaks
          .replace(/\r?\n/g, ' ');
        harvest(text, { source: 'pdf-text', weight: 1, found });
        notes.push('pdf: read');
      } catch (error) {
        notes.push(`pdf: ${error.message}`);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  return { id, addresses: rank(found), notes };
}

// --- entry point -------------------------------------------------------------

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const pdfAlways = args.includes('--pdf-always');
let ids = args.filter((a) => !a.startsWith('--'));
let labels = new Map();

if (!ids.length) {
  const site = process.env.PUZZLE_URL ?? 'https://arxiv-connections.fly.dev';
  const puzzle = await (await fetch(`${site}/api/puzzle`, { headers: { 'User-Agent': UA } })).json();
  const real = puzzle.groups.flatMap((group) =>
    group.papers.filter((p) => !p.fake).map((p) => ({ ...p, group: group.id })));
  ids = real.map((p) => p.id.replace(/v\d+$/, ''));
  labels = new Map(real.map((p) => [p.id.replace(/v\d+$/, ''), `${p.group}  ${p.title}`]));
  if (!asJson) console.error(`Puzzle for ${puzzle.day}: ${ids.length} real papers\n`);
}

const results = [];
for (const [index, id] of ids.entries()) {
  const result = { ...(await addressesFor(id, { pdfAlways })), label: labels.get(id) ?? '' };
  results.push(result);
  if (!asJson) {
    console.log(`${id}  ${result.label.slice(0, 76)}`);
    if (!result.addresses.length) console.log(`   (none found)  [${result.notes.join('; ')}]`);
    for (const a of result.addresses) {
      console.log(`   ${a.corresponding ? '*' : ' '} ${a.address.padEnd(42)} ${a.sources.join(',')}`);
    }
  }
  if (index < ids.length - 1) await sleep(GAP_MS);
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const withAny = results.filter((r) => r.addresses.length).length;
  const withMarked = results.filter((r) => r.addresses.some((a) => a.corresponding)).length;
  console.log(`\n${withAny}/${results.length} papers yielded an address, `
    + `${withMarked} with one marked corresponding. * = marked; first line is best guess.`);
}
