import { createBoardView, CELL_META, describeCell } from '../shared/board.js';

const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 9 });
const tokens = (obj) => Object.entries(obj || {}).filter(([, v]) => v).map(([t, v]) => `${fmt(v)} ${esc(t)}`).join(', ') || '—';

let adminToken = localStorage.getItem('dg_admin') || '';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': adminToken },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Wrong admin token'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, error = false) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast${error ? ' error' : ''}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), error ? 6000 : 3000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

// ---------- auth & tabs ----------
function logout() {
  adminToken = '';
  localStorage.removeItem('dg_admin');
  $('#login').hidden = false;
  $('#tabs').hidden = true;
  $('#btn-logout').hidden = true;
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = true; });
}

$('#form-login').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  adminToken = $('#admin-token').value;
  await api('/boards');
  localStorage.setItem('dg_admin', adminToken);
  enter();
}));
$('#btn-logout').addEventListener('click', logout);

let currentTab = 'boards';
const loaders = { boards: () => loadBoards(), games: () => loadGames(), users: () => loadUsers(), withdrawals: () => loadWithdrawals() };
function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${tab}`; });
  guard(loaders[tab])();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  if (currentTab === 'boards' && dirty && !confirm('Discard unsaved board changes?')) return;
  if (currentTab === 'boards') dirty = false;
  showTab(b.dataset.tab);
}));

function enter() {
  $('#login').hidden = true;
  $('#tabs').hidden = false;
  $('#btn-logout').hidden = false;
  showTab(currentTab);
}

// ================= BOARDS =================
let boards = [];
let draft = null; // board being edited (unsaved copy)
let selected = -1;
let dirty = false;
const view = createBoardView($('#b-canvas'), {
  editable: true,
  onCellClick: (i) => { selected = i; view.select(i); renderCellForm(); },
  onEmptyClick: (x, y) => addCell(x, y),
});

window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

async function loadBoards(selectId) {
  boards = await api('/boards');
  const want = selectId || draft?.id;
  $('#board-list').innerHTML = boards.map((b) => `<li><button data-id="${b.id}" class="${b.id === want ? 'active' : ''}">${esc(b.name)}<br><span class="muted small">${b.cols}×${b.rows} · ${b.cells.length} cells</span></button></li>`).join('') || '<li class="muted small">No boards yet</li>';
  $('#board-list').querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    openBoard(boards.find((b) => b.id === btn.dataset.id));
  }));
  if (!dirty) {
    const b = boards.find((x) => x.id === want) || boards[0];
    if (b) openBoard(b); else $('#editor').hidden = true;
  }
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
  $(id).addEventListener('change', () => {
    const cols = Math.max(3, Math.min(20, Number($('#b-cols').value) || 3));
    const rows = Math.max(3, Math.min(20, Number($('#b-rows').value) || 3));
    const outside = draft.cells.filter((c) => c.x >= cols || c.y >= rows).length;
    if (outside && !confirm(`${outside} cell(s) fall outside the new size and will be removed. Continue?`)) { fillSettings(); return; }
    draft.cols = cols;
    draft.rows = rows;
    const map = {};
    const kept = draft.cells.filter((c, i) => {
      const keep = c.x < cols && c.y < rows;
      if (keep) map[i] = Object.keys(map).length;
      return keep;
    });
    draft.cells = kept;
    remapJumps(map);
    selected = -1;
    fillSettings();
    changed();
  });
}

$('#btn-snake').addEventListener('click', () => {
  if (draft.cells.length > 2 && !confirm('Replace the current path with a snake path over the whole grid? Cell settings are kept in order.')) return;
  const old = draft.cells;
  const cells = [];
  for (let y = 0; y < draft.rows; y++) for (let i = 0; i < draft.cols; i++) cells.push({ x: y % 2 ? draft.cols - 1 - i : i, y });
  draft.cells = cells.map((p, i) => ({ ...(old[i] || { type: 'empty', label: '' }), ...p }));
  selected = -1;
  changed();
});
$('#btn-clear').addEventListener('click', () => {
  if (!confirm('Remove all cells?')) return;
  draft.cells = [];
  selected = -1;
  changed();
});

$('#btn-new-board').addEventListener('click', () => {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  openBoard({ id: null, name: 'New board', cols: 8, rows: 6, theme: { bg: '#0f172a', cell: '#1e293b', path: '#334155', text: '#e2e8f0' }, cells: [] });
  setDirty(true);
});

$('#btn-save-board').addEventListener('click', guard(async () => {
  // Task options: blank lines are dropped only on save so typing new lines works.
  for (const c of draft.cells) if (c.type === 'task') c.options = c.options.map((o) => o.trim()).filter(Boolean);
  const body = { ...draft };
  const saved = draft.id ? await api(`/boards/${draft.id}`, { method: 'PUT', body }) : await api('/boards', { method: 'POST', body });
  setDirty(false);
  draft.id = saved.id;
  toast('Board saved');
  await loadBoards(saved.id);
}));

$('#btn-delete-board').addEventListener('click', guard(async () => {
  if (!confirm(`Delete board “${draft.name}”? Games already created from it keep their copy.`)) return;
  if (draft.id) await api(`/boards/${draft.id}`, { method: 'DELETE' });
  draft = null;
  setDirty(false);
  await loadBoards();
}));

// ---------- cell form ----------
const TYPE_OPTIONS = Object.entries(CELL_META).filter(([t]) => t !== 'start' && t !== 'finish');

function field(label, html) { return `<label>${label}${html}</label>`; }
function rewardFields(prefix, r = {}) {
  return `<div class="row">
    <label class="grow">Token<input data-k="${prefix}token" value="${esc(r.token || 'GRAM')}" maxlength="10"></label>
    <label class="grow">Amount<input data-k="${prefix}amount" type="number" step="any" min="0" value="${esc(r.amount ?? 1)}"></label></div>`;
}

function effectFields(prefix, o) {
  switch (o.kind ?? o.type) {
    case 'prize': return rewardFields(prefix, o);
    case 'move': return field('Steps (negative = back)', `<input data-k="${prefix}steps" type="number" value="${esc(o.steps ?? 2)}">`);
    case 'skip': return field('Rolls to skip', `<input data-k="${prefix}turns" type="number" min="1" max="10" value="${esc(o.turns ?? 1)}">`);
    case 'bonus': return field('Free turns', `<input data-k="${prefix}turns" type="number" min="1" max="10" value="${esc(o.turns ?? 1)}">`);
    default: return '';
  }
}

// Sensible defaults when a cell becomes a new type.
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
    form.innerHTML = `<p class="muted">Select a cell to edit it.</p><p class="muted small">${draft ? `${draft.cells.length} cells on the path.` : ''}</p>`;
    return;
  }
  const i = selected;
  const fixed = c.type === 'start' || c.type === 'finish';
  let html = `<h3>${CELL_META[c.type].icon} Cell #${i}</h3>`;
  html += fixed
    ? `<p class="muted small">${CELL_META[c.type].name} cell (position in the path decides this).</p>`
    : field('Type', `<select data-k="type">${TYPE_OPTIONS.map(([t, m]) => `<option value="${t}" ${t === c.type ? 'selected' : ''}>${m.icon} ${m.name}</option>`).join('')}</select>`);
  html += field('Label (shown on the board)', `<input data-k="label" maxlength="24" value="${esc(c.label)}">`);
  html += `<div class="row"><label class="grow">Custom color<input data-k="color" type="color" value="${esc(c.color || CELL_META[c.type].color || draft.theme.cell)}"></label>
    <label class="check"><input type="checkbox" data-k="useColor" ${c.color ? 'checked' : ''}> use</label></div>`;

  if (['prize', 'move', 'skip', 'bonus'].includes(c.type)) html += effectFields('', c);
  if (c.type === 'jump') html += field(`Jump to cell # (0–${draft.cells.length - 1})`, `<input data-k="to" type="number" min="0" max="${draft.cells.length - 1}" value="${esc(c.to)}">`);
  if (c.type === 'task') {
    html += field('Question', `<textarea data-k="question" rows="2" maxlength="300">${esc(c.question)}</textarea>`);
    html += field('Answer options — one per line', `<textarea data-k="options" rows="4">${esc(c.options.join('\n'))}</textarea>`);
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
      <button class="btn btn-sm btn-danger" data-act="del-outcome" ${c.outcomes.length < 2 ? 'disabled' : ''}>Remove</button></div>`).join('');
    html += '<button class="btn btn-sm" data-act="add-outcome">+ Outcome</button>';
  }
  html += `<p class="muted small">${esc(describeCell(c))}</p>`;
  html += `<div class="actions">
    <button class="btn btn-sm" data-act="earlier" ${i === 0 ? 'disabled' : ''}>◀ Earlier</button>
    <button class="btn btn-sm" data-act="later" ${i === draft.cells.length - 1 ? 'disabled' : ''}>Later ▶</button>
    <button class="btn btn-sm btn-danger" data-act="delete">Delete cell</button></div>`;
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
    const box = $('[data-k="useColor"]', input.closest('.cell-form'));
    if (k === 'color') box.checked = true;
    if (box.checked) c.color = $('[data-k="color"]', input.closest('.cell-form')).value; else delete c.color;
  } else if (k === 'options') {
    c.options = v.split('\n');
    if (c.answer >= c.options.length) c.answer = 0;
    structural = 'form';
  } else if (k === 'question') c.question = v;
  else if (k === 'answer') c.answer = Number(v);
  else if (k === 'bonusTurns' || k === 'to' || k === 'steps' || k === 'turns' || k === 'amount') c[k] = num(v);
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
  if (structural === true) changed();
  else {
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
}

// ================= GAMES =================
async function loadGames() {
  const [games, bs] = await Promise.all([api('/games'), api('/boards')]);
  $('#ng-board').innerHTML = bs.map((b) => `<option value="${b.id}">${esc(b.name)} (${b.cells.length} cells)</option>`).join('');
  $('#game-admin-list').innerHTML = games.map((g) => `
    <div class="panel game-row">
      <div class="row"><h3 class="grow">${esc(g.name)}</h3><span class="pill ${g.status}">${g.status}</span></div>
      <div class="muted small">${esc(g.boardName)} · turn ${fmt(g.turnPrice)} GRAM · ${g.players}/${g.maxPlayers} players · ends after ${g.endAfter} finisher(s)
        ${g.finishPrizes.length ? ` · prizes ${g.finishPrizes.map((p, i) => `#${i + 1} ${fmt(p.amount)} ${esc(p.token)}`).join(', ')}` : ''}</div>
      <table class="table players">${g.playerList.length ? `<tr><th>Player</th><th>Cell</th><th>Turns</th><th>Place</th><th>Prizes</th></tr>${g.playerList.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.pos}</td><td>${p.turns}${p.freeTurns ? ` <span class="muted">+${p.freeTurns} free</span>` : ''}</td><td>${p.place || ''}</td><td>${tokens(p.prizes)}</td></tr>`).join('')}` : '<tr><td class="muted">No players yet</td></tr>'}</table>
      <div class="row">
        ${g.status === 'lobby' ? `<button class="btn btn-sm btn-primary" data-act="start" data-id="${g.id}">Start</button>` : ''}
        ${g.status !== 'finished' ? `<button class="btn btn-sm" data-act="end" data-id="${g.id}">End game &amp; release prizes</button>` : ''}
        ${g.status === 'finished' || !g.players ? `<button class="btn btn-sm btn-danger" data-act="delete" data-id="${g.id}">Delete</button>` : ''}
        <a class="btn btn-sm" href="/#/game/${g.id}" target="_blank" rel="noopener">Watch</a>
      </div>
    </div>`).join('') || '<div class="panel muted">No games yet.</div>';
  $('#game-admin-list').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', guard(async () => {
    const { act, id } = b.dataset;
    if (act === 'end' && !confirm('End this game now? Unused turns are refunded and prizes become withdrawable.')) return;
    if (act === 'delete' && !confirm('Delete this game?')) return;
    if (act === 'delete') await api(`/games/${id}`, { method: 'DELETE' });
    else await api(`/games/${id}/${act}`, { method: 'POST' });
    await loadGames();
  })));
}

