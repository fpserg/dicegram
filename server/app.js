// HTTP API + static file server. Zero dependencies: node:http, JSON bodies,
// Server-Sent Events for live game updates.
//
// Money model (off-chain ledger for the prototype):
//   user.gram            spendable GRAM balance (top-up / test faucet)
//   player.turns         turns bought in a game; unused ones are refunded at the end
//   player.prizes        tokens won in a game; locked until the game is finished
//   user.prizes          winnings released from finished games; withdrawable
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, newId, newToken } from './db.js';
import { seed } from './seed.js';
import * as engine from '../public/shared/engine.js';

const { GameError, amt } = engine;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
// TON user-friendly (48 chars base64url) or raw (workchain:hex) address.
const TON_ADDRESS = /^(?:[EUk0][Qf][A-Za-z0-9_-]{46}|-?\d{1,3}:[0-9a-fA-F]{64})$/;
const FAUCET_MAX = 1000;
const PAGE_HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>';

export function createApp({ dbFile = null, adminToken = 'admin', devFaucet = true, rng = engine.defaultRng } = {}) {
  const db = openDb(dbFile);
  seed(db);
  const D = db.data;
  const streams = new Map(); // gameId -> Set<res>

  // ---------- helpers ----------
  const fail = (msg, status = 400) => { throw new GameError(msg, status); };

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 256 * 1024) { reject(new GameError('Request too large', 413)); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new GameError('Invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function authUser(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = token && Object.values(D.users).find((u) => u.token === token);
    if (!user) fail('Please sign in', 401);
    return user;
  }

  function authAdmin(req) {
    const given = Buffer.from(String(req.headers['x-admin-token'] || ''));
    const want = Buffer.from(adminToken);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) fail('Admin token required', 401);
  }

  const getGame = (id) => D.games[id] || fail('Game not found', 404);
  const getBoard = (id) => D.boards[id] || fail('Board not found', 404);

  function ledger(userId, type, amount, extra = {}) {
    D.ledger.push({ id: newId('tx'), userId, type, amount: amt(amount), at: Date.now(), ...extra });
  }

  function credit(user, type, amount, extra) {
    user.gram = amt(user.gram + amount);
    ledger(user.id, type, amount, extra);
  }

  // Release locked winnings and refund unused paid turns. Runs exactly once per game.
  function settle(game) {
    if (game.status !== 'finished' || game.settled) return;
    for (const p of game.players) {
      const user = D.users[p.userId];
      if (!user) continue;
      if (p.turns > 0) {
        credit(user, 'refund', p.turns * game.turnPrice, { gameId: game.id, note: `${p.turns} unused turn(s)` });
        p.refunded = p.turns;
        p.turns = 0;
      }
      for (const [token, value] of Object.entries(p.prizes)) {
        user.prizes[token] = amt((user.prizes[token] || 0) + value);
        ledger(user.id, 'prize', value, { token, gameId: game.id });
      }
    }
    game.settled = true;
  }

  function broadcast(game) {
    const set = streams.get(game.id);
    if (!set) return;
    const payload = `data: ${JSON.stringify(engine.publicGame(game))}\n\n`;
    for (const res of set) res.write(payload);
  }

  // After every game mutation: settle if it just ended, persist, notify.
  function commit(game) {
    if (game) settle(game);
    db.save();
    if (game) broadcast(game);
  }

  function lockedPrizes(userId) {
    const out = {};
    for (const g of Object.values(D.games)) {
      if (g.status === 'finished') continue;
      const p = g.players.find((x) => x.userId === userId);
      if (!p) continue;
      for (const [t, v] of Object.entries(p.prizes)) out[t] = amt((out[t] || 0) + v);
    }
    return out;
  }

  function me(user) {
    return {
      user: { id: user.id, name: user.name, gram: user.gram, prizes: user.prizes, locked: lockedPrizes(user.id) },
      ledger: D.ledger.filter((t) => t.userId === user.id).slice(-50).reverse(),
      withdrawals: D.withdrawals.filter((w) => w.userId === user.id).slice().reverse(),
    };
  }

  function gameSummary(g) {
    return {
      id: g.id, name: g.name, status: g.status, turnPrice: g.turnPrice, maxPlayers: g.maxPlayers,
      players: g.players.length, boardName: g.board.name, cells: g.board.cells.length,
      finishPrizes: g.finishPrizes, endAfter: g.endAfter, createdAt: g.createdAt,
    };
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  route('GET', '/api/config', () => ({ devFaucet, currency: 'GRAM', faucetMax: FAUCET_MAX }));

  route('POST', '/api/register', async (req) => {
    const { name } = await readJson(req);
    const clean = typeof name === 'string' ? name.trim().slice(0, 20) : '';
    if (clean.length < 2) fail('Pick a name of at least 2 characters');
    const user = { id: newId('u'), name: clean, token: newToken(), gram: 0, prizes: {}, createdAt: Date.now() };
    D.users[user.id] = user;
    db.save();
    return { token: user.token, ...me(user) };
  });

  route('GET', '/api/me', (req) => me(authUser(req)));

  // Prototype-only: add GRAM without a real deposit.
  route('POST', '/api/wallet/faucet', async (req) => {
    if (!devFaucet) fail('Test top-ups are disabled', 403);
    const user = authUser(req);
    const { amount } = await readJson(req);
    const n = amt(amount);
    if (!(n > 0) || n > FAUCET_MAX) fail(`Amount must be between 0 and ${FAUCET_MAX}`);
    credit(user, 'faucet', n);
    db.save();
    return me(user);
  });

  route('POST', '/api/withdrawals', async (req) => {
    const user = authUser(req);
    const body = await readJson(req);
    const token = String(body.token || '').toUpperCase();
    const amount = amt(body.amount);
    const address = String(body.address || '').trim();
    if (!(amount > 0)) fail('Enter an amount to withdraw');
    if (!((user.prizes[token] || 0) >= amount)) fail(`You only have ${user.prizes[token] || 0} ${token} available`);
    if (!TON_ADDRESS.test(address)) fail('That does not look like a TON wallet address');
    user.prizes[token] = amt(user.prizes[token] - amount);
    D.withdrawals.push({ id: newId('w'), userId: user.id, userName: user.name, token, amount, address, status: 'pending', at: Date.now() });
    ledger(user.id, 'withdraw', -amount, { token });
    db.save();
    return me(user);
  });

  route('GET', '/api/games', () => Object.values(D.games).map(gameSummary).sort((a, b) => b.createdAt - a.createdAt));

  route('GET', '/api/games/:id', (req, { id }) => engine.publicGame(getGame(id)));

  route('GET', '/api/games/:id/stream', (req, { id }, res) => {
    const game = getGame(id);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`retry: 2000\ndata: ${JSON.stringify(engine.publicGame(game))}\n\n`);
    if (!streams.has(id)) streams.set(id, new Set());
    streams.get(id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); streams.get(id)?.delete(res); });
    return undefined; // response stays open
  });

  route('POST', '/api/games/:id/join', (req, { id }) => {
    const user = authUser(req);
    const game = getGame(id);
    engine.joinGame(game, user);
    commit(game);
    return engine.publicGame(game);
  });

  route('POST', '/api/games/:id/buy', async (req, { id }) => {
    const user = authUser(req);
    const game = getGame(id);
    const { count } = await readJson(req);
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) fail('Buy between 1 and 100 turns');
    if (game.status === 'finished') fail('This game is over');
    const p = engine.getPlayer(game, user.id);
    const cost = amt(n * game.turnPrice);
    if (user.gram < cost) fail(`Not enough GRAM: ${n} turn(s) cost ${cost}, you have ${user.gram}`);
    credit(user, 'buy_turns', -cost, { gameId: game.id, note: `${n} turn(s)` });
    p.turns += n;
    commit(game);
    return { game: engine.publicGame(game), ...me(user) };
  });

  route('POST', '/api/games/:id/roll', (req, { id }) => {
    const user = authUser(req);
    const game = getGame(id);
    const result = engine.roll(game, user.id, rng);
    commit(game);
    return { ...result, game: engine.publicGame(game), ...me(user) };
  });

  route('POST', '/api/games/:id/answer', async (req, { id }) => {
    const user = authUser(req);
    const game = getGame(id);
    const { option } = await readJson(req);
    const result = engine.answerTask(game, user.id, option ?? null);
    commit(game);
    return { ...result, game: engine.publicGame(game), ...me(user) };
  });

  // ----- admin -----
  route('GET', '/api/admin/boards', (req) => { authAdmin(req); return Object.values(D.boards).sort((a, b) => b.updatedAt - a.updatedAt); });
  route('GET', '/api/admin/boards/:id', (req, { id }) => { authAdmin(req); return getBoard(id); });

  route('POST', '/api/admin/boards', async (req) => {
    authAdmin(req);
    const board = { id: newId('b'), ...engine.normalizeBoard(await readJson(req)), updatedAt: Date.now() };
    D.boards[board.id] = board;
    db.save();
    return board;
  });

  route('PUT', '/api/admin/boards/:id', async (req, { id }) => {
    authAdmin(req);
    getBoard(id);
    const board = { id, ...engine.normalizeBoard(await readJson(req)), updatedAt: Date.now() };
    D.boards[id] = board;
    db.save();
    return board;
  });

  route('DELETE', '/api/admin/boards/:id', (req, { id }) => {
    authAdmin(req);
    getBoard(id);
    delete D.boards[id];
    db.save();
    return { ok: true };
  });

  route('GET', '/api/admin/games', (req) => {
    authAdmin(req);
    return Object.values(D.games).sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => ({ ...gameSummary(g), playerList: g.players.map((p) => ({ name: p.name, pos: p.pos, turns: p.turns, freeTurns: p.freeTurns, place: p.place, prizes: p.prizes })) }));
  });

  route('POST', '/api/admin/games', async (req) => {
    authAdmin(req);
    const body = await readJson(req);
    const board = getBoard(body.boardId);
    const game = engine.newGame({
      id: newId('g'),
      name: body.name,
      board,
      turnPrice: Number(body.turnPrice ?? 1),
      maxPlayers: Number(body.maxPlayers ?? 8),
      endAfter: Number(body.endAfter ?? 1),
      finishPrizes: body.finishPrizes,
    });
    game.boardId = board.id;
    D.games[game.id] = game;
    commit(null);
    return gameSummary(game);
  });

  route('POST', '/api/admin/games/:id/start', (req, { id }) => {
    authAdmin(req);
    const game = getGame(id);
    engine.startGame(game);
    commit(game);
    return gameSummary(game);
  });

  route('POST', '/api/admin/games/:id/end', (req, { id }) => {
    authAdmin(req);
    const game = getGame(id);
    engine.endGame(game, 'The admin ended the game — prizes can now be withdrawn');
    commit(game);
    return gameSummary(game);
  });

  route('DELETE', '/api/admin/games/:id', (req, { id }) => {
    authAdmin(req);
    const game = getGame(id);
    if (game.players.length && game.status !== 'finished') fail('End the game first so players get refunds and prizes');
    delete D.games[id];
    db.save();
    return { ok: true };
  });

  route('GET', '/api/admin/users', (req) => {
    authAdmin(req);
    return Object.values(D.users).map((u) => ({ id: u.id, name: u.name, gram: u.gram, prizes: u.prizes, locked: lockedPrizes(u.id), createdAt: u.createdAt }));
  });

  route('POST', '/api/admin/users/:id/grant', async (req, { id }) => {
    authAdmin(req);
    const user = D.users[id] || fail('User not found', 404);
    const n = amt((await readJson(req)).amount);
    if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 1e6) fail('Amount must be a non-zero number');
    if (user.gram + n < 0) fail('Balance cannot go below zero');
    credit(user, 'admin_grant', n, { note: 'Admin adjustment' });
    db.save();
    return { id: user.id, gram: user.gram };
  });

  route('GET', '/api/admin/withdrawals', (req) => { authAdmin(req); return D.withdrawals.slice().reverse(); });

  route('POST', '/api/admin/withdrawals/:id', async (req, { id }) => {
    authAdmin(req);
    const w = D.withdrawals.find((x) => x.id === id) || fail('Withdrawal not found', 404);
    if (w.status !== 'pending') fail('This withdrawal was already processed');
    const { status, txHash } = await readJson(req);
    if (status === 'paid') {
      w.status = 'paid';
      w.txHash = String(txHash || '').trim().slice(0, 100);
    } else if (status === 'rejected') {
      w.status = 'rejected';
      const user = D.users[w.userId];
      if (user) {
        user.prizes[w.token] = amt((user.prizes[w.token] || 0) + w.amount);
        ledger(user.id, 'withdraw_returned', w.amount, { token: w.token });
      }
    } else fail('Status must be "paid" or "rejected"');
    w.processedAt = Date.now();
    db.save();
    return w;
  });

  // ---------- static files ----------
  function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/admin') { res.writeHead(301, { location: '/admin/' }); return res.end(); }
    if (pathname === '/admin/') pathname = '/admin/index.html';
    const file = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    // app.html is written as an artifact page fragment; give it a document skeleton here.
    if (file.endsWith('.html')) {
      const html = fs.readFileSync(file, 'utf8');
      return res.end(/^\s*<!doctype/i.test(html) ? html : `${PAGE_HEAD}${html}</body></html>`);
    }
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, decodeURIComponent(pathname));
    }
    try {
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m || r.method !== req.method) continue;
        const out = await r.handler(req, m.groups || {}, res);
        if (out !== undefined) send(res, 200, out);
        return;
      }
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof GameError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Internal error' });
    }
  });

  return { server, db };
}
