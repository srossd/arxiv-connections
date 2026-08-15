'use strict';

const GROUP_SIZE = 4;
const MAX_STRIKES = 4;
const REVEAL_DELAY = 420;
const WIN_MESSAGE = 'All four — nicely done.';
const LOSS_MESSAGE = 'Four mistakes — here were the four categories.';

const el = {
  board: document.getElementById('board'),
  slots: document.getElementById('slots'),
  solved: document.getElementById('solved'),
  grid: document.getElementById('grid'),
  status: document.getElementById('status'),
  loading: document.getElementById('loading'),
  controls: document.getElementById('controls'),
  strikeDots: document.getElementById('strikeDots'),
  announced: document.getElementById('announced'),
  check: document.getElementById('check'),
  shuffle: document.getElementById('shuffle'),
  deselect: document.getElementById('deselect'),
  statsBtn: document.getElementById('statsBtn'),
  statsDialog: document.getElementById('statsDialog'),
  statsGrid: document.getElementById('statsGrid'),
  statsNote: document.getElementById('statsNote'),
  clearStats: document.getElementById('clearStats'),
  playAgain: document.getElementById('playAgain'),
  helpBtn: document.getElementById('helpBtn'),
  helpDialog: document.getElementById('helpDialog'),
  shareResult: document.getElementById('shareResult'),
};

/**
 * `solved` holds only the groups the player actually found, in the order they
 * found them. Losing does not push into it — the give-away groups are derived
 * from `lost` instead, so a reload can still tell a win from a loss.
 *
 * @type {{puzzle: any, tiles: any[], order: number[], selected: Set<number>,
 *         solved: number[], strikes: number, guesses: string[], lost: boolean}}
 */
const state = {
  puzzle: null,
  tiles: [],
  order: [],
  selected: new Set(),
  solved: [],
  strikes: 0,
  guesses: [],
  lost: false,
  // Round two: groupIndex -> index within that group's papers that the player
  // accused of being the fake. One accusation per group, and only once the
  // group is on the board.
  impostors: {},
  // groupIndex -> { total, enough, counts } : how everyone else voted. Only
  // arrives once a group has enough respondents to be worth showing.
  splits: {},
  // True once today's puzzle has been replayed. The first result of the day is
  // the one that counts, so a replay is practice.
  replaying: false,
};

const isWon = () => state.solved.length === GROUP_SIZE;
const isOver = () => state.lost || isWon();

// -1 when a group carries no impostor at all. That should never happen, but a
// payload from an older build would score every accusation wrong while claiming
// to mark an impostor it does not have, so round two is simply withheld for any
// such group rather than run on a wrong answer.
const fakeIndexIn = (group) => group.papers.findIndex((paper) => paper.fake);
const hasImpostor = (groupIndex) => fakeIndexIn(state.puzzle.groups[groupIndex]) !== -1;
const caughtImpostor = (groupIndex) =>
  hasImpostor(groupIndex) && state.impostors[groupIndex] === fakeIndexIn(state.puzzle.groups[groupIndex]);

const huntableGroups = () => state.puzzle.groups.map((_, i) => i).filter(hasImpostor);
const impostorsCaught = () => huntableGroups().filter(caughtImpostor).length;
const allAccused = () => huntableGroups().every((g) => state.impostors[g] !== undefined);
const roundsComplete = () => isOver() && allAccused();
const summary = () => {
  const total = huntableGroups().length;
  return total
    ? `Groups ${state.solved.length}/${GROUP_SIZE} · impostors ${impostorsCaught()}/${total}.`
    : `Groups ${state.solved.length}/${GROUP_SIZE}.`;
};

/** Groups to show above the grid: found ones first, then the giveaways. */
function displayedGroups() {
  const shown = state.solved.map((groupIndex) => ({ groupIndex, missed: false }));
  if (state.lost) {
    for (let g = 0; g < GROUP_SIZE; g++) {
      if (!state.solved.includes(g)) shown.push({ groupIndex: g, missed: true });
    }
  }
  return shown;
}

