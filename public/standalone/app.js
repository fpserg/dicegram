// DiceGram standalone app: the whole game runs in the browser.
// State lives in the store (shared claude.ai database, or this browser only):
//   wallets/<uid>      GRAM balance, withdrawable prizes, history, settled games
//   games/<id>         full game state incl. a copy of its board
//   boards/<id>        boards designed in the admin view
//   withdrawals/<id>   withdrawal requests
import { createBoardView, CELL_META } from '../shared/board.js';
import * as engine from '../shared/engine.js';
import { demoBoard } from '../shared/demo.js';
import { openStore } from './store.js';
import { initAdmin } from './admin.js';

const { amt } = engine;
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 9 });
const tokens = (obj) => Object.entries(obj || {}).filter(([, v]) => v).map(([t, v]) => `${fmt(v)} ${esc(t)}`).join(', ');
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const TON_ADDRESS = /^(?:[EUk0][Qf][A-Za-z0-9_-]{46}|-?\d{1,3}:[0-9a-fA-F]{64})$/;
const LEDGER_MAX = 60;

let pendingHash = location.hash.slice(1);
const S = { store: null, uid: null, isAdmin: false, wallet: undefined, games: [], gameId: null, view: 'loading' };

// ---------- ui helpers ----------
let toastTimer;
function toast(msg, error = false) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast${error ? ' error' : ''}`;
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), error ? 5000 : 3000);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e?.message || String(e), true); } };

// In-page replacement for confirm()/prompt(), which the artifact viewer blocks.
function ask({ title, body = '', ok = 'OK', danger = false, input = null }) {
  return new Promise((resolve) => {
    const modal = $('#ask-modal');
    $('#ask-title').textContent = title;
    $('#ask-body').textContent = body;
    const field = $('#ask-input');
    field.hidden = !input;
    field.value = '';
    field.placeholder = input?.placeholder || '';
    const okBtn = $('#ask-ok');
    okBtn.textContent = ok;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    modal.hidden = false;
    (input ? field : okBtn).focus();
    const done = (value) => {
      modal.hidden = true;
      $('#ask-form').onsubmit = null;
      $('#ask-cancel').onclick = null;
      resolve(value);
    };
    $('#ask-form').onsubmit = (e) => { e.preventDefault(); done(input ? field.value : true); };
    $('#ask-cancel').onclick = () => done(null);
  });
}

function show(view) {
  S.view = view;
  for (const v of ['loading', 'welcome', 'lobby', 'game', 'wallet', 'admin']) $(`#view-${v}`).hidden = v !== view;
  $('#task-modal').hidden = true;
  if (view === 'game') renderGame();
  if (view === 'wallet') renderWallet();
  if (view === 'lobby') renderLobby();
  if (view === 'admin') admin?.show();
  window.scrollTo(0, 0);
}

// ---------- wallet ----------
const walletPath = () => `wallets/${S.uid}`;

function ledgerAdd(w, type, amount, extra = {}) {
  w.ledger = [{ type, amount: amt(amount), at: Date.now(), ...extra }, ...(w.ledger || [])].slice(0, LEDGER_MAX);
}

// Read-modify-write of this player's wallet under a short lease.
async function updateWallet(fn) {
  await S.store.lock(walletPath());
  const w = await S.store.get(walletPath());
  if (!w) throw new Error('Wallet not found — reload the page');
  const out = fn(w);
  await S.store.set(walletPath(), w);
  S.wallet = w;
  renderAccount();
  return out;
}

const faucet = guard(async (amount) => {
  await updateWallet((w) => { w.gram = amt(w.gram + amount); ledgerAdd(w, 'faucet', amount); });
  toast(`+${amount} test GRAM added`);
});

function lockedPrizes() {
  const out = {};
  for (const g of S.games) {
    if (g.status === 'finished') continue;
    const p = g.players.find((x) => x.userId === S.uid);
    for (const [t, v] of Object.entries(p?.prizes || {})) out[t] = amt((out[t] || 0) + v);
  }
  return out;
}

