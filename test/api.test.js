import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

const UQ = `UQ${'A'.repeat(46)}`;

async function start(opts = {}) {
  // Every die roll is 6 so a 30-cell board takes a handful of turns.
  const { server } = createApp({ adminToken: 'secret', rng: (min, max) => max, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, { method = 'GET', body, token, admin } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-admin-token': 'secret' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { server, call };
}

test('full money flow: faucet → buy turns → play → refund + prizes → withdraw', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());

  const [demo] = (await call('/games')).body;
  assert.equal(demo.status, 'running');

  const { body: reg } = await call('/register', { method: 'POST', body: { name: 'Alice' } });
  const token = reg.token;
  assert.equal(reg.user.gram, 0);

  assert.equal((await call(`/games/${demo.id}/buy`, { method: 'POST', token, body: { count: 1 } })).status, 403); // not joined
  await call(`/games/${demo.id}/join`, { method: 'POST', token });
  const poor = await call(`/games/${demo.id}/buy`, { method: 'POST', token, body: { count: 1 } });
  assert.equal(poor.status, 400);
  assert.match(poor.body.error, /Not enough GRAM/);

  assert.equal((await call('/wallet/faucet', { method: 'POST', token, body: { amount: 5000 } })).status, 400);
  assert.equal((await call('/wallet/faucet', { method: 'POST', token, body: { amount: 20 } })).body.user.gram, 20);

  const bought = await call(`/games/${demo.id}/buy`, { method: 'POST', token, body: { count: 15 } });
  assert.equal(bought.body.user.gram, 5);
  assert.equal(bought.body.game.players[0].turns, 15);
  assert.equal(bought.body.game.board.cells[7].answer, undefined, 'answers stay secret');

  let game = bought.body.game;
  let rolls = 0;
  while (game.status === 'running' && rolls < 30) {
    const me = game.players[0];
    if (me.pendingTask !== null) {
      game = (await call(`/games/${demo.id}/answer`, { method: 'POST', token, body: { option: null } })).body.game;
      continue;
    }
    const r = await call(`/games/${demo.id}/roll`, { method: 'POST', token });
    assert.equal(r.status, 200, r.body.error);
    game = r.body.game;
    rolls++;
  }
  assert.equal(game.status, 'finished');
  const p = game.players[0];
  assert.equal(p.place, 1);
  assert.ok(p.prizes.GRAM >= 50);

  const { body: me } = await call('/me', { token });
  const usedPaid = 15 - p.refunded;
  assert.equal(me.user.gram, 5 + p.refunded, 'unused turns refunded');
  assert.ok(usedPaid > 0);
  assert.deepEqual(me.user.prizes, p.prizes, 'prizes released');
  assert.deepEqual(me.user.locked, {});

  const bad = await call('/withdrawals', { method: 'POST', token, body: { token: 'GRAM', amount: 1, address: 'nope' } });
  assert.match(bad.body.error, /TON wallet address/);
  const tooMuch = await call('/withdrawals', { method: 'POST', token, body: { token: 'GRAM', amount: 1e6, address: UQ } });
  assert.match(tooMuch.body.error, /only have/);
  const wd = await call('/withdrawals', { method: 'POST', token, body: { token: 'GRAM', amount: 10, address: UQ } });
  assert.equal(wd.body.user.prizes.GRAM, p.prizes.GRAM - 10);

  // admin rejects → tokens return
  const list = (await call('/admin/withdrawals', { admin: true })).body;
  assert.equal(list.length, 1);
  await call(`/admin/withdrawals/${list[0].id}`, { method: 'POST', admin: true, body: { status: 'rejected' } });
  assert.equal((await call('/me', { token })).body.user.prizes.GRAM, p.prizes.GRAM);
  assert.equal((await call(`/admin/withdrawals/${list[0].id}`, { method: 'POST', admin: true, body: { status: 'paid' } })).status, 400);
});

test('admin: auth, board CRUD, game lifecycle with refunds', async (t) => {
  const { server, call } = await start();
  t.after(() => server.close());

  assert.equal((await call('/admin/boards')).status, 401);
  const board = { name: 'Mini', cols: 4, rows: 3, cells: [{ x: 0, y: 0, type: 'start' }, { x: 1, y: 0, type: 'prize', token: 'ton', amount: 1 }, { x: 2, y: 0, type: 'finish' }] };
  const created = await call('/admin/boards', { method: 'POST', admin: true, body: board });
  assert.equal(created.status, 200);
  assert.equal(created.body.cells[1].token, 'TON');
  const invalid = await call(`/admin/boards/${created.body.id}`, { method: 'PUT', admin: true, body: { ...board, cells: board.cells.slice(0, 1) } });
  assert.equal(invalid.status, 400);

  const g = (await call('/admin/games', { method: 'POST', admin: true, body: { name: 'Cup', boardId: created.body.id, turnPrice: 2, finishPrizes: [{ token: 'GRAM', amount: 5 }] } })).body;
  assert.equal(g.status, 'lobby');

  const { body: reg } = await call('/register', { method: 'POST', body: { name: 'Bob' } });
  await call('/wallet/faucet', { method: 'POST', token: reg.token, body: { amount: 10 } });
  await call(`/games/${g.id}/join`, { method: 'POST', token: reg.token });
  await call(`/games/${g.id}/buy`, { method: 'POST', token: reg.token, body: { count: 3 } });
  assert.match((await call(`/games/${g.id}/roll`, { method: 'POST', token: reg.token })).body.error, /not started/);

  assert.equal((await call(`/admin/games/${g.id}`, { method: 'DELETE', admin: true })).status, 400);
  await call(`/admin/games/${g.id}/start`, { method: 'POST', admin: true });
  await call(`/admin/games/${g.id}/end`, { method: 'POST', admin: true });
  const me = (await call('/me', { token: reg.token })).body;
  assert.equal(me.user.gram, 10, 'all 3 unused turns × 2 GRAM refunded');
  assert.equal((await call(`/admin/games/${g.id}/end`, { method: 'POST', admin: true })).status, 400);

  const users = (await call('/admin/users', { admin: true })).body;
  await call(`/admin/users/${users[0].id}/grant`, { method: 'POST', admin: true, body: { amount: -4 } });
  assert.equal((await call('/me', { token: reg.token })).body.user.gram, 6);
});

test('faucet can be disabled', async (t) => {
  const { server, call } = await start({ devFaucet: false });
  t.after(() => server.close());
  const { body: reg } = await call('/register', { method: 'POST', body: { name: 'Eve' } });
  assert.equal((await call('/wallet/faucet', { method: 'POST', token: reg.token, body: { amount: 1 } })).status, 403);
  assert.equal((await call('/config')).body.devFaucet, false);
});