// ---------------------------------------------------------------- rendering

/** Renders any `$…$` math inside `node` with KaTeX, if it loaded. */
function renderMath(node) {
  if (typeof window.renderMathInElement !== 'function') return;
  try {
    window.renderMathInElement(node, {
      delimiters: [
        { left: '$$', right: '$$', display: false },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
      ],
      throwOnError: false,
      errorColor: 'inherit',
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
    });
  } catch { /* a malformed title should never take the board down */ }
}

/** Plain-text node with its math typeset. Never uses innerHTML on feed data. */
function mathText(tag, text, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  renderMath(node);
  return node;
}

function sizeClassFor(title) {
  if (title.length > 140) return 'tile tile--xlong';
  if (title.length > 90) return 'tile tile--long';
  return 'tile';
}

/** arXiv's "new submissions" listing for a category — what the puzzle was drawn from. */
const listingUrl = (categoryId) => `https://arxiv.org/list/${encodeURIComponent(categoryId)}/new`;

function renderSlots() {
  const shown = displayedGroups();
  el.slots.replaceChildren(...Array.from({ length: GROUP_SIZE }, (_, i) => {
    const li = document.createElement('li');
    const groupIndex = shown[i]?.groupIndex;

    if (groupIndex === undefined) {
      const box = document.createElement('div');
      box.className = 'slot';
      box.textContent = '?';
      box.setAttribute('aria-label', 'Category not found yet');
      li.append(box);
      return li;
    }

    const group = state.puzzle.groups[groupIndex];
    const box = document.createElement('a');
    box.className = `slot slot--filled slot--${i + 1}`;
    box.href = listingUrl(group.id);
    box.target = '_blank';
    box.rel = 'noopener';
    box.title = `${group.name} (${group.id}) — new submissions on arXiv`;
    box.append(mathText('span', group.name), mathText('span', group.id, 'slot__id'));
    li.append(box);
    return li;
  }));
}

function renderSolved() {
  el.solved.replaceChildren(...displayedGroups().map(({ groupIndex, missed }, position) => {
    const group = state.puzzle.groups[groupIndex];
    const fakeIndex = fakeIndexIn(group);
    const huntable = fakeIndex !== -1;
    const accused = state.impostors[groupIndex];
    const decided = !huntable || accused !== undefined;

    const box = document.createElement('section');
    box.className = `solved__group solved__group--${position + 1}`;

    const heading = document.createElement('p');
    heading.className = 'solved__name';
    heading.append(group.name, ' ');
    const id = document.createElement('a');
    id.className = 'solved__id';
    id.href = listingUrl(group.id);
    id.target = '_blank';
    id.rel = 'noopener';
    id.textContent = group.id;
    heading.append(id);
    if (missed) {
      const tag = document.createElement('span');
      tag.className = 'solved__missed';
      tag.textContent = ' · not found';
      heading.append(tag);
    }

    const prompt = document.createElement('p');
    prompt.className = 'solved__prompt';
    if (!huntable) prompt.textContent = '';
    else if (!decided) prompt.textContent = 'One of these four does not exist. Which?';
    else if (caughtImpostor(groupIndex)) prompt.textContent = 'You spotted the impostor.';
    else prompt.textContent = 'That one was real — the impostor is marked.';

    const list = document.createElement('ul');
    list.className = 'solved__papers';

    group.papers.forEach((paper, index) => {
      const item = document.createElement('li');

      if (!decided) {
        // Round two is open: every title is an accusation button, so nothing
        // navigates away mid-guess.
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'accuse';
        button.dataset.group = String(groupIndex);
        button.dataset.paper = String(index);
        button.append(mathText('span', paper.title, 'accuse__text'));
        item.append(button);
        list.append(item);
        return;
      }

      const row = document.createElement('span');
      row.className = 'verdict';
      if (index === fakeIndex) row.classList.add('verdict--fake');
      if (index === accused && index !== fakeIndex) row.classList.add('verdict--wrong');

      // Title and chip share one inline wrapper so a wrapped title cannot push
      // the percentage onto a line of its own.
      const main = document.createElement('span');
      main.className = 'verdict__main';
      row.append(main);

      if (paper.fake) {
        main.append(mathText('span', paper.title, 'verdict__text'));
      } else {
        const link = document.createElement('a');
        link.href = paper.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = paper.title;
        renderMath(link);
        main.append(link);
      }

      if (index === fakeIndex) {
        const chip = document.createElement('span');
        chip.className = 'chip chip--fake';
        chip.textContent = index === accused ? 'impostor — caught' : 'impostor';
        main.append(' ', chip);
      } else if (index === accused) {
        const chip = document.createElement('span');
        chip.className = 'chip chip--miss';
        chip.textContent = 'your guess';
        main.append(' ', chip);
      }

      const split = state.splits[groupIndex];
      if (split?.enough && split.total > 0) {
        const percent = Math.round((split.counts[index] / split.total) * 100);
        row.classList.add('verdict--shared');
        row.style.setProperty('--share', `${percent}%`);
        const share = document.createElement('span');
        share.className = 'share';
        share.textContent = `${percent}%`;
        share.title = `${split.counts[index]} of ${split.total} players picked this`;
        row.append(share);
      }

      item.append(row);
      list.append(item);
    });

    box.append(heading);
    if (prompt.textContent) box.append(prompt);
    box.append(list);
    return box;
  }));
}