// When a game I played has ended: refund unused paid turns, release prizes. Once per game.
let settling = false;
async function settleMine() {
  if (settling || !S.wallet) return;
  const due = S.games.filter((g) => g.status === 'finished' && !S.wallet.settled?.[g.id] && g.players.some((p) => p.userId === S.uid));
  if (!due.length) return;
  settling = true;
  try {
    const notes = await updateWallet((w) => {
      w.settled ||= {};
      const msgs = [];
      for (const g of due) {
        if (w.settled[g.id]) continue;
        const p = g.players.find((x) => x.userId === S.uid);
        const refund = amt(p.turns * g.turnPrice);
        if (refund > 0) { w.gram = amt(w.gram + refund); ledgerAdd(w, 'refund', refund, { note: `${p.turns} unused turn(s) · ${g.name}` }); }
        for (const [t, v] of Object.entries(p.prizes)) {
          w.prizes[t] = amt((w.prizes[t] || 0) + v);
          ledgerAdd(w, 'prize', v, { token: t, note: g.name });
        }
        w.settled[g.id] = true;
        msgs.push(`“${g.name}” is over${tokens(p.prizes) ? `: ${tokens(p.prizes)} added to your wallet` : ''}${refund ? `, ${fmt(refund)} GRAM refunded` : ''}.`);
      }
      return msgs;
    });
    if (notes.length) toast(notes.join('\n'));
  } catch (e) {
    toast(e.message, true);
  } finally {
    settling = false;
  }
}

function renderAccount() {
  if (!S.wallet) return;
  $('#account').hidden = false;
  $('#me-gram').textContent = `${fmt(S.wallet.gram)} GRAM`;
  $('#nav-admin').hidden = !S.isAdmin;
  if (S.view === 'wallet') renderWallet();
  if (S.view === 'game') renderControls();
}

const LEDGER_NAMES = { faucet: 'Test top-up', buy_turns: 'Bought turns', refund: 'Refund', prize: 'Prize released', withdraw: 'Withdrawal', withdraw_returned: 'Withdrawal returned', admin_grant: 'Admin adjustment', buy_refund: 'Purchase undone' };

let myWithdrawals = [];
function renderWallet() {
  const w = S.wallet;
  if (!w) return;
  $('#w-gram').textContent = fmt(w.gram);
  $('#w-locked').innerHTML = tokens(lockedPrizes()) || '<span class="muted">none</span>';
  $('#w-prizes').innerHTML = tokens(w.prizes) || '<span class="muted">none yet</span>';
  const avail = Object.entries(w.prizes).filter(([, v]) => v > 0);
  const sel = $('#wd-token');
  const prev = sel.value;
  sel.innerHTML = avail.length ? avail.map(([t, v]) => `<option value="${esc(t)}">${esc(t)} (max ${fmt(v)})</option>`).join('') : '<option value="">No prizes yet</option>';
  if (avail.some(([t]) => t === prev)) sel.value = prev;
  $('#btn-withdraw').disabled = !avail.length;
  $('#w-withdrawals').innerHTML = myWithdrawals.length
    ? `<tr><th>Date</th><th>Amount</th><th>To</th><th>Status</th></tr>${myWithdrawals.map((x) => `<tr><td>${new Date(x.at).toLocaleDateString()}</td><td>${fmt(x.amount)} ${esc(x.token)}</td><td class="addr">${esc(x.address)}</td><td>${esc(x.status)}${x.txHash ? `<br><span class="addr">${esc(x.txHash)}</span>` : ''}</td></tr>`).join('')}`
    : '';
  $('#w-ledger').innerHTML = w.ledger?.length
    ? `<tr><th>When</th><th>What</th><th>Amount</th></tr>${w.ledger.map((t) => `<tr><td>${new Date(t.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(LEDGER_NAMES[t.type] || t.type)}${t.note ? ` <span class="muted">· ${esc(t.note)}</span>` : ''}</td><td class="${t.amount >= 0 ? 'pos' : 'neg'}">${t.amount >= 0 ? '+' : ''}${fmt(t.amount)} ${esc(t.token || 'GRAM')}</td></tr>`).join('')}`
    : '<tr><td class="muted">No transactions yet</td></tr>';
}

$('#form-withdraw').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const token = $('#wd-token').value;
  const amount = amt($('#wd-amount').value);
  const address = $('#wd-address').value.trim();
  if (!(amount > 0)) throw new Error('Enter an amount to withdraw');
  if (!TON_ADDRESS.test(address)) throw new Error('That does not look like a TON wallet address (UQ… / EQ…)');
  await updateWallet((w) => {
    if (!((w.prizes[token] || 0) >= amount)) throw new Error(`You only have ${fmt(w.prizes[token] || 0)} ${token} available`);
    w.prizes[token] = amt(w.prizes[token] - amount);
    ledgerAdd(w, 'withdraw', -amount, { token });
  });
  const id = newId('w');
  await S.store.set(`withdrawals/${id}`, { userId: S.uid, userName: S.wallet.name, token, amount, address, status: 'pending', at: Date.now() });
  $('#wd-amount').value = '';
  toast('Withdrawal requested. It will be sent after review.');
}));

