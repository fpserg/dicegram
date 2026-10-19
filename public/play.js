import { createBoardView, CELL_META } from './shared/board.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 9 });
const tokens = (obj) => Object.entries(obj || {}).filter(([, v]) => v).map(([t, v]) => `${fmt(v)} ${esc(t)}`).join(', ');
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

const state = { token: localStorage.getItem('dg_token'), me: null, config: null, game: null, stream: null, view: null };

// ---------- api ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) { signOut(); throw new Error('Please sign in again'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast${error ? ' error' : ''}`;
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3500);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function setMe(data) {
  if (!data?.user) return;
  state.me = data;
  $('#account').hidden = false;
  $('#me-name').textContent = data.user.name;
  $('#me-gram').textContent = fmt(data.user.gram);
  if (state.view === 'wallet') renderWallet();
  if (state.game) renderControls();
}

function signOut() {
  localStorage.removeItem('dg_token');
  state.token = null;
  state.me = null;
  $('#account').hidden = true;
  route();
}

// ---------- routing ----------
function show(view) {
  state.view = view;
  for (const v of ['auth', 'lobby', 'game', 'wallet']) $(`#view-${v}`).hidden = v !== view;
}

async function route() {
  if (state.stream && !location.hash.startsWith('#/game/')) { state.stream.close(); state.stream = null; state.game = null; }
  if (!state.token) return show('auth');
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/game\/(.+)$/);
  if (m) return openGame(m[1]);
  if (hash === '#/wallet') { show('wallet'); renderWallet(); return; }
  show('lobby');
  loadLobby();
}
window.addEventListener('hashchange', guard(route));

// ---------- auth ----------
$('#form-register').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const data = await api('/register', { method: 'POST', body: { name: $('#reg-name').value } });
  state.token = data.token;
  localStorage.setItem('dg_token', data.token);
  setMe(data);
  if (state.config.devFaucet) toast('Welcome! Tap “+ Test GRAM” to fund your balance.');
  route();
}));

// ---------- wallet / faucet ----------
const faucet = guard(async (amount) => {
  setMe(await api('/wallet/faucet', { method: 'POST', body: { amount } }));
  toast(`+${amount} test GRAM added`);
});
$('#btn-faucet').addEventListener('click', () => faucet(10));
document.querySelectorAll('[data-faucet]').forEach((b) => b.addEventListener('click', () => faucet(Number(b.dataset.faucet))));
$('#btn-wallet').addEventListener('click', () => { location.hash = '#/wallet'; });

const LEDGER_NAMES = { faucet: 'Test top-up', buy_turns: 'Bought turns', refund: 'Refund', prize: 'Prize released', withdraw: 'Withdrawal', withdraw_returned: 'Withdrawal returned', admin_grant: 'Admin adjustment' };

function renderWallet() {
  const d = state.me;
  if (!d) return;
  $('#w-gram').textContent = fmt(d.user.gram);
  $('#w-locked').innerHTML = tokens(d.user.locked) || '<span class="muted">—</span>';
  $('#w-prizes').innerHTML = tokens(d.user.prizes) || '<span class="muted">—</span>';
  $('#w-faucet').hidden = !state.config.devFaucet;

  const avail = Object.entries(d.user.prizes).filter(([, v]) => v > 0);
  const sel = $('#wd-token');
  const prev = sel.value;
  sel.innerHTML = avail.length ? avail.map(([t, v]) => `<option value="${esc(t)}">${esc(t)} (max ${fmt(v)})</option>`).join('') : '<option value="">No prizes yet</option>';
  if (avail.some(([t]) => t === prev)) sel.value = prev;
  $('#btn-withdraw').disabled = !avail.length;

  $('#w-withdrawals').innerHTML = d.withdrawals.length
    ? `<tr><th>Date</th><th>Amount</th><th>To</th><th>Status</th></tr>${d.withdrawals.map((w) => `<tr><td>${new Date(w.at).toLocaleString()}</td><td>${fmt(w.amount)} ${esc(w.token)}</td><td class="addr">${esc(w.address)}</td><td>${esc(w.status)}${w.txHash ? `<br><span class="addr">${esc(w.txHash)}</span>` : ''}</td></tr>`).join('')}`
    : '';
  $('#w-ledger').innerHTML = d.ledger.length
    ? `<tr><th>Date</th><th>What</th><th>Amount</th></tr>${d.ledger.map((t) => `<tr><td>${new Date(t.at).toLocaleString()}</td><td>${esc(LEDGER_NAMES[t.type] || t.type)}${t.note ? ` <span class="muted">· ${esc(t.note)}</span>` : ''}</td><td class="${t.amount >= 0 ? 'pos' : 'neg'}">${t.amount >= 0 ? '+' : ''}${fmt(t.amount)} ${esc(t.token || 'GRAM')}</td></tr>`).join('')}`
    : '<tr><td class="muted">No transactions yet</td></tr>';
}

