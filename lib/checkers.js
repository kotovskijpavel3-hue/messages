'use strict';

/**
 * Русские шашки: правила и валидация ходов.
 *
 * Доска — массив из 64 клеток, индекс = row * 8 + col.
 *   '.' — пусто
 *   'w' — белая простая, 'W' — белая дамка
 *   'b' — чёрная простая, 'B' — чёрная дамка
 *
 * Белые стоят внизу и идут вверх (row уменьшается), чёрные — наоборот.
 * Играбельные клетки — те, где (row + col) нечётное.
 *
 * Реализованные правила:
 *  - простая ходит на одну клетку вперёд, бьёт в любую из четырёх сторон;
 *  - дамка ходит на любое расстояние по диагонали и бьёт «с лету»
 *    (встаёт на любую свободную клетку за побитой);
 *  - бой обязателен, при нескольких вариантах игрок выбирает любой;
 *  - начатый бой нужно довести до конца (пока есть чем бить);
 *  - простая, дошедшая до последней линии, становится дамкой;
 *    если бой продолжается — превращение происходит только после его завершения;
 *  - поражение — когда у игрока нет ни одного законного хода;
 *  - ничья — 30 ходов подряд без боя и без ходов простыми.
 */

const SIZE = 8;
const EMPTY = '.';
const DIRS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

const inside = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const idx = (r, c) => r * SIZE + c;
const colorOf = (p) => (!p || p === EMPTY ? null : p.toLowerCase());
const isKing = (p) => p === 'W' || p === 'B';
const other = (color) => (color === 'w' ? 'b' : 'w');
const backRow = (color) => (color === 'w' ? 0 : 7);
const forward = (color) => (color === 'w' ? -1 : 1);

const DRAW_PLIES = 60;

function createBoard() {
  const board = new Array(SIZE * SIZE).fill(EMPTY);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if ((r + c) % 2 !== 1) continue; // играем только на тёмных клетках
      if (r <= 2) board[idx(r, c)] = 'b';
      else if (r >= 5) board[idx(r, c)] = 'w';
    }
  }
  return board;
}

function createState() {
  return {
    board: createBoard(),
    turn: 'w',
    pendingFrom: null, // [r, c] — фигура, обязанная продолжить бой
    idle: 0, // полуходы без боя и без хода простой
    ply: 0,
    status: 'playing', // 'playing' | 'over'
    winner: null, // 'w' | 'b' | null (ничья)
    reason: null, // 'no-moves' | 'draw' | 'resign' | 'timeout'
    lastMove: null,
  };
}

/** Все взятия конкретной фигурой (по одной пересадке). */
function capturesFrom(board, from, color) {
  const [r, c] = from;
  const piece = board[idx(r, c)];
  const out = [];
  if (!piece || piece === EMPTY || colorOf(piece) !== color) return out;

  if (isKing(piece)) {
    for (const [dr, dc] of DIRS) {
      let rr = r + dr;
      let cc = c + dc;
      while (inside(rr, cc) && board[idx(rr, cc)] === EMPTY) {
        rr += dr;
        cc += dc;
      }
      if (!inside(rr, cc)) continue;
      if (colorOf(board[idx(rr, cc)]) !== other(color)) continue;
      const capR = rr;
      const capC = cc;
      let lr = rr + dr;
      let lc = cc + dc;
      while (inside(lr, lc) && board[idx(lr, lc)] === EMPTY) {
        out.push({ from: [r, c], to: [lr, lc], capture: [capR, capC] });
        lr += dr;
        lc += dc;
      }
    }
    return out;
  }

  for (const [dr, dc] of DIRS) {
    const mr = r + dr;
    const mc = c + dc;
    const lr = r + 2 * dr;
    const lc = c + 2 * dc;
    if (!inside(lr, lc)) continue;
    if (colorOf(board[idx(mr, mc)]) !== other(color)) continue;
    if (board[idx(lr, lc)] !== EMPTY) continue;
    out.push({ from: [r, c], to: [lr, lc], capture: [mr, mc] });
  }
  return out;
}