// ---------- lobby ----------
function renderLobby() {
  const games = S.games.slice().sort((a, b) => (a.status === 'finished') - (b.status === 'finished') || b.createdAt - a.createdAt);
  $('#game-list').innerHTML = games.length
    ? games.map((g) => {
      const mine = g.players.some((p) => p.userId === S.uid);
      return `<div class="panel game-card">
        <div class="row"><h3 class="grow">${esc(g.name)}</h3><span class="pill ${g.status}">${g.status}</span></div>
        <div class="muted small">“${esc(g.board.name)}” · ${g.board.cells.length} cells · ${g.players.length}/${g.maxPlayers} players${mine ? ' · <span class="gram">you’re in</span>' : ''}</div>
        <div class="small">Turn <span class="gram">${fmt(g.turnPrice)} GRAM</span>${g.finishPrizes.length ? ` · Finish prize ${g.finishPrizes.map((p, i) => `#${i + 1} ${fmt(p.amount)} ${esc(p.token)}`).join(', ')}` : ''}</div>
        <button class="btn ${g.status === 'finished' ? '' : 'btn-primary'}" data-open="${esc(g.id)}" type="button">${g.status === 'finished' ? 'View results' : mine ? 'Continue' : 'Open'}</button>
      </div>`;
    }).join('')
    : `<div class="panel empty muted">No games yet.${S.isAdmin ? ' Open <strong>Admin</strong> to design a board and create a game.' : ' Ask the organizer to create one.'}</div>`;
  $('#game-list').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openGame(b.dataset.open)));
}

// ---------- game ----------
const boardView = createBoardView($('#board'));
let boardKey = null;
let lastSeq = -1;
let rolling = false;
const currentGame = () => S.games.find((g) => g.id === S.gameId);
const myPlayer = (g = currentGame()) => g?.players.find((p) => p.userId === S.uid);

function openGame(id) {
  S.gameId = id;
  boardKey = null;
  lastSeq = -1;
  try { history.replaceState(null, '', `#${id}`); } catch { /* ignore */ }
  show('game');
}

async function gameAction(fn) {
  const path = `games/${S.gameId}`;
  await S.store.lock(path);
  const g = await S.store.get(path);
  if (!g) throw new Error('This game no longer exists');
  const out = fn(g);
  await S.store.set(path, g);
  const i = S.games.findIndex((x) => x.id === g.id);
  if (i >= 0) S.games[i] = g;
  return out;
}