function renderGrid() {
  const solvedSet = new Set(displayedGroups().map((entry) => entry.groupIndex));
  const visible = state.order.filter((index) => !solvedSet.has(state.tiles[index].groupIndex));

  el.grid.replaceChildren(...visible.map((index) => {
    const tile = state.tiles[index];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = sizeClassFor(tile.title);
    button.dataset.index = String(index);
    button.setAttribute('aria-pressed', String(state.selected.has(index)));
    if (state.selected.has(index)) button.classList.add('tile--selected');
    // The title goes in a single child: the tile is a flex container, and
    // KaTeX splits text into sibling spans that would each become a flex item.
    button.append(mathText('span', tile.title, 'tile__text'));
    return button;
  }));
}

function renderControls() {
  el.strikeDots.replaceChildren(...Array.from({ length: MAX_STRIKES }, (_, i) => {
    const dot = document.createElement('span');
    dot.className = i < state.strikes ? 'strikes__dot strikes__dot--used' : 'strikes__dot';
    return dot;
  }));
  const over = isOver();
  // The three play controls are inert once the game is over, so hand their
  // space to Play again rather than showing four buttons, three of them dead.
  for (const button of [el.shuffle, el.deselect, el.check]) button.hidden = over;
  el.playAgain.hidden = !over;

  el.check.disabled = over || state.selected.size !== GROUP_SIZE;
  el.deselect.disabled = over || state.selected.size === 0;
  el.shuffle.disabled = over;
}

function setStatus(message, tone) {
  el.status.textContent = message;
  el.status.className = tone ? `status status--${tone}` : 'status';
}

function renderAll() {
  renderSlots();
  renderSolved();
  renderGrid();
  renderControls();
}

// ------------------------------------------------------------- persistence

const storageKey = (day) => `arxiv-connections:${day}`;
const PLAYER_KEY = 'arxiv-connections:player';
const RESULTS_KEY = 'arxiv-connections:results';
const SEEN_HELP_KEY = 'arxiv-connections:seen-help';

/**
 * A random id this browser keeps for itself, so the server can count each
 * player once without knowing anything about them.
 */
