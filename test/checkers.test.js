import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../lib/checkers.js';

const EMPTY = Array(8).fill('........');

function rowsWith(pieces) {
  const grid = EMPTY.map((row) => row.split(''));
  for (const [key, piece] of Object.entries(pieces)) {
    const [r, col] = key.split(',').map(Number);
    grid[r][col] = piece;
  }
  return grid.map((row) => row.join(''));
}

function boardOf(pieces) {
  return rowsWith(pieces).join('').split('');
}

function stateOf(pieces, turn = 'w') {
  return {
    board: boardOf(pieces),
    turn,
    pendingFrom: null,
    idle: 0,
    ply: 0,
    status: 'playing',
    winner: null,
    reason: null,
    lastMove: null,
  };
}

test('стартовая позиция: по 12 шашек, у белых 7 ходов', () => {
  const state = c.createState();
  const counts = c.countPieces(state.board);
  assert.equal(counts.w, 12);
  assert.equal(counts.b, 12);

  const moves = c.legalMoves(state.board, 'w');
  assert.equal(moves.length, 7);
  assert.ok(moves.every((m) => m.from[0] === 5 && m.to[0] === 4));
  assert.equal(c.legalMoves(state.board, 'b').length, 7);
});

test('бой обязателен: тихий ход запрещён, когда есть взятие', () => {
  const state = stateOf({ '4,3': 'w', '3,4': 'b', '6,1': 'w' });
  const moves = c.legalMoves(state.board, 'w');
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].from, [4, 3]);
  assert.deepEqual(moves[0].to, [2, 5]);
  assert.deepEqual(moves[0].capture, [3, 4]);

  const bad = c.applyMove(state, [6, 1], [5, 0]);
  assert.equal(bad.ok, false);
});

test('простая бьёт назад (русские шашки)', () => {
  const state = stateOf({ '4,3': 'w', '5,4': 'b' });
  const moves = c.legalMoves(state.board, 'w');
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].to, [6, 5]);
});

test('простая не ходит назад без боя', () => {
  const state = stateOf({ '4,3': 'w' });
  const moves = c.legalMoves(state.board, 'w');
  assert.deepEqual(moves.map((m) => m.to).sort(), [[3, 2], [3, 4]]);
});

test('дамка ходит по диагонали на любое расстояние', () => {
  const state = stateOf({ '7,0': 'W' });
  const moves = c.legalMoves(state.board, 'w');
  assert.equal(moves.length, 7);
  assert.deepEqual(
    moves.map((m) => m.to).sort(),
    [[0, 7], [1, 6], [2, 5], [3, 4], [4, 3], [5, 2], [6, 1]],
  );
});

test('цепочка боя: ход не передаётся, пока бой не закончен', () => {
  const state = stateOf({ '5,2': 'W', '3,4': 'b', '1,6': 'b' }, 'w');
  const first = c.applyMove(state, [5, 2], [2, 5]);
  assert.equal(first.ok, true);
  assert.equal(first.continues, true);
  assert.deepEqual(state.pendingFrom, [2, 5]);
  assert.equal(state.turn, 'w');
  assert.equal(state.board[c.idx(3, 4)], '.');
  assert.equal(state.board[c.idx(1, 6)], 'b');

  const wrongPiece = c.applyMove(state, [0, 1], [1, 2]);
  assert.equal(wrongPiece.ok, false);

  const second = c.applyMove(state, [2, 5], [0, 7]);
  assert.equal(second.ok, true);
  assert.equal(state.pendingFrom, null);
  assert.equal(state.turn, 'b');
  assert.equal(state.board[c.idx(1, 6)], '.');
  assert.equal(state.board[c.idx(0, 7)], 'W');
});

test('превращение только после завершения боя', () => {
  const state = stateOf({ '2,1': 'w', '1,2': 'b', '1,4': 'b' }, 'w');
  const first = c.applyMove(state, [2, 1], [0, 3]);
  assert.equal(first.ok, true);
  assert.equal(first.continues, true);
  // на последней линии, но бой не закончен — остаётся простой
  assert.equal(state.board[c.idx(0, 3)], 'w');
  assert.deepEqual(state.pendingFrom, [0, 3]);

  const second = c.applyMove(state, [0, 3], [2, 5]);
  assert.equal(second.ok, true);
  assert.equal(state.board[c.idx(2, 5)], 'w');
  assert.equal(state.turn, 'b');
});

test('простая становится дамкой на последней линии', () => {
  const state = stateOf({ '1,2': 'w', '7,7': 'b' }, 'w');
  const result = c.applyMove(state, [1, 2], [0, 3]);
  assert.equal(result.ok, true);
  assert.equal(state.board[c.idx(0, 3)], 'W');
});

test('дамка бьёт с лету и выбирает любую клетку приземления', () => {
  const state = stateOf({ '7,0': 'W', '3,4': 'b' }, 'w');
  const captures = c.legalMoves(state.board, 'w').filter((m) => m.capture);
  assert.deepEqual(captures.map((m) => m.to).sort(), [[0, 7], [1, 6], [2, 5]]);
});

test('победа, когда у соперника нет ходов', () => {
  const state = stateOf({ '1,0': 'w', '7,6': 'b' }, 'w');
  // чёрная шашка на 7,6 упирается в край и не может ходить
  assert.equal(c.legalMoves(state.board, 'b').length, 0);

  const result = c.applyMove(state, [1, 0], [0, 1]);
  assert.equal(result.ok, true);
  assert.equal(state.status, 'over');
  assert.equal(state.winner, 'w');
});

test('ничья после 60 полуходов без боя и без хода простой', () => {
  const state = stateOf({ '7,0': 'W', '0,7': 'B' }, 'w');
  state.idle = c.DRAW_PLIES - 1;
  const result = c.applyMove(state, [7, 0], [6, 1]);
  assert.equal(result.ok, true);
  assert.equal(state.status, 'over');
  assert.equal(state.winner, null);
  assert.equal(state.reason, 'draw');
});
