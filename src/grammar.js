/**
 * Induces a title grammar from a corpus, and generates fake titles from it.
 *
 * Scientific titles are overwhelmingly of the shape
 *
 *     NOUN-PHRASE  prep  NOUN-PHRASE  prep  NOUN-PHRASE
 *     "Nuclear level density | in | odd-mass nuclei | in the framework of | the projected shell model"
 *
 * so the chunking needs no part-of-speech tagger: split on a closed list of
 * function words and whatever survives between them is a noun phrase. Titles
 * become templates (function words kept literal, noun phrases replaced by
 * slots); generating means picking a template and refilling its slots from the
 * category's own phrases.
 *
 * The phrases carry the domain flavour verbatim ("Hauser-Feshbach statistical
 * models"), the template supplies the grammar, and the result reads exactly
 * like an arXiv title while describing nothing.
 */

// Closed-class words kept literal in a template. Everything else is content.
const FUNCTION_WORDS = new Set(`
a an the this that these those its their our his her
of in for with on to from by at via using under over between among through into
within without during after before against across toward towards about upon
beyond near per versus vs onto off out up down along around
and or but nor
is are was were be being been am do does did can may might must should would will
as than not no all any some both each every
`.trim().split(/\s+/));

// Kept as its own literal token so titles keep their punctuation shape.
const PUNCT = new Set([':', ',', ';', '?', '!', '--', '-', '(', ')', '[', ']', '.']);

const MATH_TOKEN = '@@MATH@@';

/**
 * Splits a title into tokens.
 *
 * Math needs two different treatments. Standalone math ("... on $T^2$") is a
 * refillable slot. Math welded into a word ("$p$-adic", "$L$-functions") is
 * part of the phrase and must survive verbatim — masking it into a separate
 * token is what produces wreckage like "-adic exponential sums".
 */
function tokenize(title) {
  const tokens = [];
  const mathSpans = [];
  const masked = title.replace(/\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\\])*\$/g, (span) => {
    mathSpans.push(span);
    return `@@M${mathSpans.length - 1}@@`;
  });
  const restore = (text) => text.replace(/@@M(\d+)@@/g, (_, i) => mathSpans[Number(i)]);

  for (const raw of masked.split(/\s+/)) {
    if (!raw) continue;
    if (/^@@M\d+@@$/.test(raw)) { tokens.push(MATH_TOKEN); continue; }
    // Peel leading/trailing punctuation into their own tokens.
    const [, lead, core, trail] = raw.match(/^([([]*)(.*?)([)\]:,;?!.]*)$/s);
    for (const ch of lead) tokens.push(ch);
    if (core) tokens.push(restore(core));
    for (const ch of trail) tokens.push(ch);
  }
  return { tokens, mathSpans };
}

const isFunctionToken = (t) => FUNCTION_WORDS.has(t.toLowerCase()) || PUNCT.has(t);

/** Title Case vs sentence case — mixing the two in one title reads as a tell. */
function caseStyle(title) {
  const words = title.split(/\s+/)
    .filter((w) => /^[A-Za-z]{4,}$/.test(w) && !FUNCTION_WORDS.has(w.toLowerCase()));
  if (words.length < 3) return 'sentence';
  const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;
  return capitalised / words.length >= 0.6 ? 'title' : 'sentence';
}

/**
 * Splits one title into a template plus the phrases that filled its slots.
 * The template is an array of literal tokens with `null` marking a slot.
 */
function parseTitle(title) {
  const { tokens, mathSpans } = tokenize(title);
  const template = [];
  const slots = [];
  let current = [];

  const flush = () => {
    if (current.length) {
      slots.push(current.join(' '));
      template.push(null);
      current = [];
    }
  };

  for (const token of tokens) {
    if (token === MATH_TOKEN) { flush(); template.push(MATH_TOKEN); continue; }
    if (isFunctionToken(token)) { flush(); template.push(token.toLowerCase()); continue; }
    current.push(token);
  }
  flush();
  return { template, slots, mathSpans };
}

/** The literal run immediately before a slot — "of the", "in", "" at the start. */
function contextBefore(template, slotIndex) {
  const words = [];
  for (let i = slotIndex - 1; i >= 0; i--) {
    const token = template[i];
    if (token === null || token === MATH_TOKEN || PUNCT.has(token)) break;
    words.unshift(token);
  }
  return words.join(' ');
}

/** The literal immediately after a slot, or '#end'. */
function contextAfter(template, slotIndex) {
  const token = template[slotIndex + 1];
  if (token === undefined) return '#end';
  if (token === null || token === MATH_TOKEN) return '#slot';
  return token;
}

/**
 * Conditioning a phrase on what comes *before and after* it is what stops
 * "Examining" — a phrase that only ever opens a title and takes a direct
 * object — from landing in "{} on {}" and reading as "Examining on …".
 * Generation backs off to before-only, then to the global pool.
 */
const CONTEXT_SEP = ' >> ';
const contextKey = (before, after) => `${before}${CONTEXT_SEP}${after}`;