function playerId() {
  try {
    let id = localStorage.getItem(PLAYER_KEY);
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = (crypto.randomUUID?.() ?? `p-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`)
        .replace(/[^A-Za-z0-9_-]/g, '');
      localStorage.setItem(PLAYER_KEY, id);
    }
    return id;
  } catch {
    return null;   // storage blocked: play on, just don't contribute to the split
  }
}

function loadResults() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESULTS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Records the finished game for the personal stats. Only games whose first
 * round is over are counted; impostor numbers keep updating as accusations
 * come in, so the row is rewritten rather than appended to.
 */
function recordResult() {
  if (!state.puzzle || !isOver()) return;
  try {
    const results = loadResults();
    // First finish of the day wins. Without this a replay would rewrite
    // history, and "perfect games" would mean nothing more than persistence.
    if (state.replaying && results[state.puzzle.day]) return;
    const accused = huntableGroups().filter((g) => state.impostors[g] !== undefined).length;
    results[state.puzzle.day] = {
      groups: state.solved.length,
      strikes: state.strikes,
      huntable: huntableGroups().length,
      accused,
      caught: impostorsCaught(),
    };
    localStorage.setItem(RESULTS_KEY, JSON.stringify(results));
  } catch { /* storage blocked; stats simply will not accumulate */ }
}

/** A perfect game: every group found with no mistakes, and every impostor caught. */
const isPerfect = (row) =>
  row.groups === GROUP_SIZE && row.strikes === 0
  && row.huntable > 0 && row.caught === row.huntable;

function aggregateStats() {
  const rows = Object.values(loadResults());
  const played = rows.length;
  const mean = (pick) => (played ? rows.reduce((sum, row) => sum + pick(row), 0) / played : 0);
  return {
    played,
    perfect: rows.filter(isPerfect).length,
    connectionMistakes: mean((row) => row.strikes),
    impostorMistakes: mean((row) => Math.max(0, row.accused - row.caught)),
  };
}

function save() {
  try {
    localStorage.setItem(storageKey(state.puzzle.day), JSON.stringify({
      solved: state.solved,
      strikes: state.strikes,
      guesses: state.guesses,
      lost: state.lost,
      impostors: state.impostors,
      replaying: state.replaying,
    }));
  } catch { /* private browsing, quota — the game still works, just not resumable */ }
}

function restore(day) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(day)) ?? 'null');
    if (!saved || !Array.isArray(saved.solved)) return;
    state.solved = [...new Set(saved.solved)]
      .filter((n) => Number.isInteger(n) && n >= 0 && n < GROUP_SIZE);
    state.strikes = Math.min(MAX_STRIKES, Math.max(0, saved.strikes | 0));
    state.guesses = Array.isArray(saved.guesses) ? saved.guesses : [];
    state.lost = Boolean(saved.lost) || state.strikes >= MAX_STRIKES;
    state.replaying = Boolean(saved.replaying);
    if (saved.impostors && typeof saved.impostors === 'object') {
      for (const [group, pick] of Object.entries(saved.impostors)) {
        const g = Number(group);
        if (Number.isInteger(g) && g >= 0 && g < GROUP_SIZE
            && Number.isInteger(pick) && pick >= 0 && pick < GROUP_SIZE) {
          state.impostors[g] = pick;
        }
      }
    }
  } catch { /* corrupt entry: start fresh */ }
}

// -------------------------------------------------------------- game logic

function toggle(index) {
  if (isOver()) return;
  if (state.selected.has(index)) state.selected.delete(index);
  else if (state.selected.size < GROUP_SIZE) state.selected.add(index);
  else return;
  renderGrid();
  renderControls();
}

function loseGame() {
  state.lost = true;
  state.selected.clear();
  setStatus(LOSS_MESSAGE, 'alert');
}

/** Sends this accusation and folds the resulting split into the board. */
async function shareGuess(groupIndex, paperIndex) {
  const player = playerId();
  if (!player) return;
  try {
    const response = await fetch('api/guess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: state.puzzle.day, player, group: groupIndex, pick: paperIndex }),
    });
    if (!response.ok) return;
    state.splits[groupIndex] = await response.json();
    renderAll();
  } catch { /* offline or blocked: the game does not depend on this */ }
}

