// Demo content created on first start so there is something to play.
import { normalizeBoard, newGame, startGame } from './engine.js';
import { newId } from './db.js';

// Serpentine path through a cols x rows grid, top-left to bottom-right.
export function snakePath(cols, rows) {
  const out = [];
  for (let y = 0; y < rows; y++) {
    for (let i = 0; i < cols; i++) out.push({ x: y % 2 ? cols - 1 - i : i, y });
  }
  return out;
}

export function demoBoard() {
  const cells = snakePath(6, 5).map((p) => ({ ...p, type: 'empty' }));
  const set = (i, c) => Object.assign(cells[i], c);
  set(0, { type: 'start', label: 'Start' });
  set(3, { type: 'prize', label: 'Airdrop', token: 'GRAM', amount: 2 });
  set(5, { type: 'jump', label: 'Rocket', to: 13 });
  set(7, { type: 'task', label: 'Quiz', question: 'Which blockchain is GRAM built on?', options: ['Bitcoin', 'TON', 'Solana'], answer: 1, reward: { token: 'GRAM', amount: 3 }, bonusTurns: 1 });
  set(9, { type: 'skip', label: 'Gas spike', turns: 1 });
  set(11, { type: 'chance', label: 'Chance', outcomes: [
    { text: 'A whale tips you', kind: 'prize', token: 'GRAM', amount: 5 },
    { text: 'Network congestion', kind: 'move', steps: -3 },
    { text: 'Lucky block', kind: 'bonus', turns: 2 },
    { text: 'Nothing happens', kind: 'none' },
  ] });
  set(14, { type: 'bonus', label: 'Free roll', turns: 1 });
  set(16, { type: 'move', label: 'Tailwind', steps: 3 });
  set(18, { type: 'prize', label: 'Staking', token: 'USDT', amount: 1 });
  set(20, { type: 'task', label: 'Quiz', question: 'What do you call a wallet’s secret recovery words?', options: ['Seed phrase', 'Hash', 'Gas'], answer: 0, reward: { token: 'USDT', amount: 2 } });
  set(22, { type: 'jump', label: 'Rug pull', to: 10 });
  set(24, { type: 'chance', label: 'Chance', outcomes: [
    { text: 'Bug bounty paid out', kind: 'prize', token: 'USDT', amount: 3 },
    { text: 'Fat-finger trade', kind: 'skip', turns: 1 },
  ] });
  set(26, { type: 'move', label: 'FUD', steps: -4 });
  set(27, { type: 'prize', label: 'Jackpot', token: 'GRAM', amount: 10 });
  set(29, { type: 'finish', label: 'Moon' });
  return normalizeBoard({ name: 'To the Moon', cols: 6, rows: 5, cells });
}

export function seed(db) {
  if (Object.keys(db.data.boards).length) return;
  const board = { id: newId('b'), ...demoBoard(), updatedAt: Date.now() };
  db.data.boards[board.id] = board;
  const game = newGame({
    id: newId('g'),
    name: 'Demo race',
    board,
    turnPrice: 1,
    maxPlayers: 6,
    endAfter: 1,
    finishPrizes: [{ token: 'GRAM', amount: 50 }],
  });
  game.boardId = board.id;
  startGame(game);
  db.data.games[game.id] = game;
  db.save();
}
