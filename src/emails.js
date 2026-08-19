import { gunzipSync, inflateSync } from 'node:zlib';
import path from 'node:path';

/**
 * Pulling corresponding-author addresses out of an e-print.
 *
 * The hard part is not finding things shaped like an address — it is rejecting
 * the many things in a LaTeX bundle that are shaped like one but are not:
 * package maintainers' addresses in bundled .sty files, and TeX's own internals,
 * where `\csname ver@amsmath.sty\endcsname` reads as "ver@amsmath.styendcsname".
 */

export const EMAIL_PATTERN = String.raw`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`;

// Only the document itself. Bundled class and style files carry their
// maintainers' addresses, which are not the authors of the paper.
const DOCUMENT_FILE = /\.(tex|txt|bbl)$/i;

// A real address ends in a country code or one of these. TeX internals end in
// things like .sty, .clo, .substyle or .endcsname, which match neither.
const GENERIC_TLDS = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro',
  'eu', 'asia', 'io', 'ai', 'dev', 'app', 'xyz', 'me', 'tech', 'science', 'systems',
  'cloud', 'group', 'team', 'institute', 'university', 'academy', 'education', 'email',
]);

// Addresses that belong to the toolchain rather than to any author.
const TOOLING = [
  /@aptaracorp\.com$/i, /@superscript\.com$/i, /^revtex/i, /^texsupport@/i,
  /^latex-?bugs?@/i, /@ctan\.org$/i, /@latex-project\.org$/i, /^tex-?live@/i,
  /^support@.*\b(tex|latex)\b/i, /@sbcglobal\.net$/i, /^bugs?@/i, /^webmaster@/i,
  /^noreply@/i, /^no-reply@/i,
];

const FILE_EXTENSIONS = /\.(png|jpe?g|pdf|eps|ps|sty|cls|clo|def|cfg|fd|dtx|ins|bst|bib|aux|log|toc|out|tex)$/i;

/** Does this look like an address a person would actually receive mail at? */
export function isPlausibleAddress(address) {
  if (!new RegExp(`^${EMAIL_PATTERN}$`).test(address)) return false;
  if (FILE_EXTENSIONS.test(address)) return false;
  if (TOOLING.some((pattern) => pattern.test(address))) return false;

  const [local, domain] = address.split('@');
  if (!local || local.length > 64 || domain.length > 253) return false;
  // TeX control sequences run words together; real local parts do not.
  if (/(endcsname|substyle|csname|expandafter|bibdata)/i.test(address)) return false;

  const tld = domain.split('.').pop().toLowerCase();
  return tld.length === 2 || GENERIC_TLDS.has(tld);
}