/** On reload, recover the splits for groups already accused. */
async function loadSplits() {
  if (!huntableGroups().some((g) => state.impostors[g] !== undefined)) return;
  try {
    const response = await fetch(`api/guesses?day=${encodeURIComponent(state.puzzle.day)}`);
    if (!response.ok) return;
    const { groups } = await response.json();
    for (const [group, tally] of Object.entries(groups ?? {})) {
      if (state.impostors[Number(group)] !== undefined) state.splits[Number(group)] = tally;
    }
    renderAll();
  } catch { /* leave the splits unshown */ }
}

function accuse(groupIndex, paperIndex) {
  if (!hasImpostor(groupIndex)) return;
  if (state.impostors[groupIndex] !== undefined) return;
  state.impostors[groupIndex] = paperIndex;
  const right = caughtImpostor(groupIndex);
  save();
  recordResult();
  renderAll();
  shareGuess(groupIndex, paperIndex);
  if (roundsComplete()) {
    setStatus(summary(), impostorsCaught() === huntableGroups().length ? 'good' : null);
    // Only on the transition, never on a reload of an already-finished game --
    // and not after a replay, whose result is not the one on record.
    if (!state.replaying) setTimeout(openStats, 700);
  } else {
    setStatus(right ? 'Impostor caught.' : 'No — that paper is real.', right ? 'good' : 'alert');
  }
}

function check() {
  if (isOver() || state.selected.size !== GROUP_SIZE) return;

  const picked = [...state.selected];
  const signature = picked.slice().sort((a, b) => a - b).join(',');
  if (state.guesses.includes(signature)) {
    setStatus('You already tried that one.', 'alert');
    return;
  }
  state.guesses.push(signature);

  const groupsPicked = picked.map((i) => state.tiles[i].groupIndex);
  const tally = new Map();
  for (const g of groupsPicked) tally.set(g, (tally.get(g) ?? 0) + 1);
  const [bestGroup, bestCount] = [...tally].sort((a, b) => b[1] - a[1])[0];

  const nodes = picked
    .map((i) => el.grid.querySelector(`[data-index="${i}"]`))
    .filter(Boolean);

  if (bestCount === GROUP_SIZE) {
    for (const node of nodes) node.classList.add('tile--correct');
    state.solved.push(bestGroup);
    state.selected.clear();
    setStatus(
      isWon() ? `${WIN_MESSAGE} Now find the impostors.` : `${state.puzzle.groups[bestGroup].name}!`,
      'good',
    );
    save();
    recordResult();
    setTimeout(renderAll, REVEAL_DELAY);
    return;
  }

  state.strikes++;
  for (const node of nodes) {
    node.classList.remove('tile--wrong');
    void node.offsetWidth; // restart the animation
    node.classList.add('tile--wrong');
  }
  setStatus(bestCount === GROUP_SIZE - 1 ? 'One away…' : 'Not a group.', 'alert');

  if (state.strikes >= MAX_STRIKES) {
    setTimeout(() => {
      loseGame();
      renderAll();
      setStatus(`${LOSS_MESSAGE} You can still hunt the impostors.`, 'alert');
      save();
      recordResult();
    }, REVEAL_DELAY);
    save();
    return;
  }
  save();
  renderControls();
}

function shuffleVisible() {
  for (let i = state.order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.order[i], state.order[j]] = [state.order[j], state.order[i]];
  }
  renderGrid();
}

// ------------------------------------------------------------------ stats UI

const oneDecimal = (n) => (Math.round(n * 10) / 10).toFixed(1);

/** Today's recorded result, or null if today has not been finished. */
const todaysResult = () => (state.puzzle ? loadResults()[state.puzzle.day] ?? null : null);