function renderGame({ animate = true } = {}) {
  const g = currentGame();
  if (!g) { if (S.view === 'game') { toast('That game was removed', true); show('lobby'); } return; }
  const key = `${g.id}:${g.board.updatedAt}:${g.board.cells.length}`;
  if (key !== boardKey) {
    boardView.setBoard(g.board);
    boardKey = key;
    const used = [...new Set(g.board.cells.map((c) => c.type))].filter((t) => t !== 'empty');
    $('#g-legend').innerHTML = used.map((t) => `<li>${CELL_META[t].icon} ${CELL_META[t].name}</li>`).join('');
  }
  const fresh = g.lastMove && g.lastMove.seq > lastSeq;
  boardView.setPlayers(g.players, { lastMove: fresh && animate && lastSeq >= 0 ? g.lastMove : null, me: S.uid });
  if (fresh && lastSeq >= 0 && g.lastMove.userId !== S.uid) showDie(g.lastMove.value, true);
  if (g.lastMove) lastSeq = Math.max(lastSeq, g.lastMove.seq); else lastSeq = Math.max(lastSeq, 0);

  $('#g-name').textContent = g.name;
  $('#g-status').textContent = g.status;
  $('#g-status').className = `pill ${g.status}`;
  $('#g-meta').innerHTML = `${esc(g.board.name)} · ${g.board.cells.length} cells · turn = <span class="gram">${fmt(g.turnPrice)} GRAM</span>`
    + (g.finishPrizes.length ? `<br>Finish prizes: ${g.finishPrizes.map((p, i) => `#${i + 1} ${fmt(p.amount)} ${esc(p.token)}`).join(' · ')}` : '')
    + `<br>Ends when ${g.endAfter === 1 ? 'the first player finishes' : `${g.endAfter} players finish`}.`;
  $('#g-players').innerHTML = g.players.map((p) => `
    <li><span class="dot" style="background:${esc(p.color)}"></span>
      <span>${esc(p.name)}${p.userId === S.uid ? ' <span class="me-tag">(you)</span>' : ''}<br>
      <span class="muted small">cell ${p.pos}${p.place ? ` · 🏆 #${p.place}` : ''}${p.frozen ? ' · ⛔ skipping' : ''}</span></span>
      <span class="tokens">${tokens(p.prizes) || '<span class="muted">no prizes</span>'}</span></li>`).join('') || '<li class="muted">Nobody has joined yet</li>';
  $('#g-log').innerHTML = g.log.slice().reverse().map((l) => `<li>${esc(l.text)}</li>`).join('');
  renderControls();
}

function renderControls() {
  const g = currentGame();
  if (!g || !S.wallet) return;
  const me = myPlayer(g);
  const full = g.players.length >= g.maxPlayers;
  $('#g-join').hidden = !!me || g.status === 'finished';
  $('#g-join-text').textContent = full ? 'This game is full.' : `Join to buy turns (${fmt(g.turnPrice)} GRAM each) and race for the prizes.`;
  $('#btn-join').disabled = full;
  $('#g-controls').hidden = !me;
  if (!me) return;
  const total = me.turns + me.freeTurns;
  $('#g-turns').textContent = g.status === 'finished' ? 0 : total;
  const n = Math.max(1, Math.min(100, Number($('#buy-count').value) || 1));
  const cost = amt(n * g.turnPrice);
  $('#btn-buy').textContent = `Buy ${n} · ${fmt(cost)} GRAM`;
  $('#btn-buy').disabled = g.status === 'finished' || !!me.place || S.wallet.gram < cost;

  let note = '';
  if (g.status === 'lobby') note = 'Waiting for the organizer to start the game. You can buy turns now.';
  else if (g.status === 'finished') note = me.place ? `You finished #${me.place}. Prizes and refunds went to your wallet.` : 'This game is over. Prizes and refunds went to your wallet.';
  else if (me.place) note = `You reached the finish (#${me.place}). Waiting for the game to end.`;
  else if (me.pendingTask !== null) note = 'Solve your task to continue.';
  else if (!total) note = S.wallet.gram < g.turnPrice ? 'No turns and not enough GRAM. Add test GRAM at the top.' : 'Buy turns to roll the dice.';
  else if (me.frozen) note = `⛔ Your next ${me.frozen > 1 ? `${me.frozen} rolls are` : 'roll is'} skipped.`;
  if (me.freeTurns && g.status !== 'finished') note = `${note ? `${note} ` : ''}Includes ${me.freeTurns} free turn${me.freeTurns > 1 ? 's' : ''}.`;
  $('#g-note').textContent = note;
  $('#btn-roll').disabled = rolling || g.status !== 'running' || !!me.place || me.pendingTask !== null || !total;

  if (g.status === 'running' && me.pendingTask !== null && !rolling) openTask(g, g.board.cells[me.pendingTask]);
  else $('#task-modal').hidden = true;
}

function showDie(value, spin) {
  const d = $('#dice');
  d.innerHTML = Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[value]?.includes(i) ? 'on' : ''}"></i>`).join('');
  d.setAttribute('aria-label', `Die shows ${value}`);
  if (spin) { d.classList.remove('rolling'); void d.offsetWidth; d.classList.add('rolling'); }
}
showDie(6, false);

$('#btn-roll').addEventListener('click', guard(async () => {
  rolling = true;
  renderControls();
  const spin = setInterval(() => showDie(1 + Math.floor(Math.random() * 6), false), 80);
  $('#dice').classList.add('rolling');
  try {
    const res = await gameAction((g) => engine.roll(g, S.uid));
    await new Promise((r) => setTimeout(r, 350));
    clearInterval(spin);
    showDie(res.value, true);
    renderGame();
    await boardView.setPlayers(currentGame().players, { me: S.uid, animate: false });
  } finally {
    clearInterval(spin);
    rolling = false;
    renderControls();
  }
}));

$('#btn-join').addEventListener('click', guard(async () => {
  await gameAction((g) => engine.joinGame(g, { id: S.uid, name: S.wallet.name }));
  renderGame();
  toast('You joined! Buy some turns to start rolling.');
}));

$('#buy-count').addEventListener('input', renderControls);
document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
  const i = $('#buy-count');
  i.value = Math.max(1, Math.min(100, (Number(i.value) || 1) + Number(b.dataset.step)));
  renderControls();
}));

