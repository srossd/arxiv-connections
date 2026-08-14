// Fetching and parsing of arXiv's daily announcement RSS feeds.
//
// The RSS feed is the right source here (rather than the Atom search API):
// it is literally "what was announced today" for a category, and each item
// carries an <arxiv:announce_type> so we can keep genuinely new papers and
// drop cross-lists and replacements.

// Overridable so tests can point at a stub (or a dead host) instead of arXiv.
const FEED_BASE = process.env.ARXIV_FEED_BASE ?? 'https://rss.arxiv.org/rss/';
const USER_AGENT = 'arxiv-connections/1.0 (daily puzzle; contact via repository)';
const REQUEST_GAP_MS = Number(process.env.ARXIV_REQUEST_GAP_MS ?? 1000); // be polite: ~1 feed/sec
const MAX_ATTEMPTS = Number(process.env.ARXIV_MAX_ATTEMPTS ?? 4);

// Category pairs arXiv treats as the same category under two names.
const ALIASES = new Map([
  ['math.MP', 'math-ph'],
  ['math.IT', 'cs.IT'],
  ['math.ST', 'stat.TH'],
  ['cs.SY', 'eess.SY'],
]);

export const canonical = (id) => ALIASES.get(id) ?? id;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function tagText(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match ? decodeEntities(match[1]).trim() : null;
}

function allTagText(block, tag) {
  const matches = block.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'));
  return [...matches].map((m) => decodeEntities(m[1]).trim());
}

// Author names arrive with TeX escapes (`L\"udtke`, `Fran\c{c}ois`). Titles are
// rendered as math by KaTeX, but names are plain text, so fold the common
// accent commands down to real Unicode using combining marks + NFC.
const ACCENTS = {
  '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃',
  '=': '̄', '.': '̇', u: '̆', v: '̌', H: '̋',
  c: '̧', k: '̨', r: '̊', d: '̣', b: '̱',
};
const LIGATURES = {
  ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ',
  o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', aa: 'å', AA: 'Å',
  i: 'i', j: 'j',
};

// Folds TeX escapes to Unicode. Whitespace is left exactly as-is so callers can
// splice segments back together without losing the spaces between them.
function foldTeX(text) {
  return text
    // \"{o} / \"o / \c{c} / \v s  ->  base letter + combining mark
    .replace(/\\([`'"^~=.uvHckrdb])\s*\{?([A-Za-z])\}?/g,
      (match, accent, letter) => (ACCENTS[accent] ? letter + ACCENTS[accent] : match))
    // \ss, \o, \l, \aa ... (longest command first so \aa beats \a)
    .replace(/\\(ss|AE|ae|OE|oe|AA|aa|[oOlLij])(?![A-Za-z])(?:\{\})?/g,
      (match, cmd) => LIGATURES[cmd] ?? match)
    .replace(/[{}]/g, '')
    .replace(/\\[,;!]/g, ' ')
    // TeX dashes: `magneto--hydrodynamics` should render as an en dash, not as
    // two hyphens. Longest first.
    .replace(/---/g, '\u2014')
    .replace(/--/g, '\u2013')
    .normalize('NFC');
}

const tidy = (text) => text.replace(/\s+/g, ' ').trim();

export const deTeX = (text) => tidy(foldTeX(text));

// Titles are mostly prose with `$...$` islands of math. KaTeX renders the math;
// the prose around it still needs TeX accents folded away (arXiv titles contain
// things like `Moir\'e` outside math mode). Math spans are passed through byte
// for byte so KaTeX sees exactly what the author wrote.
const MATH_SPAN = /\$\$[\s\S]*?\$\$|\$(?:\\.|[^$\\])*\$/g;

export function cleanTitle(raw) {
  let out = '';
  let cursor = 0;
  for (const match of raw.matchAll(MATH_SPAN)) {
    out += foldTeX(raw.slice(cursor, match.index));
    out += match[0];
    cursor = match.index + match[0].length;
  }
  out += foldTeX(raw.slice(cursor));
  return tidy(out);
}

let lastRequestAt = 0;

async function politeFetch(url) {
  const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    lastRequestAt = Date.now();
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return await response.text();
      // 429/5xx are worth retrying; anything else is a hard failure.
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`${url} -> HTTP ${response.status}`);
      }
      lastError = new Error(`${url} -> HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

/**
 * Fetch one category's announcement feed.
 * Returns { announcedOn, papers } where papers are the newly announced ones
 * (announce_type "new", i.e. primary-category submissions), in feed order.
 */
export async function fetchCategoryFeed(categoryId) {
  const xml = await politeFetch(FEED_BASE + encodeURIComponent(categoryId));
  const announcedOn = tagText(xml.split('<item>')[0], 'pubDate');

  const wanted = canonical(categoryId);
  const papers = [];
  for (const [, block] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    // "new" means a first-time submission whose PRIMARY category is this feed;
    // cross-lists arrive as "cross" and replacements as "replace"/"replace-cross".
    if (tagText(block, 'arxiv:announce_type') !== 'new') continue;

    const title = tagText(block, 'title');
    const link = tagText(block, 'link');
    if (!title || !link) continue;

    const categories = [...new Set(allTagText(block, 'category').map(canonical))];
    // Belt and braces: arXiv lists the primary category first, so this should
    // already hold for every "new" item. Enforced so a feed-format change shows
    // up as a thin category rather than as cross-listed papers in a group.
    if (categories[0] !== wanted) continue;

    const guid = tagText(block, 'guid') ?? '';
    const id = guid.replace(/^oai:arXiv\.org:/, '') || link.split('/').pop();
    const authors = (tagText(block, 'dc:creator') ?? '')
      .split(/,\s*/)
      .map(deTeX)
      .filter(Boolean);

    papers.push({ id, title: cleanTitle(title), url: link, authors, categories });
  }
  return { announcedOn, papers };
}