/**
 * The sentence shared after a game. Built from the *recorded* result, so it
 * matches the stats rather than a replay.
 */
function shareText(row) {
  const link = `${window.location.origin}${window.location.pathname}`.replace(/\/$/, '');
  const impostors = `${row.caught}/${row.huntable} impostors`;
  const mistakes = row.strikes === 0
    ? 'no mistakes'
    : `only ${row.strikes} mistake${row.strikes === 1 ? '' : 's'}`;

  // "I found N groups … and found N impostors" repeats itself, so the losing
  // opening uses a different verb.
  const opening = row.groups === GROUP_SIZE
    ? `I solved the arXiv Connections with ${mistakes}`
    : `I got ${row.groups}/${GROUP_SIZE} groups in the arXiv Connections`;
  return `${opening}, and found ${impostors}! ${link}`;
}

async function shareTodaysResult() {
  const row = todaysResult();
  if (!row) return;
  const text = shareText(row);

  // The share sheet where there is one, the clipboard otherwise.
  try {
    if (navigator.share) {
      await navigator.share({ text });
      return;
    }
  } catch {
    return;   // the user dismissed the sheet; do not then silently copy
  }

  try {
    await navigator.clipboard.writeText(text);
    const original = el.shareResult.textContent;
    el.shareResult.textContent = 'Copied';
    el.shareResult.disabled = true;
    setTimeout(() => {
      el.shareResult.textContent = original;
      el.shareResult.disabled = false;
    }, 1600);
  } catch {
    window.prompt('Copy your result:', text);
  }
}

function renderStats() {
  const { played, perfect, connectionMistakes, impostorMistakes } = aggregateStats();

  const rows = [
    ['Perfect games', played ? `${perfect} / ${played}` : '—',
      'Every group found with no mistakes, and every impostor caught'],
    ['Average connection mistakes', played ? oneDecimal(connectionMistakes) : '—',
      'Wrong groups per game, out of four allowed'],
    ['Average impostor mistakes', played ? oneDecimal(impostorMistakes) : '—',
      'Wrong accusations per game'],
  ];

  el.statsGrid.replaceChildren(...rows.flatMap(([label, value, hint]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const small = document.createElement('small');
    small.textContent = hint;
    dt.append(small);
    const dd = document.createElement('dd');
    dd.textContent = value;
    return [dt, dd];
  }));

  el.statsNote.textContent = played
    ? `Based on ${played} ${played === 1 ? 'day' : 'days'} played on this device.`
    : 'Finish today\'s puzzle and your stats will appear here.';
  // Nothing to clear on a fresh device, so do not offer it.
  el.clearStats.hidden = played === 0;
  // Sharing is about today's game, so it only appears once today is finished.
  el.shareResult.hidden = todaysResult() === null;
}

/**
 * Starts today's puzzle over: same sixteen titles, same groups, same impostors.
 * Offered only once the game is finished, so it cannot be used to duck a strike.
 */