/** Undo the ways an address gets written so it is not machine-readable. */
export function deobfuscate(text) {
  return text
    .replace(/\s*[([{]\s*(?:at|AT)\s*[)\]}]\s*/g, '@')
    .replace(/\s+(?:at|AT)\s+(?=[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g, '@')
    .replace(/\s*[([{]\s*(?:dot|DOT)\s*[)\]}]\s*/g, '.')
    .replace(/\s+(?:dot|DOT)\s+/g, '.')
    .replace(/\\(?:url|href|texttt|mailto)\s*\{/g, ' ')
    .replace(/[~]/g, ' ');
}

/**
 * `{alice,bob}@dept.edu` is shorthand for several authors at one institution.
 * Returns the expanded addresses.
 */
export function expandGroups(text) {
  const out = [];
  for (const [, names, domain] of text.matchAll(
    /\{\s*([A-Za-z0-9._%+\-]+(?:\s*,\s*[A-Za-z0-9._%+\-]+)+)\s*\}\s*@\s*([A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g)) {
    for (const name of names.split(/\s*,\s*/)) out.push(`${name}@${domain}`.toLowerCase());
  }
  return out;
}

const MARKED_CORRESPONDING =
  /(corresponding\s+author|to\s+whom\s+correspondence|electronic\s+address|\\email|\\thanks|\\correspondingauthor|e-?mail\s*[:=])/i;

/**
 * Collects addresses from one blob of text into `found`.
 * `weight` lets the caller say how much this source is worth — the main
 * document outranks a bibliography, which outranks the PDF's rendered text.
 */
export function harvest(text, { source, weight = 0, found = new Map() } = {}) {
  const clean = deobfuscate(text);

  // A cue only counts for the address it precedes. A fixed-width look-back let
  // `\thanks{Corresponding author: one@…}` also mark a later, unrelated
  // address, so the window stops at whichever address came before.
  let previousEnd = 0;
  const add = (raw, index) => {
    const address = raw.replace(/[.,;:)\]}]+$/, '').toLowerCase();
    const endsAt = index + raw.length;
    if (!isPlausibleAddress(address)) { previousEnd = Math.max(previousEnd, endsAt); return; }
    const context = clean.slice(Math.max(previousEnd, index - 160), index + 40);
    previousEnd = Math.max(previousEnd, endsAt);
    const marked = MARKED_CORRESPONDING.test(context);

    const entry = found.get(address)
      ?? { address, sources: new Set(), corresponding: false, score: 0 };
    entry.sources.add(source);
    if (marked) entry.corresponding = true;
    entry.score = Math.max(entry.score, weight + (marked ? 3 : 0));
    found.set(address, entry);
  };

  for (const match of clean.matchAll(new RegExp(EMAIL_PATTERN, 'g'))) add(match[0], match.index);
  for (const address of expandGroups(clean)) add(address, clean.indexOf(address.split('@')[0]));
  return found;
}

/** Ranked, most likely corresponding author first. */
export function rank(found) {
  return [...found.values()]
    .map((entry) => ({ ...entry, sources: [...entry.sources] }))
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
}

// --- unpacking an e-print ----------------------------------------------------

const isGzip = (buf) => buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
export const isPdf = (buf) => buf.slice(0, 5).toString('latin1') === '%PDF-';
const isTar = (buf) => buf.length > 262 && buf.slice(257, 262).toString('latin1') === 'ustar';

/** Minimal tar reader — arXiv source bundles are plain tar inside gzip. */
export function readTar(buf) {
  const files = [];
  for (let offset = 0; offset + 512 <= buf.length;) {
    const header = buf.slice(offset, offset + 512);
    const name = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(
      header.slice(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
    const start = offset + 512;
    if (header[156] === 0x30 || header[156] === 0) files.push({ name, body: buf.slice(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * The document files of an e-print bundle, main document first.
 * Class and style files are left out: they carry their maintainers' addresses.
 */
export function documentFiles(buf) {
  let body = buf;
  if (isGzip(body)) {
    try { body = gunzipSync(body); } catch { return []; }
  }
  if (isPdf(body)) return [];
  const files = isTar(body) ? readTar(body) : [{ name: 'main.tex', body }];

  return files
    .filter(({ name }) => DOCUMENT_FILE.test(name) || !path.extname(name))
    .map(({ name, body: content }) => ({ name, text: content.toString('utf8') }))
    .filter(({ text }) => /[A-Za-z]/.test(text))
    // The file with \begin{document} is the paper; the rest are includes.
    .map((file) => ({ ...file, isMain: /\\begin\s*\{document\}/.test(file.text) }))
    .sort((a, b) => Number(b.isMain) - Number(a.isMain));
}

/** mailto: targets in a PDF's link annotations, including compressed objects. */
export function pdfMailtoLinks(buf) {
  const latin = buf.toString('latin1');
  const chunks = [latin];
  for (const match of latin.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      chunks.push(inflateSync(buf.slice(start, end)).toString('latin1'));
    } catch { /* not a readable deflate stream */ }
  }
  const out = [];
  for (const chunk of chunks) {
    for (const match of chunk.matchAll(/mailto:([^)>\s\]]+)/gi)) {
      try { out.push(decodeURIComponent(match[1])); } catch { out.push(match[1]); }
    }
  }
  return out;
}
