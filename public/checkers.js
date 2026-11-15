/* Доска шашек: отрисовка и выбор хода. Правила проверяет сервер. */
(function () {
  'use strict';

  const SIZE = 8;
  const sameCell = (a, b) => Boolean(a && b) && a[0] === b[0] && a[1] === b[1];

  function createBoard() {
    const board = new Array(64).fill('.');
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        if ((r + c) % 2 !== 1) continue;
        if (r <= 2) board[r * SIZE + c] = 'b';
        else if (r >= 5) board[r * SIZE + c] = 'w';
      }
    }
    return board;
  }

  function create(root, options) {
    const opts = options || {};
    let game = null;
    let meId = null;
    let flip = false;
    let selected = null;
    let cells = [];

    root.innerHTML = '';
    for (let d = 0; d < 64; d += 1) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.d = String(d);
      cell.addEventListener('click', () => handleClick(Number(cell.dataset.bi)));
      root.appendChild(cell);
      cells.push(cell);
    }

    function displayIndex(r, c) {
      return flip ? (7 - r) * SIZE + (7 - c) : r * SIZE + c;
    }

    function boardIndex(d) {
      const r = Math.floor(d / SIZE);
      const c = d % SIZE;
      return flip ? (7 - r) * SIZE + (7 - c) : r * SIZE + c;
    }

    function mySide() {
      if (!game || !meId) return null;
      if (game.white && game.white.id === meId) return 'w';
      if (game.black && game.black.id === meId) return 'b';
      return null;
    }

    function legalFrom(bi) {
      if (!game || !Array.isArray(game.moves)) return [];
      return game.moves.filter((m) => m.from[0] * SIZE + m.from[1] === bi);
    }

    function update(nextGame, nextMeId) {
      game = nextGame || null;
      meId = nextMeId || null;
      flip = mySide() === 'b';

      const board = game && Array.isArray(game.board) ? game.board : createBoard();
      const turn = game ? game.turn : 'w';
      const side = mySide();
      const myTurn = Boolean(game && side && game.turn === side && game.status === 'playing');

      if (!game) selected = null;
      else if (game.pendingFrom) selected = game.pendingFrom;
      else if (selected && !legalFrom(selected[0] * SIZE + selected[1]).length) selected = null;

      const targets = selected
        ? game.moves.filter((m) => sameCell(m.from, selected))
        : [];

      for (let d = 0; d < 64; d += 1) {
        const bi = boardIndex(d);
        const r = Math.floor(bi / SIZE);
        const c = bi % SIZE;
        const cell = cells[d];
        cell.dataset.bi = String(bi);
        cell.className = 'cell' + ((r + c) % 2 === 1 ? ' dark' : '');
        cell.innerHTML = '';

        const piece = board[bi];
        if (piece && piece !== '.') {
          const el = document.createElement('span');
          const color = piece.toLowerCase();
          const king = piece === 'W' || piece === 'B';
          el.className = `piece ${color}${king ? ' king' : ''}`;
          if (side && color === side) el.classList.add('mine');
          cell.appendChild(el);
          if (myTurn && side === color && legalFrom(bi).length) cell.classList.add('movable');
        }

        if (selected && sameCell(selected, [r, c])) cell.classList.add('selected');
        if (game && game.pendingFrom && sameCell(game.pendingFrom, [r, c])) cell.classList.add('pending');

        if (game && game.lastMove) {
          const from = game.lastMove.from;
          const to = game.lastMove.to;
          if ((from[0] === r && from[1] === c) || (to[0] === r && to[1] === c)) cell.classList.add('last');
        }

        const target = targets.find((m) => m.to[0] === r && m.to[1] === c);
        if (target) {
          cell.classList.add('target');
          if (target.capture) cell.classList.add('capture');
        }

        if (myTurn && side === turn) cell.classList.add('live');
      }
    }

    function handleClick(bi) {
      if (!game || game.status !== 'playing') return;
      const side = mySide();
      if (!side || game.turn !== side) return;

      const moves = game.moves || [];
      const mine = moves.filter((m) => m.from[0] * SIZE + m.from[1] === bi);

      if (game.pendingFrom) {
        const forced = game.pendingFrom;
        const target = moves.find(
          (m) => sameCell(m.from, forced) && m.to[0] * SIZE + m.to[1] === bi,
        );
        if (target && opts.onMove) opts.onMove(forced, target.to);
        return;
      }

      if (selected) {
        const target = moves.find(
          (m) => sameCell(m.from, selected) && m.to[0] * SIZE + m.to[1] === bi,
        );
        if (target) {
          if (opts.onMove) opts.onMove(selected, target.to);
          selected = null;
          return;
        }
      }

      if (mine.length) {
        selected = [Math.floor(bi / SIZE), bi % SIZE];
        update(game, meId);
      } else {
        selected = null;
        update(game, meId);
      }
    }

    return {
      update,
      reset() {
        game = null;
        meId = null;
        selected = null;
        update(null, null);
      },
    };
  }

  window.CheckersUI = { create };
}());
