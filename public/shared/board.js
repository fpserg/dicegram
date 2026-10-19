// SVG board renderer shared by the player app and the admin board editor.
const S = 100; // grid unit in SVG coordinates
const NS = 'http://www.w3.org/2000/svg';

export const CELL_META = {
  start: { icon: '🚩', color: '#0ea5e9', name: 'Start' },
  finish: { icon: '🏁', color: '#f59e0b', name: 'Finish' },
  empty: { icon: '', color: null, name: 'Empty' },
  prize: { icon: '💎', color: '#10b981', name: 'Prize' },
  move: { icon: '⏩', color: '#6366f1', name: 'Move' },
  jump: { icon: '🚀', color: '#8b5cf6', name: 'Jump' },
  skip: { icon: '⛔', color: '#ef4444', name: 'Skip roll' },
  bonus: { icon: '🎲', color: '#14b8a6', name: 'Free turns' },
  task: { icon: '❓', color: '#eab308', name: 'Task' },
  chance: { icon: '🃏', color: '#ec4899', name: 'Chance' },
};

export function cellIcon(c) {
  if (c.type === 'move') return c.steps < 0 ? '⏪' : '⏩';
  if (c.type === 'jump' && c.to !== undefined) return c.to < c.index ? '🐍' : '🚀';
  return CELL_META[c.type]?.icon ?? '';
}

export function describeCell(c) {
  switch (c.type) {
    case 'prize': return `Win ${c.amount} ${c.token}`;
    case 'move': return c.steps > 0 ? `Move ${c.steps} forward` : `Move ${-c.steps} back`;
    case 'jump': return `Jump to cell ${c.to}`;
    case 'skip': return `Skip the next ${c.turns > 1 ? `${c.turns} rolls` : 'roll'}`;
    case 'bonus': return `${c.turns} free turn${c.turns > 1 ? 's' : ''}`;
    case 'task': return `Task: ${c.reward ? `${c.reward.amount} ${c.reward.token}` : ''}`;
    case 'chance': return 'Draw a random card';
    case 'start': return 'Start';
    case 'finish': return 'Finish';
    default: return '';
  }
}

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

