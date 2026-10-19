import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../server/engine.js';
import { demoBoard } from '../server/seed.js';

// rng that returns queued values (clamped into range), then falls back to min.
const seq = (...vals) => (min, max) => Math.max(min, Math.min(max, vals.length ? vals.shift() : min));

function line(types) {
  return engine.normalizeBoard({ name: 'T', cols: 20, rows: 3, cells: types.map((t, x) => ({ x, y: 0, ...(typeof t === 'string' ? { type: t } : t) })) });
}

function running(board, names = ['a']) {
  const g = engine.newGame({ id: 'g', name: 'G', board, endAfter: 1, finishPrizes: [{ token: 'GRAM', amount: 50 }] });
  for (const n of names) engine.joinGame(g, { id: n, name: n });
  engine.startGame(g);
  return g;
}

test('demo board is valid', () => {
  assert.equal(demoBoard().cells.length, 30);
});

test('board validation reports every problem', () => {
  assert.throws(() => engine.normalizeBoard({ name: '', cols: 2, rows: 3, cells: [{ x: 0, y: 0, type: 'empty' }] }), (e) => {
    assert.match(e.message, /name is required/);
    assert.match(e.message, /Columns/);
    assert.match(e.message, /2–200 cells/);
    assert.match(e.message, /first cell must be the start/);
    return true;
  });
  assert.throws(() => line(['start', { type: 'jump', to: 9 }, 'finish']), /jump target/);
  assert.throws(() => line(['start', { type: 'task', question: 'q', options: ['a'], answer: 0, reward: { token: 'GRAM', amount: 1 } }, 'finish']), /at least 2/);
  assert.throws(() => engine.normalizeBoard({ name: 'x', cols: 3, rows: 3, cells: [{ x: 0, y: 0, type: 'start' }, { x: 0, y: 0, type: 'finish' }] }), /already sits/);
});

test('task answers are hidden from players', () => {
  const b = line(['start', { type: 'task', question: 'q', options: ['a', 'b'], answer: 1, reward: { token: 'GRAM', amount: 1 } }, 'finish']);
  const pub = engine.publicGame(running(b));
  assert.equal(pub.board.cells[1].answer, undefined);
  assert.deepEqual(pub.board.cells[1].options, ['a', 'b']);
});

test('rolling needs a turn and spends free turns before paid ones', () => {
  const g = running(line(['start', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'empty', 'finish']));
  assert.throws(() => engine.roll(g, 'a', seq(1)), /No turns left/);
  const p = g.players[0];
  p.turns = 1;
  p.freeTurns = 1;
  engine.roll(g, 'a', seq(2));
  assert.deepEqual([p.pos, p.turns, p.freeTurns], [2, 1, 0]);
  assert.deepEqual(g.lastMove, { seq: 1, userId: 'a', value: 2, from: 0, landed: 2, to: 2 });
});

test('prize, move, jump, bonus and skip cells', () => {
  const g = running(line([
    'start',
    { type: 'prize', token: 'USDT', amount: 2.5 },
    { type: 'move', steps: 2 },
    'empty',
    { type: 'bonus', turns: 2 },
    { type: 'jump', to: 1 },
    { type: 'skip', turns: 1 },
    'empty',
    'finish',
  ]));
  const p = g.players[0];
  p.turns = 10;
  engine.roll(g, 'a', seq(1));
  assert.deepEqual(p.prizes, { USDT: 2.5 });
  engine.roll(g, 'a', seq(1)); // cell 2 moves +2 → 4 (no chained effect)
  assert.equal(p.pos, 4);
  assert.equal(g.lastMove.landed, 2);
  assert.equal(p.freeTurns, 0);
  engine.roll(g, 'a', seq(2)); // cell 4... from 4 +2 → 6 skip
  assert.equal(p.pos, 6);
  assert.equal(p.frozen, 1);
  engine.roll(g, 'a', seq(1)); // frozen: turn spent, no move
  assert.equal(p.pos, 6);
  assert.equal(g.lastMove.skipped, true);
  p.pos = 4;
  engine.roll(g, 'a', seq(1)); // land on 5, jump back to 1
  assert.equal(p.pos, 1);
  assert.equal(g.lastMove.landed, 5);
  p.pos = 3;
  engine.roll(g, 'a', seq(1)); // bonus
  assert.equal(p.freeTurns, 2);
});

test('task blocks rolling until answered; right answer pays', () => {
  const g = running(line(['start', { type: 'task', question: 'q', options: ['a', 'b'], answer: 1, reward: { token: 'GRAM', amount: 3 }, bonusTurns: 1 }, 'empty', 'finish']));
  const p = g.players[0];
  p.turns = 5;
  engine.roll(g, 'a', seq(1));
  assert.equal(p.pendingTask, 1);
  assert.throws(() => engine.roll(g, 'a', seq(1)), /Answer your task/);
  assert.deepEqual(engine.answerTask(g, 'a', 0), { correct: false, answer: 1 });
  assert.deepEqual(p.prizes, {});
  p.pos = 0;
  engine.roll(g, 'a', seq(1));
  assert.equal(engine.answerTask(g, 'a', 1).correct, true);
  assert.deepEqual(p.prizes, { GRAM: 3 });
  assert.equal(p.freeTurns, 1);
});

test('chance applies one random outcome', () => {
  const g = running(line(['start', { type: 'chance', outcomes: [{ text: 'x', kind: 'none' }, { text: 'tip', kind: 'prize', token: 'GRAM', amount: 4 }] }, 'empty', 'finish']));
  g.players[0].turns = 1;
  engine.roll(g, 'a', seq(1, 1)); // die 1, outcome #1
  assert.deepEqual(g.players[0].prizes, { GRAM: 4 });
  assert.match(g.log.at(-1).text, /tip/);
});

test('reaching the finish awards place prize and ends the game', () => {
  const g = running(line(['start', 'empty', 'empty', 'finish']), ['a', 'b']);
  g.players[0].turns = 1;
  engine.roll(g, 'a', seq(6)); // overshoot stops on finish
  assert.equal(g.players[0].place, 1);
  assert.deepEqual(g.players[0].prizes, { GRAM: 50 });
  assert.equal(g.status, 'finished');
  assert.throws(() => engine.roll(g, 'b', seq(1)), /over/);
});

test('join rules', () => {
  const g = engine.newGame({ id: 'g', name: 'G', board: line(['start', 'finish']), maxPlayers: 1 });
  engine.joinGame(g, { id: 'a', name: 'a' });
  engine.joinGame(g, { id: 'a', name: 'a' }); // idempotent
  assert.equal(g.players.length, 1);
  assert.throws(() => engine.joinGame(g, { id: 'b', name: 'b' }), /full/);
  assert.throws(() => engine.roll(g, 'a'), /not started/);
});
