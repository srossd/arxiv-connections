# arXiv Connections

A daily NYT-Connections-style puzzle made from arXiv paper titles, in two rounds.

**Round one** — sixteen titles, four arXiv categories, four titles each. Find the
groups.

**Round two** — three of the four titles in each group are real papers announced
today. The fourth does not exist: it was generated from a grammar induced over
that category's own back catalogue. Once you have found a group, pick out its
impostor.

```
npm start          # http://localhost:8080
```

No dependencies, no build step. Node 20+.

## How a puzzle is made

Everything is derived from the puzzle date, so the same day always yields the same
puzzle for everyone, and the whole thing is one cached file.

1. **The day.** A new puzzle starts at **2:00 am US Eastern** (`America/New_York`,
   so it tracks EST/EDT). arXiv posts each day's announcement around 8 pm Eastern,
   so by 2 am that listing is up.
2. **The seed.** The date string (`arxiv-connections/2026-08-13`) is hashed into a
   mulberry32 PRNG. Category choice, paper choice, and grid order all draw from it.
3. **The categories.** The curated pool in [src/categories.js](src/categories.js)
   is shuffled with that PRNG, then walked in order, pulling one RSS feed at a time
   until four categories stick. A category is skipped if:
   - it announced fewer than 6 new papers today, or
   - it shares an archive with one already chosen (never two `math.*`), or
   - it is a known-confusable partner of one already chosen (`cs.LG` + `stat.ML`).
4. **The papers.** Only `announce_type: new` items, and only those whose *first*
   listed category is the feed itself. In arXiv's feeds a paper's primary category
   is the one it is announced as "new" in; cross-lists arrive as `cross` and are
   excluded, so no group ever contains a paper that is really someone else's.
   (Verified across seven feeds and 300+ items: `new`/`replace` always have the
   feed as primary, `cross`/`replace-cross` never do. The check is enforced in
   code as well, so a feed-format change degrades to a thin category rather than
   silently mixing cross-listed papers in.)
   A paper is also dropped if it is cross-listed to any of the *other three*
   chosen categories, since it would legitimately belong to two groups at once.
5. **The impostors.** Three real papers per category, plus one generated title
   (see below). The fake is checked against every real title in the puzzle, not
   just its own group, so it cannot echo a neighbour.
6. **The grid.** Sixteen tiles, shuffled into a fixed daily order.

That is typically 4–6 feed requests, made one per second with a descriptive
User-Agent, and only on the first request of the day.

## Caching

The finished puzzle is written to `cache/puzzle-YYYY-MM-DD.json` and served from
there for the rest of the day. arXiv is queried **once per day**.

- Concurrent first-hits share a single in-flight build.
- If arXiv is unreachable and no puzzle exists for today, the newest cached puzzle
  is served with `"stale": true` rather than an error page.
- The server warms the day's cache on startup.

To build ahead of time (e.g. a cron job at 2:05 am Eastern):

```
node scripts/build-today.js            # today
node scripts/build-today.js 2026-08-13 # a specific day, if its feed is still up
```

## Playing

Tap four titles, press **Check**. A correct group flips one of the four `?` slots
to the category it was — a link to that category's `new` listing on arXiv — and
drops the papers into a coloured band with links to the abstracts. A wrong group costs a mistake; four mistakes ends the game and
reveals the rest, marked *not found*. Repeating a guess you already made does not
cost a mistake, and a 3-of-4 guess says *One away…*.

Progress is kept in `localStorage` per day, so a reload resumes the same game.

## Stats

**Your own**, from the *Stats* button, kept in `localStorage` and never sent
anywhere:

- **Perfect games** — every group found with no mistakes *and* every impostor
  caught, over games played.
- **Average connection mistakes** — wrong groups per game.
- **Average impostor mistakes** — wrong accusations per game.

A game counts once its first round is over, won or lost; the impostor numbers
keep updating as you accuse, so an unfinished hunt is not held against you until
you make the guess. The panel opens itself when you finish both rounds.

