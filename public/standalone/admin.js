// Admin view of the standalone app: board designer, games, players, withdrawals.
// Shown only to people who can edit the artifact (or everyone in single-device mode).
import { createBoardView, CELL_META, describeCell } from '../shared/board.js';
import * as engine from '../shared/engine.js';
import { demoBoard } from '../shared/demo.js';

const $ = (s, root = document) => root.querySelector(s);

export function initAdmin({ store, toast, ask, guard, esc, fmt, tokens, ledgerAdd, newId, openGame }) {
  const { amt } = engine;
  const tok = (o) => tokens(o) || '—';
  let tab = 'boards';
  let boards = [];
  let games = [];
  let withdrawals = [];
  let wallets = [];
  let unwatchWallets = null;
  let unwatchBoards = null;

  function show() {
    if (!unwatchBoards) {
      unwatchBoards = store.watchCol('boards', (list) => {
        boards = list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        renderBoardList();
        if (tab === 'games') renderGames();
      });
    }
    showTab(tab);
  }

  function showTab(t) {
    tab = t;
    document.querySelectorAll('#admin-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    for (const name of ['boards', 'games', 'players', 'withdrawals']) $(`#tab-${name}`).hidden = name !== t;
    if (t === 'players' && !unwatchWallets) {
      unwatchWallets = store.watchCol('wallets', (list) => { wallets = list; if (tab === 'players') renderPlayers(); });
    }
    ({ boards: renderBoardList, games: renderGames, players: renderPlayers, withdrawals: renderWithdrawals })[t]();
  }

  document.querySelectorAll('#admin-tabs button').forEach((b) => b.addEventListener('click', guard(async () => {
    if (tab === 'boards' && dirty && b.dataset.tab !== 'boards') {
      if (!(await ask({ title: 'Discard unsaved board changes?', ok: 'Discard', danger: true }))) return;
      setDirty(false);
    }
    showTab(b.dataset.tab);
  })));

  // ================= BOARDS =================
  let draft = null;
  let selected = -1;
  let dirty = false;
  const view = createBoardView($('#b-canvas'), {
    editable: true,
    onCellClick: (i) => { selected = i; view.select(i); renderCellForm(); },
    onEmptyClick: (x, y) => addCell(x, y),
  });

  function renderBoardList() {
    $('#board-list').innerHTML = boards.map((b) => `<li><button data-id="${esc(b.id)}" class="${b.id === draft?.id ? 'active' : ''}" type="button">${esc(b.name)}<br><span class="muted small">${b.cols}×${b.rows} · ${b.cells.length} cells</span></button></li>`).join('') || '<li class="muted small">No boards yet</li>';
    $('#board-list').querySelectorAll('button').forEach((btn) => btn.addEventListener('click', guard(async () => {
      if (dirty && !(await ask({ title: 'Discard unsaved changes?', ok: 'Discard', danger: true }))) return;
      openBoard(boards.find((b) => b.id === btn.dataset.id));
    })));
    if (!draft && boards.length) openBoard(boards[0]);
    if (!draft) $('#editor').hidden = true;
  }

  function openBoard(b) {
    draft = structuredClone(b);
    selected = -1;
    setDirty(false);
    $('#editor').hidden = false;
    $('#board-list').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.id === b.id));
    fillSettings();
    redraw();
    renderCellForm();
  }

  function setDirty(v) {
    dirty = v;
    $('#b-dirty').textContent = v ? 'Unsaved changes' : '';
  }

  function fillSettings() {
    $('#b-name').value = draft.name;
    $('#b-cols').value = draft.cols;
    $('#b-rows').value = draft.rows;
    $('#b-bg').value = draft.theme.bg;
    $('#b-cell').value = draft.theme.cell;
    $('#b-path').value = draft.theme.path;
    $('#b-text').value = draft.theme.text;
  }

  function redraw() {
    view.setBoard(draft);
    view.select(selected);
  }

  // First cell is always Start, last always Finish; others can't be either.
  function fixEnds() {
    const last = draft.cells.length - 1;
    draft.cells.forEach((c, i) => {
      if (i === 0) c.type = 'start';
      else if (i === last) c.type = 'finish';
      else if (c.type === 'start' || c.type === 'finish') c.type = 'empty';
    });
  }

  function changed() {
    fixEnds();
    setDirty(true);
    redraw();
    renderCellForm();
  }

  function addCell(x, y) {
    draft.cells.push({ x, y, type: 'empty', label: '' });
    selected = draft.cells.length - 1;
    changed();
  }

  // Keep jump targets pointing at the same cells after the order changes.
  function remapJumps(map) {
    for (const c of draft.cells) if (c.type === 'jump' && c.to in map) c.to = map[c.to];
  }

  function deleteCell(i) {
    const map = {};
    draft.cells.forEach((_, k) => { if (k > i) map[k] = k - 1; });
    draft.cells.splice(i, 1);
    remapJumps(map);
    selected = Math.min(i, draft.cells.length - 1);
    changed();
  }

  function swapCells(i, j) {
    if (j < 0 || j >= draft.cells.length) return;
    const a = draft.cells[i];
    const b = draft.cells[j];
    [a.x, b.x] = [b.x, a.x];
    [a.y, b.y] = [b.y, a.y];
    draft.cells[i] = b;
    draft.cells[j] = a;
    remapJumps({ [i]: j, [j]: i });
    selected = j;
    changed();
  }

  for (const [id, key] of [['#b-bg', 'bg'], ['#b-cell', 'cell'], ['#b-path', 'path'], ['#b-text', 'text']]) {
    $(id).addEventListener('input', (e) => { draft.theme[key] = e.target.value; setDirty(true); redraw(); });
  }
  $('#b-name').addEventListener('input', (e) => { draft.name = e.target.value; setDirty(true); });
  for (const id of ['#b-cols', '#b-rows']) {
    $(id).addEventListener('change', guard(async () => {
      const cols = Math.max(3, Math.min(20, Number($('#b-cols').value) || 3));
      const rows = Math.max(3, Math.min(20, Number($('#b-rows').value) || 3));
      const outside = draft.cells.filter((c) => c.x >= cols || c.y >= rows).length;
      if (outside && !(await ask({ title: 'Shrink the grid?', body: `${outside} cell(s) fall outside the new size and will be removed.`, ok: 'Shrink', danger: true }))) { fillSettings(); return; }
      draft.cols = cols;
      draft.rows = rows;
      const map = {};
      draft.cells = draft.cells.filter((c, i) => {
        const keep = c.x < cols && c.y < rows;
        if (keep) map[i] = Object.keys(map).length;
        return keep;
      });
      remapJumps(map);
      selected = -1;
      fillSettings();
      changed();
    }));
  }

  $('#btn-snake').addEventListener('click', guard(async () => {
    if (draft.cells.length > 2 && !(await ask({ title: 'Replace the path?', body: 'The path becomes a snake over the whole grid. Cell settings are kept in order.', ok: 'Replace' }))) return;
    const old = draft.cells;
    const cells = [];
    for (let y = 0; y < draft.rows; y++) for (let i = 0; i < draft.cols; i++) cells.push({ x: y % 2 ? draft.cols - 1 - i : i, y });
    draft.cells = cells.map((p, i) => ({ ...(old[i] || { type: 'empty', label: '' }), ...p }));
    selected = -1;
    changed();
  }));
  $('#btn-clear').addEventListener('click', guard(async () => {
    if (!(await ask({ title: 'Remove all cells?', ok: 'Remove', danger: true }))) return;
    draft.cells = [];
    selected = -1;
    changed();
  }));

  $('#btn-new-board').addEventListener('click', guard(async () => {
    if (dirty && !(await ask({ title: 'Discard unsaved changes?', ok: 'Discard', danger: true }))) return;
    openBoard({ id: null, name: 'New board', cols: 6, rows: 6, theme: { bg: '#0f172a', cell: '#1e293b', path: '#334155', text: '#e2e8f0' }, cells: [] });
    setDirty(true);
  }));

  $('#btn-sample').addEventListener('click', guard(async () => {
    const id = newId('b');
    await store.set(`boards/${id}`, { ...demoBoard(), name: 'To the Moon (sample)', updatedAt: Date.now() });
    draft = null;
    toast('Sample board added');
  }));

  $('#btn-save-board').addEventListener('click', guard(async () => {
    // Task options: blank lines are dropped only on save so typing new lines works.
    for (const c of draft.cells) if (c.type === 'task') c.options = c.options.map((o) => o.trim()).filter(Boolean);
    const clean = engine.normalizeBoard(draft);
    const id = draft.id || newId('b');
    await store.set(`boards/${id}`, { ...clean, updatedAt: Date.now() });
    draft.id = id;
    setDirty(false);
    toast('Board saved');
    renderBoardList();
  }));

  $('#btn-delete-board').addEventListener('click', guard(async () => {
    if (!(await ask({ title: `Delete “${draft.name}”?`, body: 'Games already created from it keep their own copy.', ok: 'Delete', danger: true }))) return;
    if (draft.id) await store.del(`boards/${draft.id}`);
    draft = null;
    setDirty(false);
    $('#editor').hidden = true;
  }));

  // ---------- cell form ----------
  const TYPE_OPTIONS = Object.entries(CELL_META).filter(([t]) => t !== 'start' && t !== 'finish');
  const field = (label, html) => `<label>${label}${html}</label>`;
  const rewardFields = (prefix, r = {}) => `<div class="row">
    <label class="grow">Token<input data-k="${prefix}token" value="${esc(r.token || 'GRAM')}" maxlength="10"></label>
    <label class="grow">Amount<input data-k="${prefix}amount" type="number" step="any" min="0" inputmode="decimal" value="${esc(r.amount ?? 1)}"></label></div>`;

  function effectFields(prefix, o) {
    switch (o.kind ?? o.type) {
      case 'prize': return rewardFields(prefix, o);
      case 'move': return field('Steps (negative = back)', `<input data-k="${prefix}steps" type="number" value="${esc(o.steps ?? 2)}">`);
      case 'skip': return field('Rolls to skip', `<input data-k="${prefix}turns" type="number" min="1" max="10" value="${esc(o.turns ?? 1)}">`);
      case 'bonus': return field('Free turns', `<input data-k="${prefix}turns" type="number" min="1" max="10" value="${esc(o.turns ?? 1)}">`);
      default: return '';
    }
  }

  function initType(c, type) {
    const keep = { x: c.x, y: c.y, label: c.label, color: c.color };
    Object.keys(c).forEach((k) => delete c[k]);
    Object.assign(c, keep, { type });
    if (!c.color) delete c.color;
    if (type === 'prize') Object.assign(c, { token: 'GRAM', amount: 1 });
    if (type === 'move') c.steps = 2;
    if (type === 'skip' || type === 'bonus') c.turns = 1;
    if (type === 'jump') c.to = Math.min(draft.cells.length - 1, draft.cells.indexOf(c) + 5);
    if (type === 'task') Object.assign(c, { question: '', options: ['', ''], answer: 0, reward: { token: 'GRAM', amount: 1 }, bonusTurns: 0 });
    if (type === 'chance') c.outcomes = [{ text: 'Lucky find', kind: 'prize', token: 'GRAM', amount: 1 }, { text: 'Stumble', kind: 'move', steps: -2 }];
  }

  function renderCellForm() {
    const form = $('#cell-form');
    const c = draft?.cells[selected];
    if (!c) {
      form.innerHTML = `<p class="muted">Tap a cell to edit it.</p><p class="muted small">${draft ? `${draft.cells.length} cells on the path.` : ''}</p>`;
      return;
    }
    const i = selected;
    const fixed = c.type === 'start' || c.type === 'finish';
    let html = `<h3>${CELL_META[c.type].icon} Cell #${i}</h3>`;
    html += fixed
      ? `<p class="muted small">${CELL_META[c.type].name} cell (its place in the path decides this).</p>`
      : field('Type', `<select data-k="type">${TYPE_OPTIONS.map(([t, m]) => `<option value="${t}" ${t === c.type ? 'selected' : ''}>${m.icon} ${m.name}</option>`).join('')}</select>`);
    html += field('Label (shown on the board)', `<input data-k="label" maxlength="24" value="${esc(c.label)}">`);
    html += `<div class="row"><label class="grow">Custom color<input data-k="color" type="color" value="${esc(c.color || CELL_META[c.type].color || draft.theme.cell)}"></label>
      <label class="check"><input type="checkbox" data-k="useColor" ${c.color ? 'checked' : ''}> use</label></div>`;
    if (['prize', 'move', 'skip', 'bonus'].includes(c.type)) html += effectFields('', c);
    if (c.type === 'jump') html += field(`Jump to cell # (0–${draft.cells.length - 1})`, `<input data-k="to" type="number" min="0" max="${draft.cells.length - 1}" value="${esc(c.to)}">`);
    if (c.type === 'task') {
      html += field('Question', `<textarea data-k="question" rows="2" maxlength="300">${esc(c.question)}</textarea>`);
      html += field('Answer options, one per line', `<textarea data-k="options" rows="4">${esc(c.options.join('\n'))}</textarea>`);
      html += field('Correct option', `<select data-k="answer">${c.options.map((o, k) => `<option value="${k}" ${k === c.answer ? 'selected' : ''}>${String.fromCharCode(65 + k)}. ${esc(o || '(empty)')}</option>`).join('')}</select>`);
      html += `<div class="muted small">Reward for a correct answer</div>${rewardFields('reward.', c.reward)}`;
      html += field('Bonus free turns for a correct answer', `<input data-k="bonusTurns" type="number" min="0" max="10" value="${esc(c.bonusTurns ?? 0)}">`);
    }
    if (c.type === 'chance') {
      html += '<div class="muted small">Outcomes (one is picked at random)</div>';
      html += c.outcomes.map((o, k) => `<div class="outcome" data-o="${k}">
        <div class="row"><label class="grow">Text<input data-k="o.text" value="${esc(o.text)}" maxlength="120"></label>
        <label>Effect<select data-k="o.kind">${['none', 'prize', 'move', 'bonus', 'skip'].map((kind) => `<option value="${kind}" ${kind === o.kind ? 'selected' : ''}>${kind === 'none' ? 'Nothing' : CELL_META[kind].name}</option>`).join('')}</select></label></div>
        ${effectFields('o.', o)}
        <button class="btn btn-sm btn-danger" data-act="del-outcome" type="button" ${c.outcomes.length < 2 ? 'disabled' : ''}>Remove</button></div>`).join('');
      html += '<button class="btn btn-sm" data-act="add-outcome" type="button">+ Outcome</button>';
    }
    html += `<p class="muted small">${esc(describeCell(c))}</p>`;
    html += `<div class="actions">
      <button class="btn btn-sm" data-act="earlier" type="button" ${i === 0 ? 'disabled' : ''}>◀ Earlier</button>
      <button class="btn btn-sm" data-act="later" type="button" ${i === draft.cells.length - 1 ? 'disabled' : ''}>Later ▶</button>
      <button class="btn btn-sm btn-danger" data-act="delete" type="button">Delete cell</button></div>`;
    form.innerHTML = html;

    form.querySelectorAll('[data-k]').forEach((input) => {
      const ev = input.tagName === 'SELECT' || input.type === 'checkbox' || input.type === 'color' ? 'change' : 'input';
      input.addEventListener(ev, () => onField(c, input));
    });
    form.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'delete') deleteCell(i);
      if (act === 'earlier') swapCells(i, i - 1);
      if (act === 'later') swapCells(i, i + 1);
      if (act === 'add-outcome') { c.outcomes.push({ text: '', kind: 'none' }); changed(); }
      if (act === 'del-outcome') { c.outcomes.splice(Number(b.closest('[data-o]').dataset.o), 1); changed(); }
    }));
  }

  function onField(c, input) {
    const k = input.dataset.k;
    const v = input.value;
    const num = (x) => (x === '' ? '' : Number(x));
    let structural = false;
    if (k === 'type') { initType(c, v); structural = true; }
    else if (k === 'label') c.label = v;
    else if (k === 'color' || k === 'useColor') {
      const form = input.closest('.cell-form');
      const box = $('[data-k="useColor"]', form);
      if (k === 'color') box.checked = true;
      if (box.checked) c.color = $('[data-k="color"]', form).value; else delete c.color;
    } else if (k === 'options') {
      c.options = v.split('\n');
      if (c.answer >= c.options.length) c.answer = 0;
      structural = 'form';
    } else if (k === 'question') c.question = v;
    else if (k === 'answer') c.answer = Number(v);
    else if (['bonusTurns', 'to', 'steps', 'turns', 'amount'].includes(k)) c[k] = num(v);
    else if (k === 'token') c.token = v.toUpperCase();
    else if (k.startsWith('reward.')) c.reward[k.slice(7)] = k.endsWith('token') ? v.toUpperCase() : num(v);
    else if (k.startsWith('o.')) {
      const o = c.outcomes[Number(input.closest('[data-o]').dataset.o)];
      const f = k.slice(2);
      if (f === 'kind') {
        for (const key of ['token', 'amount', 'steps', 'turns']) delete o[key];
        o.kind = v;
        if (v === 'prize') Object.assign(o, { token: 'GRAM', amount: 1 });
        if (v === 'move') o.steps = 2;
        if (v === 'skip' || v === 'bonus') o.turns = 1;
        structural = 'form';
      } else o[f] = f === 'text' ? v : f === 'token' ? v.toUpperCase() : num(v);
    }
    setDirty(true);
    if (structural === true) { changed(); return; }
    redraw();
    if (structural === 'form') {
      // Re-render the form but keep focus in the textarea being typed into.
      const focusKey = document.activeElement?.dataset?.k;
      const pos = document.activeElement?.selectionStart;
      renderCellForm();
      const again = focusKey && $(`#cell-form [data-k="${focusKey}"]`);
      if (again && again.tagName === 'TEXTAREA') { again.focus(); again.setSelectionRange(pos, pos); }
    }
  }

  // ================= GAMES =================
  async function mutateGame(id, fn) {
    const path = `games/${id}`;
    await store.lock(path);
    const g = await store.get(path);
    if (!g) throw new Error('Game not found');
    fn(g);
    await store.set(path, g);
  }

  function renderGames() {
    const sel = $('#ng-board');
    const prev = sel.value;
    sel.innerHTML = boards.map((b) => `<option value="${esc(b.id)}">${esc(b.name)} (${b.cells.length} cells)</option>`).join('') || '<option value="">Create a board first</option>';
    if (boards.some((b) => b.id === prev)) sel.value = prev;
    const list = games.slice().sort((a, b) => b.createdAt - a.createdAt);
    $('#game-admin-list').innerHTML = list.map((g) => `
      <div class="panel game-row">
        <div class="row"><h3 class="grow">${esc(g.name)}</h3><span class="pill ${g.status}">${g.status}</span></div>
        <div class="muted small">${esc(g.board.name)} · turn ${fmt(g.turnPrice)} GRAM · ${g.players.length}/${g.maxPlayers} players · ends after ${g.endAfter} finisher(s)${g.finishPrizes.length ? ` · prizes ${g.finishPrizes.map((p, i) => `#${i + 1} ${fmt(p.amount)} ${esc(p.token)}`).join(', ')}` : ''}</div>
        <div class="table-scroll"><table class="table">${g.players.length ? `<tr><th>Player</th><th>Cell</th><th>Turns</th><th>Place</th><th>Prizes</th></tr>${g.players.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.pos}</td><td>${p.turns}${p.freeTurns ? ` <span class="muted">+${p.freeTurns} free</span>` : ''}</td><td>${p.place || ''}</td><td>${tok(p.prizes)}</td></tr>`).join('')}` : '<tr><td class="muted">No players yet</td></tr>'}</table></div>
        <div class="row">
          ${g.status === 'lobby' ? `<button class="btn btn-sm btn-primary" data-act="start" data-id="${esc(g.id)}" type="button">Start</button>` : ''}
          ${g.status !== 'finished' ? `<button class="btn btn-sm" data-act="end" data-id="${esc(g.id)}" type="button">End game &amp; release prizes</button>` : ''}
          ${g.status === 'finished' || !g.players.length ? `<button class="btn btn-sm btn-danger" data-act="delete" data-id="${esc(g.id)}" type="button">Delete</button>` : ''}
          <button class="btn btn-sm" data-act="watch" data-id="${esc(g.id)}" type="button">Open</button>
        </div>
      </div>`).join('') || '<div class="panel muted">No games yet.</div>';
    $('#game-admin-list').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', guard(async () => {
      const { act, id } = b.dataset;
      if (act === 'watch') return openGame(id);
      if (act === 'start') await mutateGame(id, (g) => engine.startGame(g));
      if (act === 'end') {
        if (!(await ask({ title: 'End this game now?', body: 'Unused turns are refunded and prizes become withdrawable.', ok: 'End game', danger: true }))) return;
        await mutateGame(id, (g) => engine.endGame(g, 'The organizer ended the game — prizes can now be withdrawn'));
      }
      if (act === 'delete') {
        if (!(await ask({ title: 'Delete this game?', ok: 'Delete', danger: true }))) return;
        await store.del(`games/${id}`);
      }
    })));
  }

  $('#form-game').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const board = boards.find((b) => b.id === $('#ng-board').value);
    if (!board) throw new Error('Create and save a board first');
    const finishPrizes = $('#ng-prizes').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [token, amount] = l.split(/\s+/);
      return { token: (token || '').toUpperCase(), amount: Number(amount) };
    });
    const id = newId('g');
    const game = engine.newGame({
      id, name: $('#ng-name').value, board,
      turnPrice: Number($('#ng-price').value), maxPlayers: Number($('#ng-max').value), endAfter: Number($('#ng-end').value), finishPrizes,
    });
    game.boardId = board.id;
    if ($('#ng-start').checked) engine.startGame(game);
    await store.set(`games/${id}`, game);
    $('#ng-name').value = '';
    toast('Game created');
  }));

  // ================= PLAYERS =================
  function renderPlayers() {
    const locked = (uid) => {
      const out = {};
      for (const g of games) {
        if (g.status === 'finished') continue;
        const p = g.players.find((x) => x.userId === uid);
        for (const [t, v] of Object.entries(p?.prizes || {})) out[t] = amt((out[t] || 0) + v);
      }
      return out;
    };
    $('#users-table').innerHTML = wallets.length
      ? `<tr><th>Name</th><th>GRAM</th><th>Prizes in play</th><th>Withdrawable</th><th>Adjust GRAM</th></tr>${wallets.map((w) => `
        <tr><td>${esc(w.name)}</td><td class="gram">${fmt(w.gram)}</td><td>${tok(locked(w.id))}</td><td>${tok(w.prizes)}</td>
        <td><div class="row"><input type="number" step="any" placeholder="±amount" inputmode="decimal" id="grant-${esc(w.id)}" aria-label="GRAM adjustment for ${esc(w.name)}"><button class="btn btn-sm" data-grant="${esc(w.id)}" type="button">Apply</button></div></td></tr>`).join('')}`
      : '<tr><td class="muted">No players yet</td></tr>';
    $('#users-table').querySelectorAll('[data-grant]').forEach((b) => b.addEventListener('click', guard(async () => {
      const uid = b.dataset.grant;
      const n = amt(document.getElementById(`grant-${uid}`).value);
      if (!Number.isFinite(n) || n === 0) throw new Error('Enter a non-zero amount');
      const path = `wallets/${uid}`;
      await store.lock(path);
      const w = await store.get(path);
      if (w.gram + n < 0) throw new Error('Balance cannot go below zero');
      w.gram = amt(w.gram + n);
      ledgerAdd(w, 'admin_grant', n);
      await store.set(path, w);
      toast('Balance updated');
    })));
  }

  // ================= WITHDRAWALS =================
  function renderWithdrawals() {
    const list = withdrawals.slice().sort((a, b) => b.at - a.at);
    $('#wd-table').innerHTML = list.length
      ? `<tr><th>Date</th><th>Player</th><th>Amount</th><th>Address</th><th>Status</th><th></th></tr>${list.map((w) => `
        <tr><td>${new Date(w.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(w.userName)}</td><td>${fmt(w.amount)} ${esc(w.token)}</td>
        <td class="addr">${esc(w.address)}</td><td>${esc(w.status)}${w.txHash ? `<br><span class="addr">${esc(w.txHash)}</span>` : ''}</td>
        <td>${w.status === 'pending' ? `<div class="row"><button class="btn btn-sm btn-primary" data-paid="${esc(w.id)}" type="button">Mark paid</button><button class="btn btn-sm btn-danger" data-reject="${esc(w.id)}" type="button">Reject</button></div>` : ''}</td></tr>`).join('')}`
      : '<tr><td class="muted">No withdrawal requests</td></tr>';
    $('#wd-table').querySelectorAll('[data-paid]').forEach((b) => b.addEventListener('click', guard(async () => {
      const txHash = await ask({ title: 'Mark as paid', body: 'Paste the transaction hash (optional).', ok: 'Mark paid', input: { placeholder: 'Transaction hash' } });
      if (txHash === null) return;
      const path = `withdrawals/${b.dataset.paid}`;
      const w = await store.get(path);
      if (w.status !== 'pending') throw new Error('Already processed');
      await store.set(path, { ...w, status: 'paid', txHash: txHash.trim().slice(0, 100), processedAt: Date.now() });
    })));
    $('#wd-table').querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', guard(async () => {
      if (!(await ask({ title: 'Reject this withdrawal?', body: 'The tokens go back to the player’s wallet.', ok: 'Reject', danger: true }))) return;
      const path = `withdrawals/${b.dataset.reject}`;
      const w = await store.get(path);
      if (w.status !== 'pending') throw new Error('Already processed');
      await store.set(path, { ...w, status: 'rejected', processedAt: Date.now() });
      const wp = `wallets/${w.userId}`;
      await store.lock(wp);
      const wallet = await store.get(wp);
      if (wallet) {
        wallet.prizes[w.token] = amt((wallet.prizes[w.token] || 0) + w.amount);
        ledgerAdd(wallet, 'withdraw_returned', w.amount, { token: w.token });
        await store.set(wp, wallet);
      }
    })));
  }

  return {
    show,
    gamesChanged(list) { games = list; if (tab === 'games' && !$('#view-admin').hidden) renderGames(); },
    withdrawalsChanged(list) { withdrawals = list; if (tab === 'withdrawals' && !$('#view-admin').hidden) renderWithdrawals(); },
  };
}
