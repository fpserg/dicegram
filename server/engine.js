// Pure game rules: board validation, movement, cell effects, finishing.
// No I/O here — the server owns balances and persistence, this module only
// mutates the game object it is handed.
import crypto from 'node:crypto';

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const CELL_TYPES = ['start', 'finish', 'empty', 'prize', 'move', 'jump', 'skip', 'bonus', 'task', 'chance'];
export const CHANCE_KINDS = ['none', 'prize', 'move', 'bonus', 'skip'];
export const PLAYER_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#14b8a6', '#ec4899'];
const LOG_LIMIT = 100;

export const amt = (x) => Math.round(Number(x) * 1e9) / 1e9;
export const defaultRng = (min, max) => crypto.randomInt(min, max + 1);

// ---------- board validation ----------

const isInt = (v) => Number.isInteger(v);
const HEX = /^#[0-9a-fA-F]{6}$/;
const TOKEN = /^[A-Z0-9]{2,10}$/;

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function reward(src, errors, where) {
  const token = str(src?.token, 10).toUpperCase() || 'GRAM';
  const amount = amt(src?.amount);
  if (!TOKEN.test(token)) errors.push(`${where}: token must be 2–10 letters/digits`);
  if (!(amount > 0) || amount > 1e9) errors.push(`${where}: amount must be a positive number`);
  return { token, amount };
}

function effectFields(kind, src, errors, where) {
  switch (kind) {
    case 'prize': return reward(src, errors, where);
    case 'move': {
      const steps = Number(src?.steps);
      if (!isInt(steps) || steps === 0 || Math.abs(steps) > 50) errors.push(`${where}: steps must be a non-zero whole number (−50…50)`);
      return { steps };
    }
    case 'skip':
    case 'bonus': {
      const turns = Number(src?.turns);
      if (!isInt(turns) || turns < 1 || turns > 10) errors.push(`${where}: turns must be 1–10`);
      return { turns };
    }
    default: return {};
  }
}

// Returns a cleaned copy of the board or throws GameError listing every problem.
export function normalizeBoard(input) {
  const errors = [];
  const name = str(input?.name, 60);
  if (!name) errors.push('Board name is required');
  const cols = Number(input?.cols);
  const rows = Number(input?.rows);
  if (!isInt(cols) || cols < 3 || cols > 20) errors.push('Columns must be 3–20');
  if (!isInt(rows) || rows < 3 || rows > 20) errors.push('Rows must be 3–20');

  const t = input?.theme || {};
  const theme = {
    bg: HEX.test(t.bg) ? t.bg : '#0f172a',
    cell: HEX.test(t.cell) ? t.cell : '#1e293b',
    path: HEX.test(t.path) ? t.path : '#334155',
    text: HEX.test(t.text) ? t.text : '#e2e8f0',
  };

  const src = Array.isArray(input?.cells) ? input.cells : [];
  if (src.length < 2 || src.length > 200) errors.push('A board needs 2–200 cells');
  const last = src.length - 1;
  const seen = new Set();

  const cells = src.map((c, i) => {
    const where = `Cell ${i}`;
    const x = Number(c?.x);
    const y = Number(c?.y);
    if (!isInt(x) || !isInt(y) || x < 0 || y < 0 || x >= cols || y >= rows) errors.push(`${where}: position is outside the grid`);
    else if (seen.has(`${x},${y}`)) errors.push(`${where}: another cell already sits at ${x},${y}`);
    seen.add(`${x},${y}`);

    const type = c?.type;
    if (!CELL_TYPES.includes(type)) errors.push(`${where}: unknown type "${type}"`);
    if (i === 0 && type !== 'start') errors.push('The first cell must be the start');
    if (i === last && type !== 'finish') errors.push('The last cell must be the finish');
    if (i !== 0 && type === 'start') errors.push(`${where}: only the first cell can be the start`);
    if (i !== last && type === 'finish') errors.push(`${where}: only the last cell can be the finish`);

    const cell = { x, y, type, label: str(c?.label, 24) };
    if (HEX.test(c?.color)) cell.color = c.color;

    if (type === 'prize' || type === 'move' || type === 'skip' || type === 'bonus') {
      Object.assign(cell, effectFields(type, c, errors, where));
    } else if (type === 'jump') {
      cell.to = Number(c?.to);
      if (!isInt(cell.to) || cell.to < 0 || cell.to > last || cell.to === i) errors.push(`${where}: jump target must be another cell index (0–${last})`);
    } else if (type === 'task') {
      cell.question = str(c?.question, 300);
      cell.options = Array.isArray(c?.options) ? c.options.map((o) => str(o, 80)).filter(Boolean).slice(0, 6) : [];
      cell.answer = Number(c?.answer);
      if (!cell.question) errors.push(`${where}: task needs a question`);
      if (cell.options.length < 2) errors.push(`${where}: task needs at least 2 answer options`);
      if (!isInt(cell.answer) || cell.answer < 0 || cell.answer >= cell.options.length) errors.push(`${where}: pick which option is correct`);
      cell.reward = reward(c?.reward, errors, `${where} reward`);
      const bonusTurns = Number(c?.bonusTurns ?? 0);
      cell.bonusTurns = isInt(bonusTurns) && bonusTurns >= 0 && bonusTurns <= 10 ? bonusTurns : 0;
    } else if (type === 'chance') {
      const outcomes = Array.isArray(c?.outcomes) ? c.outcomes.slice(0, 12) : [];
      if (outcomes.length < 1) errors.push(`${where}: chance needs at least one outcome`);
      cell.outcomes = outcomes.map((o, k) => {
        const kind = CHANCE_KINDS.includes(o?.kind) ? o.kind : 'none';
        return { text: str(o?.text, 120) || 'Nothing happens.', kind, ...effectFields(kind, o, errors, `${where} outcome ${k + 1}`) };
      });
    }
    return cell;
  });

  if (errors.length) throw new GameError(errors.join('\n'));
  return { name, cols, rows, theme, cells };
}