// Fragments that are noise as a whole phrase: part numbers, initials, stray
// single short words. Multi-word phrases are always kept.
const JUNK_PHRASE = /^(?:[IVXLC]+|\d+|[A-Za-z]{1,3}|[^A-Za-z0-9]+)$/;

function usablePhrase(phrase) {
  if (/^[-\u2013\u2014]/.test(phrase)) return false;   // severed fragment
  const words = phrase.split(/\s+/);
  if (words.length > 1) return words.length <= 8;
  return !JUNK_PHRASE.test(phrase) && phrase.length >= 4;
}

/**
 * Recombining a category's own phrases can land exactly on a paper that really
 * exists — which would make the "fake" a real title. Storing a 32-bit hash per
 * corpus title (a few KB, versus a few hundred for the titles themselves) lets
 * generation reject those without shipping the corpus to the server.
 */
const normaliseTitle = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function hashTitle(title) {
  let h = 2166136261;
  const text = normaliseTitle(title);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const topN = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n);

/** Builds a grammar from a list of titles, kept separately per case style. */
export function buildGrammar(category, titles, {
  maxTemplates = 1500, maxPhrasesPerContext = 80, maxMath = 200,
} = {}) {
  const newStyle = () => ({
    templates: new Map(), phrases: new Map(), math: new Map(), lengths: [], count: 0,
  });
  const styles = { title: newStyle(), sentence: newStyle() };

  for (const title of titles) {
    const style = styles[caseStyle(title)];
    const { template, slots, mathSpans } = parseTitle(title);
    const slotCount = template.filter((t) => t === null).length;
    // A single-slot template is the whole title — it would hand back a real
    // one; past four slots the refilled result just rambles.
    if (slotCount < 2 || slotCount > 4 || template.length > 32) continue;
    // One junk fragment poisons every title built from this template's slots.
    if (!slots.every(usablePhrase)) continue;

    style.count++;
    style.lengths.push(title.length);
    bump(style.templates, JSON.stringify(template));

    let slotIndex = 0;
    for (let i = 0; i < template.length; i++) {
      if (template[i] !== null) continue;
      const key = contextKey(contextBefore(template, i), contextAfter(template, i));
      if (!style.phrases.has(key)) style.phrases.set(key, new Map());
      bump(style.phrases.get(key), slots[slotIndex]);
      slotIndex++;
    }
    for (const span of mathSpans) bump(style.math, span);
  }

  const pack = (style) => {
    const lengths = style.lengths.sort((a, b) => a - b);
    const pct = (p) => lengths[Math.floor(lengths.length * p)] ?? 0;

    // A four-slot template seen only once is usually an artefact of one odd
    // title; refilling it reliably rambles.
    const templates = [...style.templates].filter(([json, count]) => {
      const slots = JSON.parse(json).filter((t) => t === null).length;
      return slots <= 3 || count >= 2;
    });

    // Backoff index: same preceding literal, any following one.
    const byBefore = new Map();
    for (const [key, counts] of style.phrases) {
      const before = key.split(CONTEXT_SEP)[0];
      if (!byBefore.has(before)) byBefore.set(before, new Map());
      for (const [phrase, n] of counts) {
        byBefore.get(before).set(phrase, (byBefore.get(before).get(phrase) ?? 0) + n);
      }
    }

    return {
      count: style.count,
      minLength: pct(0.15),
      maxLength: pct(0.85),
      templates: topN(new Map(templates), maxTemplates),
      phrases: Object.fromEntries(
        [...style.phrases].map(([ctx, m]) => [ctx, topN(m, maxPhrasesPerContext)]),
      ),
      phrasesByBefore: Object.fromEntries(
        [...byBefore].map(([ctx, m]) => [ctx, topN(m, maxPhrasesPerContext * 2)]),
      ),
      math: topN(style.math, maxMath),
    };
  };

  return {
    category,
    corpusSize: titles.length,
    built: new Date().toISOString(),
    styles: { title: pack(styles.title), sentence: pack(styles.sentence) },
    titleHashes: [...new Set(titles.map(hashTitle))].sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------- generation

/** Weighted pick from [[value, weight], …], optionally rejecting some values. */
function weightedPick(entries, rand, reject) {
  const usable = reject ? entries.filter(([v]) => !reject(v)) : entries;
  if (!usable.length) return null;
  let total = 0;
  for (const [, weight] of usable) total += weight;
  let roll = rand() * total;
  for (const entry of usable) {
    roll -= entry[1];
    if (roll <= 0) return entry;
  }
  return usable[usable.length - 1];
}

const wordsOf = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

const hashSets = new WeakMap();
/** Lazily built, cached per grammar object. */
function realTitles(grammar) {
  if (!hashSets.has(grammar)) hashSets.set(grammar, new Set(grammar.titleHashes ?? []));
  return hashSets.get(grammar);
}

/** Fraction of `candidate`'s words that also appear in `real`. */
function overlap(candidate, real) {
  const a = new Set(wordsOf(candidate));
  const b = new Set(wordsOf(real));
  if (!a.size) return 1;
  let hits = 0;
  for (const word of a) if (b.has(word)) hits++;
  return hits / a.size;
}

/**
 * Generates one fake title, or null if the grammar could not produce a clean
 * one. `avoid` is the day's real titles: a fake must not paraphrase one.
 */
function generateCandidate(grammar, rand, { avoid = [], maxOverlap = 0.7, attempts = 80 } = {}) {
  const titleCount = grammar.styles.title.count;
  const sentenceCount = grammar.styles.sentence.count;
  const preferred = rand() < titleCount / Math.max(1, titleCount + sentenceCount) ? 'title' : 'sentence';
  const style = grammar.styles[preferred].templates.length
    ? grammar.styles[preferred]
    : grammar.styles[preferred === 'title' ? 'sentence' : 'title'];
  if (!style.templates.length) return null;

  const globalPhrases = Object.values(style.phrases).flat();

  for (let attempt = 0; attempt < attempts; attempt++) {
    const templatePick = weightedPick(style.templates, rand);
    const template = JSON.parse(templatePick[0]);
    const templateCount = templatePick[1];
    const used = new Set();
    const parts = [];
    const chosen = [];
    let ok = true;

    for (let i = 0; i < template.length; i++) {
      const token = template[i];

      if (token === MATH_TOKEN) {
        const span = weightedPick(style.math, rand);
        if (!span) { ok = false; break; }
        parts.push(span[0]);
        continue;
      }
      if (token !== null) { parts.push(token); continue; }

      const before = contextBefore(template, i);
      const exact = style.phrases[contextKey(before, contextAfter(template, i))];
      const looser = style.phrasesByBefore[before];
      const pool = exact?.length >= 6 ? exact
        : looser?.length >= 6 ? looser
        : globalPhrases;
      const picked = weightedPick(pool, rand, (p) => used.has(p.toLowerCase()));
      if (!picked) { ok = false; break; }
      const [phrase, phraseCount] = picked;
      used.add(phrase.toLowerCase());
      chosen.push({ phrase, count: phraseCount });
      parts.push(phrase);
    }
    if (!ok) continue;

    let title = parts.join(' ')
      .replace(/\s+([)\]:,;?!.])/g, '$1')
      .replace(/([([])\s+/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    title = title.charAt(0).toUpperCase() + title.slice(1);

    if (title.length < style.minLength || title.length > style.maxLength) continue;
    if (realTitles(grammar).has(hashTitle(title))) continue;   // it actually exists
    if (avoid.some((real) => overlap(title, real) > maxOverlap)) continue;
    // A word repeated across two different slots reads as a seam.
    const words = chosen.flatMap((c) => wordsOf(c.phrase).filter((w) => w.length > 4));
    if (new Set(words).size !== words.length) continue;
    return { title, templateCount, phrases: chosen, style };
  }
  return null;
}

/** A string-only wrapper; `generateBestTitle` is what the game uses. */
export function generateTitle(grammar, rand, options = {}) {
  return generateCandidate(grammar, rand, options)?.title ?? null;
}

/**
 * Plausibility score, computed from what generation actually chose rather than
 * by re-parsing the finished string.
 *
 * The dominant term is attestation: a title assembled from a well-used template
 * and phrases the field writes often reads as real, whereas a phrase seen once
 * in 5,000 titles is usually a fragment that only made sense in its original
 * sentence ("... and chased away").
 */
function scoreCandidate(candidate, style) {
  const { title, templateCount, phrases } = candidate;
  let score = 2 * Math.log2(1 + templateCount);

  for (const { phrase, count } of phrases) {
    score += Math.min(2.5, Math.log2(1 + count));       // attested phrasing
    const words = phrase.split(/\s+/).length;
    score += words >= 2 && words <= 5 ? 1.5 : words === 1 ? -1.5 : -0.5;
  }

  score += phrases.length === 2 ? 3 : phrases.length === 3 ? 2 : 0;

  const mid = (style.minLength + style.maxLength) / 2;
  const span = Math.max(1, style.maxLength - style.minLength);
  score -= (Math.abs(title.length - mid) / span) * 2;

  return score;
}

/** Generates many candidates and returns the highest-scoring one. */
export function generateBestTitle(grammar, rand, options = {}) {
  const { candidates = 120, shortlist = 6, ...rest } = options;
  const scored = [];
  const seen = new Set();

  for (let i = 0; i < candidates; i++) {
    const candidate = generateCandidate(grammar, rand, rest);
    if (!candidate || seen.has(candidate.title)) continue;
    seen.add(candidate.title);
    scored.push({ title: candidate.title, score: scoreCandidate(candidate, candidate.style) });
  }
  if (!scored.length) return null;

  // Taking the strict argmax collapses towards the single blandest, most
  // frequent construction the category has; drawing from the top few keeps the
  // quality while letting different days look different.
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, Math.min(shortlist, scored.length));
  return top[Math.floor(rand() * top.length)].title;
}