**Everyone's**, shown under a group once you have accused: the share of players
who picked each of its four titles.

```
Quantum cohomology of Calabi-Yau varieties   [impostor]     62%
Tropical and algebraic elliptic plane curves [your guess]   38%
```

The split for a group stays hidden until **10 people** have accused in that
group — counted per group, so the denominator is always the people who actually
answered that question. Below the threshold the server does not send the counts
at all, so an early sample cannot be read off the wire; the group shows how many
more players are needed instead.

The browser generates a random id for itself (`arxiv-connections:player`) so the
server can count each player once. That is the only thing stored about a player:
a random string and up to four small integers. A player's first answer for a
group is final — later submissions are ignored rather than overwriting, so a
reload or a replay cannot skew the split. Guesses are only accepted for the
*current* puzzle day, which stops yesterday's split from being stuffed after the
fact.

Guesses live in `data/stats/guesses-YYYY-MM-DD.json`, one file per day, written
via a temp file and rename so a crash cannot truncate one. **This directory
needs to be persistent** — on a platform with an ephemeral filesystem, point
`ARXIV_STATS_DIR` at a mounted volume or the tallies reset on every restart.

### API

| | |
| --- | --- |
| `POST /api/guess` | `{day, player, group, pick}` -> that group's tally |
| `GET /api/guesses?day=…` | tallies for every group of a day |

## Titles and LaTeX

Titles are rendered with **KaTeX**, vendored into
[public/vendor/katex/](public/vendor/katex/) (woff2 only, ~600 KB) so the game has
no CDN dependency and works offline.

arXiv titles mix `$…$` math with prose that has its own TeX escapes. The math spans
are passed to KaTeX byte for byte; everything around them (and every author name)
gets its accent commands folded to Unicode first — `Moir\'e` → Moiré,
`Erd\H{o}s` → Erdős. See `cleanTitle` in [src/arxiv.js](src/arxiv.js).

Feed text is never inserted as HTML — titles are set via `textContent` and then
typeset in place.

## Layout

Tiles sit on a `minmax(min(300px, 100%), 1fr)` grid: a 4x4 grid on a desktop,
three columns on a small laptop, two on a tablet, one on phones, never
overflowing a 320px screen. The Check bar is fixed to the bottom of the viewport on every size,
with page padding that guarantees no tile is ever trapped behind it.

## Generating the impostors

