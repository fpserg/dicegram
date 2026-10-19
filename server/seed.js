// Demo content created on first start so there is something to play.
import { newGame, startGame } from '../public/shared/engine.js';
import { demoBoard } from '../public/shared/demo.js';
import { newId } from './db.js';

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