function playAgain() {
  const banked = Boolean(loadResults()[state.puzzle.day]);
  const confirmed = window.confirm(
    banked
      ? 'Play today\'s puzzle again? Your recorded result for today stands, so this round is just for fun.'
      : 'Play today\'s puzzle again?',
  );
  if (!confirmed) return;

  state.solved = [];
  state.strikes = 0;
  state.guesses = [];
  state.lost = false;
  state.impostors = {};
  state.splits = {};
  state.selected.clear();
  state.replaying = true;
  state.order = Array.isArray(state.puzzle.order) && state.puzzle.order.length === state.tiles.length
    ? state.puzzle.order.slice()
    : state.tiles.map((_, i) => i);

  save();
  renderAll();
  setStatus(banked ? 'Replaying today\'s puzzle — your recorded result stands.' : '');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearStats() {
  const { played } = aggregateStats();
  if (!played) return;
  const confirmed = window.confirm(
    `Clear your stats? This erases ${played} ${played === 1 ? 'day' : 'days'} of results `
    + 'on this device and cannot be undone. Today\'s game in progress is not affected.',
  );
  if (!confirmed) return;
  try {
    localStorage.removeItem(RESULTS_KEY);
  } catch { /* storage blocked; there was nothing to clear */ }
  renderStats();
}

function showDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

/** Opens the rules once, on a first visit, and thereafter only on request. */
function maybeShowHelp() {
  let seen = true;
  try {
    seen = localStorage.getItem(SEEN_HELP_KEY) === '1';
  } catch { /* storage blocked: treat as seen so it cannot nag every load */ }
  if (seen) return;
  showDialog(el.helpDialog);
}

// Any dismissal counts — the close button, Esc, or a click outside.
el.helpDialog.addEventListener('close', () => {
  try {
    localStorage.setItem(SEEN_HELP_KEY, '1');
  } catch { /* nothing to remember it with */ }
});

el.helpBtn.addEventListener('click', () => showDialog(el.helpDialog));

function openStats() {
  renderStats();
  showDialog(el.statsDialog);
}

el.statsBtn.addEventListener('click', openStats);
el.clearStats.addEventListener('click', clearStats);
el.playAgain.addEventListener('click', playAgain);
el.shareResult.addEventListener('click', shareTodaysResult);

// ------------------------------------------------------------------- start

el.grid.addEventListener('click', (event) => {
  const tile = event.target.closest('.tile');
  if (tile) toggle(Number(tile.dataset.index));
});

el.solved.addEventListener('click', (event) => {
  const button = event.target.closest('.accuse');
  if (button) accuse(Number(button.dataset.group), Number(button.dataset.paper));
});

el.check.addEventListener('click', check);
el.shuffle.addEventListener('click', shuffleVisible);
el.deselect.addEventListener('click', () => {
  state.selected.clear();
  renderGrid();
  renderControls();
});

/**
 * Formats the puzzle's own day (YYYY-MM-DD).
 *
 * The feed's pubDate is not used for this: arXiv relabels the RSS at midnight
 * Eastern while the game rolls over at 2am, so for those two hours the feed
 * already carries tomorrow's date. Showing the puzzle day keeps the header
 * consistent with the puzzle you are actually playing.
 */
function describeDay(day) {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

async function start() {
  let puzzle;
  try {
    const response = await fetch('api/puzzle');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    puzzle = await response.json();
  } catch {
    el.loading.textContent = 'Could not load today’s puzzle. Please try again in a moment.';
    el.board.removeAttribute('aria-busy');
    return;
  }

  state.puzzle = puzzle;
  state.tiles = puzzle.groups.flatMap((group, groupIndex) =>
    group.papers.map((paper) => ({ ...paper, groupIndex })));
  state.order = Array.isArray(puzzle.order) && puzzle.order.length === state.tiles.length
    ? puzzle.order.slice()
    : state.tiles.map((_, i) => i);

  restore(puzzle.day);

  // announcedDay is the mailing's own date, clamped so it never runs ahead of
  // the puzzle day. On a weekend it is the last weekday arXiv announced on.
  const when = describeDay(puzzle.announcedDay ?? puzzle.day);
  el.announced.textContent = when
    ? `Papers announced ${when}${puzzle.stale ? ' (arXiv unreachable — showing the last puzzle)' : ''}`
    : '';

  el.loading.remove();
  el.controls.hidden = false;
  el.board.removeAttribute('aria-busy');
  renderAll();

  loadSplits();
  maybeShowHelp();

  if (roundsComplete()) setStatus(summary(), impostorsCaught() === huntableGroups().length ? 'good' : null);
  else if (isWon()) setStatus(`${WIN_MESSAGE} Now find the impostors.`, 'good');
  else if (state.lost) setStatus(`${LOSS_MESSAGE} You can still hunt the impostors.`, 'alert');
}

start();
