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

      if (paper.fake) {
        row.append(mathText('span', paper.title, 'verdict__text'));
      } else {
        const link = document.createElement('a');
        link.href = paper.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = paper.title;
        renderMath(link);
        row.append(link);
      }

      if (index === fakeIndex) {
        const chip = document.createElement('span');
        chip.className = 'chip chip--fake';
        chip.textContent = index === accused ? 'impostor — caught' : 'impostor';
        row.append(chip);
      } else if (index === accused) {
        const chip = document.createElement('span');
        chip.className = 'chip chip--miss';
        chip.textContent = 'your guess';
        row.append(chip);
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

function save() {
  try {
    localStorage.setItem(storageKey(state.puzzle.day), JSON.stringify({
      solved: state.solved,
      strikes: state.strikes,
      guesses: state.guesses,
      lost: state.lost,
      impostors: state.impostors,
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

function accuse(groupIndex, paperIndex) {
  if (!hasImpostor(groupIndex)) return;
  if (state.impostors[groupIndex] !== undefined) return;
  state.impostors[groupIndex] = paperIndex;
  const right = caughtImpostor(groupIndex);
  save();
  renderAll();
  if (roundsComplete()) setStatus(summary(), impostorsCaught() === GROUP_SIZE ? 'good' : null);
  else setStatus(right ? 'Impostor caught.' : 'No — that paper is real.', right ? 'good' : 'alert');
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

function describeDate(announcedOn) {
  const parsed = new Date(announcedOn);
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

  const when = describeDate(puzzle.announcedOn);
  el.announced.textContent = when
    ? `Papers announced ${when}${puzzle.stale ? ' (arXiv unreachable — showing the last puzzle)' : ''}`
    : '';

  el.loading.remove();
  el.controls.hidden = false;
  el.board.removeAttribute('aria-busy');
  renderAll();

  if (roundsComplete()) setStatus(summary(), impostorsCaught() === GROUP_SIZE ? 'good' : null);
  else if (isWon()) setStatus(`${WIN_MESSAGE} Now find the impostors.`, 'good');
  else if (state.lost) setStatus(`${LOSS_MESSAGE} You can still hunt the impostors.`, 'alert');
}

start();