const center = (c) => ({ x: c.x * S + S / 2, y: c.y * S + S / 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Offsets so several pawns on the same cell don't hide each other.
const STACK = [[0, 0], [-18, -14], [18, -14], [-18, 14], [18, 14], [0, -22], [0, 22], [-24, 0]];

export function createBoardView(container, { editable = false, onCellClick, onEmptyClick } = {}) {
  const svg = el('svg', { class: 'board-svg', role: 'img' });
  container.replaceChildren(svg);
  let board = null;
  let selected = -1;
  const pawnEls = new Map(); // userId -> <g>
  const shown = new Map(); // userId -> displayed cell index
  let queue = Promise.resolve();

  const layers = {};

  function setBoard(b) {
    board = b;
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${b.cols * S} ${b.rows * S}`);
    svg.setAttribute('aria-label', b.name);
    svg.style.background = b.theme.bg;
    layers.grid = el('g', {}, svg);
    layers.path = el('g', {}, svg);
    layers.cells = el('g', {}, svg);
    layers.jumps = el('g', {}, svg);
    layers.pawns = el('g', {}, svg);
    pawnEls.clear();

    if (editable) {
      const taken = new Set(b.cells.map((c) => `${c.x},${c.y}`));
      for (let y = 0; y < b.rows; y++) {
        for (let x = 0; x < b.cols; x++) {
          if (taken.has(`${x},${y}`)) continue;
          const r = el('rect', { x: x * S + 8, y: y * S + 8, width: S - 16, height: S - 16, rx: 14, class: 'ghost-cell' }, layers.grid);
          r.addEventListener('click', () => onEmptyClick?.(x, y));
        }
      }
    }

    if (b.cells.length > 1) {
      const pts = b.cells.map((c) => { const p = center(c); return `${p.x},${p.y}`; }).join(' ');
      el('polyline', { points: pts, fill: 'none', stroke: b.theme.path, 'stroke-width': 18, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, layers.path);
    }

    b.cells.forEach((c, i) => {
      const meta = CELL_META[c.type] || CELL_META.empty;
      const g = el('g', { class: `cell cell-${c.type}${i === selected ? ' selected' : ''}`, 'data-index': i }, layers.cells);
      const fill = c.color || meta.color || b.theme.cell;
      el('rect', { x: c.x * S + 6, y: c.y * S + 6, width: S - 12, height: S - 12, rx: 16, fill, stroke: 'rgba(255,255,255,.18)', 'stroke-width': 2 }, g);
      el('text', { x: c.x * S + 14, y: c.y * S + 24, class: 'cell-index', fill: b.theme.text }, g).textContent = i;
      el('text', { x: c.x * S + S / 2, y: c.y * S + S / 2 + 10, class: 'cell-icon', 'text-anchor': 'middle' }, g).textContent = cellIcon({ ...c, index: i });
      if (c.label) {
        el('text', { x: c.x * S + S / 2, y: c.y * S + S - 14, class: 'cell-label', 'text-anchor': 'middle', fill: b.theme.text }, g).textContent = c.label.length > 11 ? `${c.label.slice(0, 10)}…` : c.label;
      }
      const tip = [c.label, describeCell(c)].filter(Boolean).join(' — ');
      if (tip) el('title', {}, g).textContent = `#${i} ${tip}`;
      if (onCellClick) g.addEventListener('click', () => onCellClick(i));
      if (c.type === 'jump' && Number.isInteger(c.to) && b.cells[c.to]) {
        const a = center(c);
        const z = center(b.cells[c.to]);
        el('line', { x1: a.x, y1: a.y, x2: z.x, y2: z.y, class: c.to > i ? 'jump-line up' : 'jump-line down' }, layers.jumps);
      }
    });
  }

  function placePawn(userId, index, slot) {
    const g = pawnEls.get(userId);
    const c = board.cells[Math.max(0, Math.min(index, board.cells.length - 1))];
    const p = center(c);
    const [dx, dy] = STACK[slot % STACK.length];
    g.setAttribute('transform', `translate(${p.x + dx} ${p.y + dy})`);
    shown.set(userId, index);
  }

  function ensurePawn(p, highlight) {
    let g = pawnEls.get(p.userId);
    if (!g) {
      g = el('g', { class: 'pawn' }, layers.pawns);
      el('ellipse', { cx: 0, cy: 14, rx: 13, ry: 5, fill: 'rgba(0,0,0,.35)' }, g);
      el('path', { d: 'M-11 12 Q0 -6 11 12 Z', fill: p.color, stroke: '#fff', 'stroke-width': 2 }, g);
      el('circle', { cx: 0, cy: -8, r: 9, fill: p.color, stroke: '#fff', 'stroke-width': 2 }, g);
      el('title', {}, g).textContent = p.name;
      pawnEls.set(p.userId, g);
    }
    g.classList.toggle('me', p.userId === highlight);
    return g;
  }

  // Update pawns. If lastMove is new, walk that pawn step by step.
  function setPlayers(players, { lastMove, me, animate = true } = {}) {
    queue = queue.then(async () => {
      if (!board) return;
      for (const [id, g] of pawnEls) if (!players.some((p) => p.userId === id)) { g.remove(); pawnEls.delete(id); shown.delete(id); }
      for (const p of players) {
        const fresh = !pawnEls.has(p.userId);
        ensurePawn(p, me);
        if (fresh) placePawn(p.userId, p.pos, 0);
      }
      const mover = animate && lastMove && players.find((p) => p.userId === lastMove.userId);
      if (mover && shown.get(mover.userId) === lastMove.from && !lastMove.skipped) {
        const g = pawnEls.get(mover.userId);
        layers.pawns.appendChild(g); // draw on top while moving
        g.classList.add('moving');
        for (let i = lastMove.from + 1; i <= lastMove.landed; i++) {
          placePawn(mover.userId, i, 0);
          await sleep(230);
        }
        if (lastMove.to !== lastMove.landed) {
          await sleep(350);
          g.classList.add('jumping');
          placePawn(mover.userId, lastMove.to, 0);
          await sleep(450);
          g.classList.remove('jumping');
        }
        g.classList.remove('moving');
      }
      for (const p of players) placePawn(p.userId, p.pos, players.filter((q) => q.pos === p.pos).indexOf(p));
    });
    return queue;
  }

  function select(i) {
    selected = i;
    svg.querySelectorAll('.cell').forEach((g) => g.classList.toggle('selected', Number(g.dataset.index) === i));
  }

  return { setBoard, setPlayers, select, svg };
}
