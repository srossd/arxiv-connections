import { CATEGORIES, compatible } from './categories.js';

/**
 * What were the chances a given paper made it into a day's puzzle?
 *
 *   P(paper) = P(its category is one of the four) x P(picked from that category)
 *
 * The second term is easy: three of however many the category announced. The
 * first is not uniform — a category only competes with others it is compatible
 * with, so a lone archive like quant-ph is picked more often than any single
 * cs.* category, which loses out whenever another cs.* is drawn first.
 * It is measured by running the selection many times rather than reasoned about.
 */

const REAL_PER_GROUP = 3;
const GROUPS = 4;
const TRIALS = 4000;

function seeded(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (Math.imul(h ^ (h >>> 16), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

let cached = null;

/** How often each category is among a day's four. Computed once. */
export function categoryChances(trials = TRIALS) {
  if (cached) return cached;
  const hits = new Map(CATEGORIES.map((c) => [c.id, 0]));
  for (let trial = 0; trial < trials; trial++) {
    const pool = shuffled(CATEGORIES, seeded(`odds/${trial}`));
    const quartet = [];
    for (const category of pool) {
      if (compatible(category, quartet)) quartet.push(category);
      if (quartet.length === GROUPS) break;
    }
    for (const category of quartet) hits.set(category.id, hits.get(category.id) + 1);
  }
  cached = new Map([...hits].map(([id, n]) => [id, n / trials]));
  return cached;
}

/**
 * The chance a specific paper was chosen, given the category it was announced
 * in and how many papers that category announced that day.
 */
export function chanceForPaper(categoryId, poolSize) {
  const categoryChance = categoryChances().get(categoryId);
  if (!categoryChance || !poolSize) return null;
  const withinCategory = Math.min(1, REAL_PER_GROUP / poolSize);
  const probability = categoryChance * withinCategory;
  return {
    probability,
    percent: probability * 100,
    oneIn: Math.round(1 / probability),
    categoryChance,
    poolSize,
  };
}

/** "0.61%" — at least one significant figure, however small. */
export function formatPercent(percent) {
  if (percent >= 10) return `${percent.toFixed(0)}%`;
  if (percent >= 1) return `${percent.toFixed(1)}%`;
  return `${percent.toFixed(2)}%`;
}