$('#form-game').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const finishPrizes = $('#ng-prizes').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [token, amount] = l.split(/\s+/);
    return { token: (token || '').toUpperCase(), amount: Number(amount) };
  });
  const g = await api('/games', { method: 'POST', body: {
    name: $('#ng-name').value, boardId: $('#ng-board').value, turnPrice: Number($('#ng-price').value),
    maxPlayers: Number($('#ng-max').value), endAfter: Number($('#ng-end').value), finishPrizes,
  } });
  if ($('#ng-start').checked) await api(`/games/${g.id}/start`, { method: 'POST' });
  $('#ng-name').value = '';
  toast('Game created');
  await loadGames();
}));

// ================= PLAYERS =================
async function loadUsers() {
  const users = await api('/users');
  $('#users-table').innerHTML = users.length
    ? `<tr><th>Name</th><th>GRAM</th><th>Prizes in play</th><th>Withdrawable</th><th>Adjust GRAM</th></tr>${users.map((u) => `
      <tr><td>${esc(u.name)}</td><td class="gram">${fmt(u.gram)}</td><td>${tokens(u.locked)}</td><td>${tokens(u.prizes)}</td>
      <td><div class="row"><input type="number" step="any" placeholder="±amount" data-id="${u.id}"><button class="btn btn-sm" data-grant="${u.id}">Apply</button></div></td></tr>`).join('')}`
    : '<tr><td class="muted">No players yet</td></tr>';
  $('#users-table').querySelectorAll('[data-grant]').forEach((b) => b.addEventListener('click', guard(async () => {
    const amount = Number($(`input[data-id="${b.dataset.grant}"]`).value);
    await api(`/users/${b.dataset.grant}/grant`, { method: 'POST', body: { amount } });
    toast('Balance updated');
    await loadUsers();
  })));
}