$('#btn-buy').addEventListener('click', guard(async () => {
  const g = currentGame();
  const n = Math.max(1, Math.min(100, Math.floor(Number($('#buy-count').value) || 1)));
  const cost = amt(n * g.turnPrice);
  await updateWallet((w) => {
    if (w.gram < cost) throw new Error(`Not enough GRAM: ${n} turn(s) cost ${fmt(cost)}, you have ${fmt(w.gram)}`);
    w.gram = amt(w.gram - cost);
    ledgerAdd(w, 'buy_turns', -cost, { note: `${n} turn(s) · ${g.name}` });
  });
  try {
    await gameAction((game) => {
      if (game.status === 'finished') throw new Error('This game is over');
      engine.getPlayer(game, S.uid).turns += n;
    });
  } catch (e) {
    // Give the GRAM back if the turns could not be added.
    await updateWallet((w) => { w.gram = amt(w.gram + cost); ledgerAdd(w, 'buy_refund', cost); });
    throw e;
  }
  renderGame({ animate: false });
  toast(`Bought ${n} turn${n > 1 ? 's' : ''}`);
}));

let taskShown = null;
function openTask(g, cell) {
  const modal = $('#task-modal');
  const key = `${g.id}:${g.lastMove?.seq}`;
  if (!modal.hidden && taskShown === key) return;
  taskShown = key;
  $('#task-q').textContent = cell.question;
  $('#task-reward').textContent = `${fmt(cell.reward.amount)} ${cell.reward.token}${cell.bonusTurns ? ` + ${cell.bonusTurns} free turn(s)` : ''}`;
  $('#task-options').innerHTML = cell.options.map((o, i) => `<button class="btn" data-opt="${i}" type="button">${String.fromCharCode(65 + i)}. ${esc(o)}</button>`).join('');
  $('#task-options').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => answer(Number(b.dataset.opt))));
  modal.hidden = false;
}
const answer = guard(async (option) => {
  const res = await gameAction((g) => engine.answerTask(g, S.uid, option));
  $('#task-modal').hidden = true;
  taskShown = null;
  toast(option === null ? 'Task skipped' : res.correct ? 'Correct! Prize added.' : `Wrong. The answer was ${String.fromCharCode(65 + res.answer)}.`, option !== null && !res.correct);
  renderGame();
});
$('#btn-task-skip').addEventListener('click', () => answer(null));