$('#form-withdraw').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  setMe(await api('/withdrawals', { method: 'POST', body: { token: $('#wd-token').value, amount: Number($('#wd-amount').value), address: $('#wd-address').value } }));
  $('#wd-amount').value = '';
  toast('Withdrawal requested — it will be sent after review');
}));

// ---------- lobby ----------
const loadLobby = guard(async () => {
  const games = await api('/games');
  $('#game-list').innerHTML = games.length
    ? games.map((g) => `
      <div class="panel game-card">
        <div class="row"><h3 class="grow">${esc(g.name)}</h3><span class="pill ${g.status}">${g.status}</span></div>
        <div class="muted small">Board “${esc(g.boardName)}” · ${g.cells} cells · ${g.players}/${g.maxPlayers} players</div>
        <div class="small">Turn price <span class="gram">${fmt(g.turnPrice)} GRAM</span>${g.finishPrizes.length ? ` · Finish prize: ${g.finishPrizes.map((p, i) => `#${i + 1} ${fmt(p.amount)} ${esc(p.token)}`).join(', ')}` : ''}</div>
        <a class="btn ${g.status === 'finished' ? '' : 'btn-primary'}" href="#/game/${g.id}">${g.status === 'finished' ? 'View results' : 'Open'}</a>
      </div>`).join('')
    : '<div class="panel empty muted">No games yet — ask the admin to create one.</div>';
});
$('#btn-refresh').addEventListener('click', loadLobby);

// ---------- game ----------
const boardView = createBoardView($('#board'));
let boardKey = null;
let lastSeq = -1;

async function openGame(id) {
  show('game');
  if (state.game?.id === id && state.stream) return;
  state.stream?.close();
  state.game = null;
  boardKey = null;
  lastSeq = -1;
  const game = await api(`/games/${id}`).catch((e) => { toast(e.message, true); location.hash = '#/'; });
  if (!game) return;
  applyGame(game, false);
  const es = new EventSource(`/api/games/${id}/stream`);
  es.onmessage = (ev) => applyGame(JSON.parse(ev.data));
  state.stream = es;
}

const myPlayer = () => state.game?.players.find((p) => p.userId === state.me?.user.id);

function applyGame(game, animate = true) {
  const prev = state.game;
  state.game = game;
  const key = `${game.id}:${game.board.updatedAt}:${game.board.cells.length}`;
  if (key !== boardKey) { boardView.setBoard(game.board); boardKey = key; renderLegend(); }
  const fresh = game.lastMove && game.lastMove.seq > lastSeq;
  boardView.setPlayers(game.players, { lastMove: fresh && animate ? game.lastMove : null, me: state.me?.user.id });
  if (game.lastMove) lastSeq = Math.max(lastSeq, game.lastMove.seq);
  if (fresh && animate && game.lastMove.userId !== state.me?.user.id) showDie(game.lastMove.value, false);

  $('#g-name').textContent = game.name;
  $('#g-status').textContent = game.status;
  $('#g-status').className = `pill ${game.status}`;
  $('#g-meta').innerHTML = `${esc(game.board.name)} · ${game.board.cells.length} cells · turn = <span class="gram">${fmt(game.turnPrice)} GRAM</span>`
    + (game.finishPrizes.length ? `<br>Finish prizes: ${game.finishPrizes.map((p, i) => `#${i + 1} ${fmt(p.amount)} ${esc(p.token)}`).join(' · ')}` : '')
    + `<br>Ends when ${game.endAfter === 1 ? 'the first player finishes' : `${game.endAfter} players finish`}.`;

  $('#g-players').innerHTML = game.players.map((p) => `
    <li><span class="dot" style="background:${esc(p.color)}"></span>
      <span>${esc(p.name)}${p.userId === state.me?.user.id ? ' <span class="me-tag">(you)</span>' : ''}<br>
      <span class="muted small">cell ${p.pos}${p.place ? ` · 🏆 #${p.place}` : ''}${p.frozen ? ' · ⛔ skipping' : ''}</span></span>
      <span class="tokens">${tokens(p.prizes) || '<span class="muted">no prizes</span>'}</span></li>`).join('') || '<li class="muted">Nobody has joined yet</li>';
  $('#g-log').innerHTML = game.log.slice().reverse().map((l) => `<li>${esc(l.text)}</li>`).join('');

  renderControls();
  const me = myPlayer();
  if (prev && prev.status !== 'finished' && game.status === 'finished') {
    toast(me ? 'Game over! Your prizes are now in your wallet and unused turns were refunded.' : 'Game over!');
    refreshMe();
  }
}

const refreshMe = guard(async () => setMe(await api('/me')));

function renderLegend() {
  const used = [...new Set(state.game.board.cells.map((c) => c.type))].filter((t) => t !== 'empty');
  $('#g-legend').innerHTML = used.map((t) => `<li>${CELL_META[t].icon} ${CELL_META[t].name}</li>`).join('');
}

function renderControls() {
  const g = state.game;
  if (!g || !state.me) return;
  const me = myPlayer();
  const canJoin = !me && g.status !== 'finished' && g.players.length < g.maxPlayers;
  $('#g-join').hidden = !canJoin;
  $('#g-controls').hidden = !me;
  if (!me) return;
  const total = me.turns + me.freeTurns;
  $('#g-turns').textContent = total;
  const n = Math.max(1, Math.min(100, Number($('#buy-count').value) || 1));
  const cost = n * g.turnPrice;
  $('#btn-buy').textContent = `Buy ${n} turn${n > 1 ? 's' : ''} · ${fmt(cost)} GRAM`;
  $('#btn-buy').disabled = g.status === 'finished' || !!me.place || state.me.user.gram < cost;

  let note = '';
  if (g.status === 'lobby') note = 'Waiting for the admin to start the game. You can buy turns now.';
  else if (g.status === 'finished') note = me.place ? `You finished #${me.place}. Prizes are in your wallet.` : 'This game is over. Prizes are in your wallet.';
  else if (me.place) note = `You reached the finish (#${me.place}). Waiting for the game to end.`;
  else if (me.pendingTask !== null) note = 'Solve your task to continue.';
  else if (!total) note = state.me.user.gram < g.turnPrice ? 'No turns and not enough GRAM — top up your wallet.' : 'Buy turns to roll the dice.';
  else if (me.frozen) note = `⛔ Your next ${me.frozen > 1 ? `${me.frozen} rolls are` : 'roll is'} skipped.`;
  if (me.freeTurns) note = `${note ? `${note} ` : ''}Includes ${me.freeTurns} free turn${me.freeTurns > 1 ? 's' : ''}.`;
  $('#g-note').textContent = note;
  $('#btn-roll').disabled = rolling || g.status !== 'running' || !!me.place || me.pendingTask !== null || !total;

  const modal = $('#task-modal');
  if (g.status === 'running' && me.pendingTask !== null && !rolling) openTask(g.board.cells[me.pendingTask]);
  else modal.hidden = true;
}

function showDie(value, spin = true) {
  const d = $('#dice');
  d.innerHTML = Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[value]?.includes(i) ? 'on' : ''}"></i>`).join('');
  d.setAttribute('aria-label', `Die shows ${value}`);
  if (spin) { d.classList.remove('rolling'); void d.offsetWidth; d.classList.add('rolling'); }
}
showDie(6, false);

let rolling = false;
$('#btn-roll').addEventListener('click', guard(async () => {
  rolling = true;
  renderControls();
  try {
    // Spin a few random faces while the server rolls the real die.
    const spin = setInterval(() => showDie(1 + Math.floor(Math.random() * 6), false), 80);
    $('#dice').classList.add('rolling');
    const res = await api(`/games/${state.game.id}/roll`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 450));
    clearInterval(spin);
    showDie(res.value);
    applyGame(res.game);
    await boardView.setPlayers(res.game.players, { me: state.me.user.id, animate: false });
    setMe(res);
  } finally {
    rolling = false;
    renderControls();
  }
}));