// Board as players may see it: correct task answers are removed.
export function publicBoard(board) {
  return {
    ...board,
    cells: board.cells.map((c) => {
      if (c.type !== 'task') return c;
      const { answer, ...rest } = c;
      return rest;
    }),
  };
}

// ---------- game lifecycle ----------

export function newGame({ id, name, board, turnPrice = 1, maxPlayers = 8, endAfter = 1, finishPrizes = [] }) {
  const errors = [];
  const cleanName = str(name, 60);
  if (!cleanName) errors.push('Game name is required');
  if (!(turnPrice > 0) || turnPrice > 1e6) errors.push('Turn price must be positive');
  if (!isInt(maxPlayers) || maxPlayers < 1 || maxPlayers > PLAYER_COLORS.length) errors.push(`Max players must be 1–${PLAYER_COLORS.length}`);
  if (!isInt(endAfter) || endAfter < 1 || endAfter > PLAYER_COLORS.length) errors.push('Game must end after 1–8 finishers');
  const prizes = (Array.isArray(finishPrizes) ? finishPrizes : []).slice(0, 8).map((p, i) => reward(p, errors, `Finish prize #${i + 1}`));
  if (errors.length) throw new GameError(errors.join('\n'));
  return {
    id,
    name: cleanName,
    board: structuredClone(board), // snapshot: later board edits never affect this game
    status: 'lobby',
    turnPrice: amt(turnPrice),
    maxPlayers,
    endAfter,
    finishPrizes: prizes,
    players: [],
    finishers: 0,
    seq: 0,
    lastMove: null,
    log: [],
    createdAt: Date.now(),
  };
}

function log(game, text, userId = null) {
  game.log.push({ at: Date.now(), userId, text });
  if (game.log.length > LOG_LIMIT) game.log.splice(0, game.log.length - LOG_LIMIT);
}

export function getPlayer(game, userId) {
  const p = game.players.find((x) => x.userId === userId);
  if (!p) throw new GameError('You have not joined this game', 403);
  return p;
}

export function joinGame(game, user) {
  if (game.status === 'finished') throw new GameError('This game is over');
  if (game.players.some((p) => p.userId === user.id)) return game.players.find((p) => p.userId === user.id);
  if (game.players.length >= game.maxPlayers) throw new GameError('The game is full');
  const used = new Set(game.players.map((p) => p.color));
  const player = {
    userId: user.id,
    name: user.name,
    color: PLAYER_COLORS.find((c) => !used.has(c)),
    pos: 0,
    turns: 0, // paid turns, refundable when the game ends
    freeTurns: 0, // won on the board, spent first, not refundable
    frozen: 0,
    place: 0,
    pendingTask: null,
    prizes: {},
  };
  game.players.push(player);
  log(game, `${user.name} joined the game`, user.id);
  return player;
}

export function startGame(game) {
  if (game.status !== 'lobby') throw new GameError('Only a game in the lobby can be started');
  game.status = 'running';
  game.startedAt = Date.now();
  log(game, 'The game has started — roll the dice!');
}

export function endGame(game, reason) {
  if (game.status === 'finished') throw new GameError('The game is already over');
  game.status = 'finished';
  game.endedAt = Date.now();
  log(game, reason || 'The game has ended');
}

function addPrize(game, p, { token, amount }) {
  p.prizes[token] = amt((p.prizes[token] || 0) + amount);
  return `+${amount} ${token}`;
}