// ---------- navigation ----------
$('#nav-home').addEventListener('click', () => S.wallet && show('lobby'));
$('#btn-back').addEventListener('click', () => show('lobby'));
$('#nav-wallet').addEventListener('click', () => show('wallet'));
$('#nav-admin').addEventListener('click', () => show('admin'));
$('#btn-faucet').addEventListener('click', () => faucet(10));
document.querySelectorAll('[data-faucet]').forEach((b) => b.addEventListener('click', () => faucet(Number(b.dataset.faucet))));

$('#form-name').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const name = $('#welcome-name').value.trim().slice(0, 20);
  if (name.length < 2) throw new Error('Pick a name of at least 2 characters');
  const w = { name, gram: 0, prizes: {}, ledger: [], settled: {}, createdAt: Date.now() };
  await S.store.set(walletPath(), w);
  S.wallet = w;
  renderAccount();
  toast('Welcome! Tap “+10 test GRAM” to fund your balance.');
  show('lobby');
}));

// ---------- boot ----------
let admin = null;

async function seedLocalDemo() {
  const board = { id: 'demo', ...demoBoard(), updatedAt: Date.now() };
  await S.store.set('boards/demo', board);
  const game = engine.newGame({ id: 'demo-race', name: 'Demo race', board, turnPrice: 1, maxPlayers: 6, endAfter: 1, finishPrizes: [{ token: 'GRAM', amount: 50 }] });
  game.boardId = board.id;
  engine.startGame(game);
  await S.store.set('games/demo-race', game);
}

(async () => {
  try {
    S.store = await openStore();
  } catch (e) {
    $('#view-loading').innerHTML = `<div class="panel empty">Could not open the game data: ${esc(e.message)}</div>`;
    return;
  }
  S.uid = S.store.uid;
  S.isAdmin = await S.store.isAdmin();
  if (S.store.mode === 'local') {
    $('#mode-note').hidden = false;
    $('#mode-note').textContent = 'Single-device mode: everything is saved in this browser only. Open DiceGram on claude.ai to play with others.';
    if (!(await S.store.get('games/demo-race')) && !(await S.store.get('boards/demo'))) await seedLocalDemo();
  }
  admin = initAdmin({ store: S.store, toast, ask, guard, esc, fmt, tokens, ledgerAdd, newId, openGame: (id) => openGame(id) });

  const onErr = (e) => toast(`Live updates stopped (${e.code}). Reload the page.`, true);
  S.store.watchCol('games', (games) => {
    S.games = games;
    if (S.view === 'lobby') renderLobby();
    if (S.view === 'game' && !rolling) renderGame();
    if (S.view === 'wallet') renderWallet();
    admin.gamesChanged(games);
    if (pendingHash && S.wallet && S.view === 'lobby' && games.some((g) => g.id === pendingHash)) openGame(pendingHash);
    if (games.length) pendingHash = '';
    settleMine();
  }, onErr);
  S.store.watchDoc(walletPath(), (w) => {
    const first = S.wallet === undefined;
    S.wallet = w;
    if (!w) {
      show('welcome');
      S.store.defaultName().then((n) => { if (n && !$('#welcome-name').value) $('#welcome-name').value = n.slice(0, 20); });
      return;
    }
    renderAccount();
    settleMine();
    if (first || S.view === 'welcome') {
      if (pendingHash && S.games.some((g) => g.id === pendingHash)) { openGame(pendingHash); pendingHash = ''; } else show('lobby');
    }
  }, onErr);
  S.store.watchCol('withdrawals', (list) => {
    myWithdrawals = list.filter((x) => x.userId === S.uid).sort((a, b) => b.at - a.at);
    admin.withdrawalsChanged(list);
    if (S.view === 'wallet') renderWallet();
  }, onErr);
})();