The fakes come from a grammar induced per category, in the spirit of
[snarxiv](http://snarxiv.org) — except snarxiv's grammar is hand-written for
hep-th, and this one is learned, once, for every category in the pool.

**1. Corpus.** `scripts/harvest-corpus.js` pulls historical titles over
OAI-PMH. arXiv exposes a set per subject class (`cs.SD` -> `cs:cs:SD`), so each
category is harvested directly rather than by sweeping a whole archive, and only
titles whose *primary* category matches are kept — the same rule the puzzle
uses. Target is 4,000 titles per category; it is resumable, and re-running skips
categories already at target.

**2. Induction.** `scripts/build-grammars.js` turns each corpus into a grammar.
Scientific titles are overwhelmingly

```
NOUN-PHRASE  prep  NOUN-PHRASE  prep  NOUN-PHRASE
"Nuclear level density | in | odd-mass nuclei | in the framework of | the projected shell model"
```

so the chunking needs no part-of-speech tagger: split on a closed list of
function words, and whatever survives between them is a noun phrase. Each title
becomes a *template* (function words kept literal, phrases replaced by slots)
plus the phrases that filled it. Phrases are indexed by the literals on **both**
sides of the slot, which is what stops a phrase like "Examining" — one that only
ever opens a title — from landing in `{} on {}` and reading as "Examining on…".

Templates and phrases are kept separately for Title Case and sentence case,
because mixing the two in one title is an obvious tell.

**3. Generation.** Pick a template, refill its slots. The phrases carry the
domain flavour verbatim ("Hauser-Feshbach statistical models"), the template
supplies the grammar, and the result reads like an arXiv title while describing
nothing. Each fake is the pick of ~150 candidates, scored on how well-attested
its template and phrases are, how close its length is to the category's typical
title, and whether its phrases are the right size. The score is computed from
what generation actually chose rather than by re-parsing the output — that is
what filters the fragments that only made sense in their original sentence.

Candidates are drawn from the top few rather than the strict argmax: taking the
single best collapses every day onto the blandest construction the category has.

Real output, all four from one day's puzzle:

```
astro-ph.SR     Numerical simulations of superfluid Fermi mixtures in the solar wind
cs.SD           Background-tracking Acoustic Features for Automatic Music Genre Classification
physics.optics  Second harmonic generation in nonlinear photonic lattices
nucl-th         Final state interaction in asymmetric nuclear matter
```

Each grammar also carries a 32-bit hash per corpus title, so a recombination
that lands exactly on a paper that really exists is rejected — the impostor is
never a real paper.

All 94 categories are harvested and compiled: 405,000 titles in, 9.3 MB of
gzipped grammars out (~100 KB each). A category without a compiled grammar is
skipped during selection, so a puzzle can never contain a group with no
impostor.

```
node scripts/harvest-corpus.js          # all categories (slow, one-time)
node scripts/harvest-corpus.js hep-th   # or just one
node scripts/build-grammars.js          # compile corpora -> grammars
```

## Layout of the repo

```
server.js               static files + /api/puzzle
src/arxiv.js            RSS fetch, parse, TeX folding
src/categories.js       category pool, archive/confusable rules
src/puzzle.js           puzzle day, seeded RNG, selection, cache
src/grammar.js          template induction + fake-title generation
src/fakes.js            grammar loading, one fake per category
src/stats.js            per-day impostor guess tallies
public/                 index.html, styles.css, app.js, vendored KaTeX
scripts/build-today.js  build a day's puzzle from the CLI
scripts/harvest-corpus.js, scripts/build-grammars.js
data/corpus/            harvested titles per category
data/grammars/          compiled grammars (gzipped)
data/stats/             recorded guesses, one file per day (runtime data)
test/                   node --test
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | bind address |
| `ARXIV_CACHE_DIR` | `./cache` | where daily puzzles are written |
| `ARXIV_STATS_DIR` | `./data/stats` | recorded impostor guesses (**needs to persist**) |

| `ARXIV_GRAMMAR_DIR` | `./data/grammars` | compiled grammars |

`ARXIV_FEED_BASE`, `ARXIV_REQUEST_GAP_MS`, and `ARXIV_MAX_ATTEMPTS` exist so the
tests can point the fetcher at a stub; leave them unset in normal use.
`CORPUS_TARGET` and `CORPUS_GAP_MS` tune the harvester.

## Notes

- **Weekends.** arXiv does not announce on Saturday or Sunday, so weekend puzzles
  are drawn from the last weekday's listing. The header states the announcement
  date the papers actually came from.
- **The answers are in the payload.** `/api/puzzle` sends the grouping, and marks
  the fake with `"fake": true`, so both rounds can be checked client-side — the
  same as the NYT puzzle. Anyone reading devtools can see the answers. Moving the
  checks to a server endpoint would be the fix if that ever matters.
- **The fakes skew old.** The corpus spans a category's whole history, so a fake
  reads like a paper from any era while its four neighbours were announced today.
  On a fast-moving category that is a subtle tell — today's cs.SD is all TTS and
  LLMs. Weighting the corpus towards recent years would close the gap.

## Tests

```
npm test
```

Covers the 2 am rollover across EST and EDT, the category rules, TeX folding and
math-span preservation, the cache/fallback behaviour with the network stubbed
out, grammar induction (determinism, no regurgitation of real titles, no severed
math, junk fragments kept out of slots), and the guess tallies (threshold,
one-vote-per-player, per-group independence, persistence, input validation, and
concurrent writes). The gameplay of both rounds, the stats panel and the vote
split were verified separately in a headless browser.