/** Все ходы стороны. Если есть бой — только бои. */
function legalMoves(board, turn, pendingFrom = null) {
  if (pendingFrom) {
    // продолжение начатого боя: ходит только эта фигура и только боем
    const forced = board[idx(pendingFrom[0], pendingFrom[1])];
    if (!forced || colorOf(forced) !== turn) return [];
    return capturesFrom(board, pendingFrom, turn);
  }

  const pieces = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (colorOf(board[idx(r, c)]) === turn) pieces.push([r, c]);
    }
  }

  const captures = [];
  for (const p of pieces) captures.push(...capturesFrom(board, p, turn));
  if (captures.length) return captures;

  const moves = [];
  for (const p of pieces) {
    const [r, c] = p;
    const king = isKing(board[idx(r, c)]);
    for (const [dr, dc] of DIRS) {
      if (!king) {
        if (dr !== forward(turn)) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (inside(nr, nc) && board[idx(nr, nc)] === EMPTY) {
          moves.push({ from: p, to: [nr, nc], capture: null });
        }
        continue;
      }
      let nr = r + dr;
      let nc = c + dc;
      while (inside(nr, nc) && board[idx(nr, nc)] === EMPTY) {
        moves.push({ from: p, to: [nr, nc], capture: null });
        nr += dr;
        nc += dc;
      }
    }
  }
  return moves;
}

/** Ходы только для одной клетки — удобно для подсветки в интерфейсе. */
function movesFrom(board, turn, pendingFrom, from) {
  return legalMoves(board, turn, pendingFrom).filter(
    (m) => m.from[0] === from[0] && m.from[1] === from[1],
  );
}

function sameCell(a, b) {
  return Boolean(a && b) && a[0] === b[0] && a[1] === b[1];
}

function finishGame(state, winner, reason) {
  state.status = 'over';
  state.winner = winner;
  state.reason = reason;
  state.pendingFrom = null;
}

/**
 * Применить ход одной фигуры (одна пересадка при бое).
 * Возвращает { ok: true, move } либо { ok: false, error }.
 */
function applyMove(state, from, to) {
  if (state.status !== 'playing') return { ok: false, error: 'Партия уже закончена' };
  if (!Array.isArray(from) || !Array.isArray(to)) return { ok: false, error: 'Некорректный ход' };
  if (!inside(from[0], from[1]) || !inside(to[0], to[1])) {
    return { ok: false, error: 'Ход за пределами доски' };
  }

  const options = legalMoves(state.board, state.turn, state.pendingFrom);
  const move = options.find((m) => sameCell(m.from, from) && sameCell(m.to, to));
  if (!move) {
    return {
      ok: false,
      error: state.pendingFrom ? 'Нужно продолжить бой этой же фигурой' : 'Так ходить нельзя',
    };
  }

  const color = state.turn;
  const piece = state.board[idx(from[0], from[1])];
  const wasMan = !isKing(piece);

  state.board[idx(from[0], from[1])] = EMPTY;
  state.board[idx(to[0], to[1])] = piece;

  if (move.capture) {
    state.board[idx(move.capture[0], move.capture[1])] = EMPTY;
    state.idle = 0;
  } else if (wasMan) {
    state.idle = 0; // простая сдвинулась — счётчик «тихих» ходов обнуляется
  } else {
    state.idle += 1; // ход дамкой без боя
  }

  state.ply += 1;
  state.lastMove = { from: [from[0], from[1]], to: [to[0], to[1]], capture: move.capture };

  // Есть ли продолжение боя этой же фигурой?
  const continues = move.capture ? capturesFrom(state.board, to, color).length > 0 : false;

  if (continues) {
    state.pendingFrom = [to[0], to[1]];
    return { ok: true, move, continues: true };
  }

  // Превращение только когда ход (или вся цепочка боя) завершён
  if (wasMan && to[0] === backRow(color)) {
    state.board[idx(to[0], to[1])] = color === 'w' ? 'W' : 'B';
  }

  state.pendingFrom = null;
  state.turn = other(color);

  if (!legalMoves(state.board, state.turn, null).length) {
    finishGame(state, color, 'no-moves');
    return { ok: true, move, gameOver: true };
  }
  if (state.idle >= DRAW_PLIES) {
    finishGame(state, null, 'draw');
    return { ok: true, move, gameOver: true };
  }
  return { ok: true, move };
}

function countPieces(board) {
  const res = { w: 0, b: 0, wk: 0, bk: 0 };
  for (const p of board) {
    if (p === 'w') res.w += 1;
    else if (p === 'b') res.b += 1;
    else if (p === 'W') {
      res.w += 1;
      res.wk += 1;
    } else if (p === 'B') {
      res.b += 1;
      res.bk += 1;
    }
  }
  return res;
}

module.exports = {
  SIZE,
  EMPTY,
  DIRS,
  DRAW_PLIES,
  createBoard,
  createState,
  legalMoves,
  movesFrom,
  capturesFrom,
  applyMove,
  countPieces,
  colorOf,
  isKing,
  idx,
  inside,
  other,
};