// ================= WITHDRAWALS =================
async function loadWithdrawals() {
  const list = await api('/withdrawals');
  $('#wd-table').innerHTML = list.length
    ? `<tr><th>Date</th><th>Player</th><th>Amount</th><th>Address</th><th>Status</th><th></th></tr>${list.map((w) => `
      <tr><td>${new Date(w.at).toLocaleString()}</td><td>${esc(w.userName)}</td><td>${fmt(w.amount)} ${esc(w.token)}</td>
      <td class="addr">${esc(w.address)}</td><td>${esc(w.status)}${w.txHash ? `<br><span class="addr">${esc(w.txHash)}</span>` : ''}</td>
      <td>${w.status === 'pending' ? `<div class="row"><button class="btn btn-sm btn-primary" data-paid="${w.id}">Mark paid</button><button class="btn btn-sm btn-danger" data-reject="${w.id}">Reject</button></div>` : ''}</td></tr>`).join('')}`
    : '<tr><td class="muted">No withdrawal requests</td></tr>';
  $('#wd-table').querySelectorAll('[data-paid]').forEach((b) => b.addEventListener('click', guard(async () => {
    const txHash = prompt('Transaction hash (optional):', '');
    if (txHash === null) return;
    await api(`/withdrawals/${b.dataset.paid}`, { method: 'POST', body: { status: 'paid', txHash } });
    await loadWithdrawals();
  })));
  $('#wd-table').querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', guard(async () => {
    if (!confirm('Reject and return the tokens to the player?')) return;
    await api(`/withdrawals/${b.dataset.reject}`, { method: 'POST', body: { status: 'rejected' } });
    await loadWithdrawals();
  })));
}

// ---------- boot ----------
if (adminToken) guard(async () => { await api('/boards'); enter(); })(); else logout();