// Apply a prize/move/bonus/skip effect; shared by plain cells and chance outcomes.
function applyEffect(game, p, effect) {
  const last = game.board.cells.length - 1;
  switch (effect.kind) {
    case 'prize': return `won ${addPrize(game, p, effect)}`;
    case 'move': {
      p.pos = Math.max(0, Math.min(last, p.pos + effect.steps));
      return effect.steps > 0 ? `moves ${effect.steps} forward to cell ${p.pos}` : `moves ${-effect.steps} back to cell ${p.pos}`;
    }
    case 'bonus':
      p.freeTurns += effect.turns;
      return `gets ${effect.turns} free turn${effect.turns > 1 ? 's' : ''}`;
    case 'skip':
      p.frozen += effect.turns;
      return `will skip the next ${effect.turns > 1 ? `${effect.turns} rolls` : 'roll'}`;
    default: return '';
  }
}

function landOn(game, p, rng) {
  const cell = game.board.cells[p.pos];
  const who = p.name;
  switch (cell.type) {
    case 'prize':
    case 'move':
    case 'bonus':
    case 'skip':
      log(game, `${who} ${applyEffect(game, p, { kind: cell.type, ...cell })}`, p.userId);
      break;
    case 'jump': {
      const up = cell.to > p.pos;
      p.pos = cell.to;
      log(game, `${who} ${up ? 'climbs' : 'slides'} to cell ${cell.to}`, p.userId);
      break;
    }
    case 'task':
      p.pendingTask = game.board.cells.indexOf(cell);
      log(game, `${who} must solve a task`, p.userId);
      break;
    case 'chance': {
      const o = cell.outcomes[rng(0, cell.outcomes.length - 1)];
      const effect = applyEffect(game, p, o);
      log(game, `${who} draws a card: “${o.text}”${effect ? ` — ${effect}` : ''}`, p.userId);
      break;
    }
    default:
  }
}

function checkFinish(game, p) {
  const last = game.board.cells.length - 1;
  if (p.pos !== last || p.place) return;
  p.place = ++game.finishers;
  p.pendingTask = null;
  const prize = game.finishPrizes[p.place - 1];
  log(game, `${p.name} reached the finish in place #${p.place}${prize ? ` and won ${addPrize(game, p, prize)}` : ''}`, p.userId);
  if (game.finishers >= Math.min(game.endAfter, game.players.length)) endGame(game, 'The game is over — prizes can now be withdrawn');
}

// One paid (or free) turn: roll a die, walk, resolve the landing cell.
export function roll(game, userId, rng = defaultRng) {
  if (game.status !== 'running') throw new GameError(game.status === 'lobby' ? 'The game has not started yet' : 'The game is over');
  const p = getPlayer(game, userId);
  if (p.place) throw new GameError('You already reached the finish');
  if (p.pendingTask !== null) throw new GameError('Answer your task first');
  if (p.freeTurns > 0) p.freeTurns--;
  else if (p.turns > 0) p.turns--;
  else throw new GameError('No turns left — buy more turns with GRAM');

  const value = rng(1, 6);
  const from = p.pos;
  game.seq++;
  if (p.frozen > 0) {
    p.frozen--;
    game.lastMove = { seq: game.seq, userId, value, from, landed: from, to: from, skipped: true };
    log(game, `${p.name} rolled ${value} but has to skip this roll`, userId);
    return { value, skipped: true };
  }
  const last = game.board.cells.length - 1;
  p.pos = Math.min(from + value, last);
  const landed = p.pos;
  log(game, `${p.name} rolled ${value} → cell ${landed}`, userId);
  if (landed !== last) landOn(game, p, rng);
  game.lastMove = { seq: game.seq, userId, value, from, landed, to: p.pos };
  checkFinish(game, p);
  return { value };
}

// option === null skips the task without a reward.
export function answerTask(game, userId, option) {
  if (game.status !== 'running') throw new GameError('The game is not running');
  const p = getPlayer(game, userId);
  if (p.pendingTask === null) throw new GameError('You have no task to answer');
  const cell = game.board.cells[p.pendingTask];
  p.pendingTask = null;
  if (option === null) {
    log(game, `${p.name} skipped the task`, userId);
    return { correct: false };
  }
  const correct = Number(option) === cell.answer;
  if (correct) {
    let text = `${p.name} solved the task and won ${addPrize(game, p, cell.reward)}`;
    if (cell.bonusTurns) {
      p.freeTurns += cell.bonusTurns;
      text += ` and ${cell.bonusTurns} free turn${cell.bonusTurns > 1 ? 's' : ''}`;
    }
    log(game, text, userId);
  } else {
    log(game, `${p.name} answered the task wrong`, userId);
  }
  return { correct, answer: cell.answer };
}

// What the game looks like to everyone (no task answers).
export function publicGame(game) {
  const { board, ...rest } = game;
  return { ...rest, board: publicBoard(board) };
}