$('#btn-join').addEventListener('click', guard(async () => {
  applyGame(await api(`/games/${state.game.id}/join`, { method: 'POST' }));
  toast('You joined! Buy some turns to start rolling.');
}));

$('#buy-count').addEventListener('input', renderControls);
document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
  const i = $('#buy-count');
  i.value = Math.max(1, Math.min(100, (Number(i.value) || 1) + Number(b.dataset.step)));
  renderControls();
}));
$('#btn-buy').addEventListener('click', guard(async () => {
  const count = Number($('#buy-count').value);
  const res = await api(`/games/${state.game.id}/buy`, { method: 'POST', body: { count } });
  setMe(res);
  applyGame(res.game);
  toast(`Bought ${count} turn${count > 1 ? 's' : ''}`);
}));

// ---------- tasks ----------
let taskShown = null;
function openTask(cell) {
  const modal = $('#task-modal');
  if (!modal.hidden && taskShown === cell) return;
  taskShown = cell;
  $('#task-q').textContent = cell.question;
  $('#task-reward').textContent = `${fmt(cell.reward.amount)} ${cell.reward.token}${cell.bonusTurns ? ` + ${cell.bonusTurns} free turn(s)` : ''}`;
  $('#task-options').innerHTML = cell.options.map((o, i) => `<button class="btn" data-opt="${i}">${String.fromCharCode(65 + i)}. ${esc(o)}</button>`).join('');
  $('#task-options').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => answer(Number(b.dataset.opt))));
  modal.hidden = false;
}
const answer = guard(async (option) => {
  const res = await api(`/games/${state.game.id}/answer`, { method: 'POST', body: { option } });
  $('#task-modal').hidden = true;
  taskShown = null;
  toast(option === null ? 'Task skipped' : res.correct ? 'Correct! Prize added.' : `Wrong — the answer was ${String.fromCharCode(65 + res.answer)}.`, option !== null && !res.correct);
  setMe(res);
  applyGame(res.game);
});
$('#btn-task-skip').addEventListener('click', () => answer(null));

// ---------- boot ----------
(async () => {
  state.config = await api('/config');
  $('#btn-faucet').hidden = !state.config.devFaucet;
  if (state.token) await refreshMe();
  route();
})();

