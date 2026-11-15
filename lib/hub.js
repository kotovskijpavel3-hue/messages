/**
 * Ядро Messages Online: комнаты, чат, файлы, шашки.
 *
 * Не зависит от рантайма — работает и в Node, и в Deno.
 * Наружу отдаёт attach(websocket, url), file(id) и stats().
 * Всё состояние в памяти процесса.
 */

import * as checkers from './checkers.js';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

export const LIMITS = {
  nameLength: 24,
  textLength: 2000,
  roomNameLength: 40,
  fileBytes: 8 * 1024 * 1024,
  roomBytes: 120 * 1024 * 1024,
  filesPerRoom: 40,
  history: 200,
  rooms: 200,
  chatBurst: 12,
  chatWindowMs: 5000,
  idleMs: 120000,
};

const MAIN_ROOM = 'MAIN';

const PALETTE = [
  '#ff5c7c', '#38e8c8', '#ffd166', '#8b7bff',
  '#4cc9f0', '#ff8f4d', '#b6f36b', '#ff7bd5',
  '#7ee787', '#f78fb3', '#9ad0ff', '#ffab6b',
];

const ADJ = ['Быстрый', 'Тихий', 'Хитрый', 'Дерзкий', 'Лунный', 'Неоновый',
  'Сонный', 'Резкий', 'Пушистый', 'Космический', 'Ржавый', 'Стеклянный'];
const NOUN = ['Лис', 'Кит', 'Ёж', 'Барс', 'Кот', 'Ворон',
  'Спрут', 'Койот', 'Мотылёк', 'Дракон', 'Пингвин', 'Сурок'];

const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY34679';

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

const cleanLine = (value, max) => cleanText(value, max).replace(/\s+/g, ' ');

export const prettySize = (bytes) => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
};

function decodeBase64(value) {
  const clean = String(value == null ? '' : value).replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return null;
  let binary;
  try {
    binary = atob(clean);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return String(data == null ? '' : data);
}

const isOpen = (ws) => ws && ws.readyState === 1;

/**
 * @param {{ randomId?: () => string, randomInt?: (max: number) => number }} [options]
 */
export function createHub(options = {}) {
  const randomId = options.randomId || (() => Math.random().toString(36).slice(2, 12));
  const randomInt = options.randomInt || ((max) => Math.floor(Math.random() * max));
  const pick = (arr) => arr[randomInt(arr.length)];
  const shortId = () => randomId().slice(0, 12);
  const makeName = () => `${pick(ADJ)} ${pick(NOUN)}`;

  /** id -> пользователь */
  const users = new Map();
  /** code -> комната */
  const rooms = new Map();
  /** id -> файл */
  const files = new Map();
  /** id -> партия */
  const games = new Map();
  /** id -> вызов */
  const challenges = new Map();

  function normalizeCode(value) {
    const code = String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return code === 'MAIN' ? MAIN_ROOM : code;
  }

  function newRoomCode() {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      let code = '';
      for (let i = 0; i < 6; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    return `R${randomId().replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 5)}`;
  }

  /* ---------------- состояние комнат ---------------- */

  function makeRoom({ code, name, isPublic, hostId }) {
    const room = {
      code,
      name,
      isPublic,
      hostId: hostId || null,
      createdAt: Date.now(),
      members: new Set(),
      messages: [],
      files: [],
      bytes: 0,
      gameId: null,
    };
    rooms.set(code, room);
    return room;
  }

  const mainRoom = makeRoom({ code: MAIN_ROOM, name: 'Общий чат', isPublic: true, hostId: null });

  /* ---------------- представления ---------------- */

  const publicUser = (user) => ({ id: user.id, name: user.name, color: user.color });

  function onlineView() {
    return [...users.values()]
      .map((user) => {
        const room = rooms.get(user.roomCode);
        return {
          id: user.id,
          name: user.name,
          color: user.color,
          roomCode: user.roomCode,
          roomName: room ? room.name : '',
          inGame: Boolean(user.gameId),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  function fileMeta(file) {
    return {
      id: file.id,
      name: file.name,
      mime: file.mime,
      size: file.size,
      at: file.at,
      by: file.by,
      url: `/f/${file.id}/${encodeURIComponent(file.name)}`,
    };
  }

  function roomView(room) {
    return {
      code: room.code,
      name: room.name,
      isPublic: room.isPublic,
      hostId: room.hostId,
      bytes: room.bytes,
      gameId: room.gameId,
      members: [...room.members]
        .map((id) => users.get(id))
        .filter(Boolean)
        .map((user) => ({ ...publicUser(user), inGame: Boolean(user.gameId) })),
      files: room.files.map(fileMeta),
    };
  }

  function roomList(user) {
    return [...rooms.values()]
      .filter(
        (room) =>
          room.code === MAIN_ROOM ||
          room.isPublic ||
          (user && room.members.has(user.id)),
      )
      .map((room) => ({
        code: room.code,
        name: room.name,
        isPublic: room.isPublic,
        members: room.members.size,
        main: room.code === MAIN_ROOM,
      }))
      .sort((a, b) => (a.main ? -1 : b.main ? 1 : b.members - a.members));
  }

  function gameView(game) {
    const moves = checkers.legalMoves(game.state.board, game.state.turn, game.state.pendingFrom);
    return {
      id: game.id,
      roomCode: game.roomCode,
      white: game.white,
      black: game.black,
      board: game.state.board,
      turn: game.state.turn,
      pendingFrom: game.state.pendingFrom,
      status: game.state.status,
      winner: game.state.winner,
      reason: game.state.reason,
      ply: game.state.ply,
      lastMove: game.state.lastMove,
      drawOfferBy: game.drawOfferBy,
      moves: moves.map((move) => ({ from: move.from, to: move.to, capture: move.capture })),
    };
  }

  /* ---------------- отправка ---------------- */

  function send(ws, type, payload) {
    if (!isOpen(ws)) return;
    try {
      ws.send(JSON.stringify({ type, ...(payload || {}) }));
    } catch {
      /* сокет закрывается — молча */
    }
  }

  function broadcastAll(type, payload) {
    const data = JSON.stringify({ type, ...(payload || {}) });
    for (const user of users.values()) {
      if (!isOpen(user.ws)) continue;
      try {
        user.ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  function broadcastRoom(room, type, payload, exceptId) {
    if (!room) return;
    const data = JSON.stringify({ type, ...(payload || {}) });
    for (const id of room.members) {
      if (id === exceptId) continue;
      const user = users.get(id);
      if (!user || !isOpen(user.ws)) continue;
      try {
        user.ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  const pushOnline = () => broadcastAll('online', { users: onlineView(), total: users.size });

  function pushRooms() {
    for (const user of users.values()) {
      send(user.ws, 'rooms', { rooms: roomList(user) });
    }
  }

  const pushRoom = (room) => broadcastRoom(room, 'room', { room: roomView(room) });

  const notice = (user, text, level = 'info') => send(user.ws, 'notice', { text, level });

  /* ---------------- сообщения ---------------- */

  function pushMessage(room, message) {
    room.messages.push(message);
    if (room.messages.length > LIMITS.history) room.messages.shift();
    broadcastRoom(room, 'message', { message });
  }

  function addSystem(room, text) {
    pushMessage(room, { id: shortId(), kind: 'system', at: Date.now(), text });
  }

  /* ---------------- комнаты ---------------- */

  function destroyRoom(room) {
    for (const meta of room.files) files.delete(meta.id);
    if (room.gameId && games.has(room.gameId)) {
      const game = games.get(room.gameId);
      [game.white, game.black].forEach((player) => {
        const user = users.get(player.id);
        if (user && user.gameId === game.id) user.gameId = null;
      });
      games.delete(room.gameId);
    }
    rooms.delete(room.code);
  }

  function enterRoom(user, room) {
    if (user.roomCode === room.code) return;
    const previous = rooms.get(user.roomCode);
    if (previous) {
      previous.members.delete(user.id);
      if (previous.code !== MAIN_ROOM) {
        if (previous.members.size === 0) destroyRoom(previous);
        else {
          addSystem(previous, `${user.name} вышел`);
          pushRoom(previous);
        }
      }
    }

    user.roomCode = room.code;
    room.members.add(user.id);

    send(user.ws, 'room', { room: roomView(room), history: room.messages.slice(-LIMITS.history) });
    const game = room.gameId ? games.get(room.gameId) : null;
    send(user.ws, 'game', { game: game ? gameView(game) : null });

    addSystem(room, `${user.name} в комнате`);
    pushRoom(room);
    pushOnline();
    pushRooms();
  }

  /* ---------------- шашки ---------------- */

  function startGame(room, firstId, secondId) {
    const a = users.get(firstId);
    const b = users.get(secondId);
    if (!a || !b) return null;

    const [white, black] = randomInt(2) === 0 ? [a, b] : [b, a];
    const game = {
      id: shortId(),
      roomCode: room.code,
      white: publicUser(white),
      black: publicUser(black),
      state: checkers.createState(),
      createdAt: Date.now(),
      drawOfferBy: null,
    };

    games.set(game.id, game);
    if (room.gameId && games.has(room.gameId) && room.gameId !== game.id) games.delete(room.gameId);
    room.gameId = game.id;
    white.gameId = game.id;
    black.gameId = game.id;

    addSystem(room, `Партия: ${white.name} (белые) — ${black.name} (чёрные)`);
    broadcastRoom(room, 'game', { game: gameView(game) });
    pushRoom(room);
    pushOnline();
    return game;
  }

  function endGame(room, game, winner, reason) {
    game.state.status = 'over';
    game.state.winner = winner;
    game.state.reason = reason;
    game.state.pendingFrom = null;
    game.drawOfferBy = null;

    [game.white, game.black].forEach((player) => {
      const user = users.get(player.id);
      if (user && user.gameId === game.id) user.gameId = null;
    });

    let text;
    if (reason === 'draw') text = 'Ничья';
    else if (reason === 'resign') {
      text = `${winner === 'w' ? game.white.name : game.black.name} победил — соперник сдался`;
    } else text = `${winner === 'w' ? game.white.name : game.black.name} победил`;

    addSystem(room, text);
    broadcastRoom(room, 'game', { game: gameView(game) });
    pushRoom(room);
    pushOnline();
  }

  function currentGame(user) {
    const room = rooms.get(user.roomCode);
    if (!room || !room.gameId) return { room, game: null };
    return { room, game: games.get(room.gameId) || null };
  }

  function playerSide(game, userId) {
    if (!game) return null;
    if (game.white.id === userId) return 'w';
    if (game.black.id === userId) return 'b';
    return null;
  }

  /* ---------------- вызовы ---------------- */

  function sendChallenge(user, toId) {
    const target = users.get(toId);
    if (!target) return notice(user, 'Игрок уже не в сети', 'err');
    if (target.id === user.id) return notice(user, 'Себя вызвать нельзя', 'err');
    if (target.gameId) return notice(user, `${target.name} уже играет`, 'err');
    if (user.gameId) return notice(user, 'Вы уже играете', 'err');

    const room = rooms.get(user.roomCode);
    if (!room) return notice(user, 'Комната не найдена', 'err');

    const challenge = {
      id: shortId(),
      fromId: user.id,
      toId: target.id,
      roomCode: room.code,
      timer: null,
    };
    challenge.timer = setTimeout(() => {
      if (!challenges.has(challenge.id)) return;
      challenges.delete(challenge.id);
      const from = users.get(challenge.fromId);
      if (from) notice(from, 'Вызов истёк', 'info');
      send(target.ws, 'challengeGone', { id: challenge.id });
    }, 60000);
    if (challenge.timer && typeof challenge.timer.unref === 'function') challenge.timer.unref();
    challenges.set(challenge.id, challenge);

    send(target.ws, 'challenge', {
      challenge: {
        id: challenge.id,
        from: publicUser(user),
        roomCode: room.code,
        roomName: room.name,
      },
    });
    notice(user, `Вызов отправлен: ${target.name}`, 'ok');
  }

  function acceptChallenge(user, id) {
    const challenge = challenges.get(id);
    if (!challenge) return notice(user, 'Вызов больше неактуален', 'err');
    if (challenge.toId !== user.id) return notice(user, 'Это не ваш вызов', 'err');

    const from = users.get(challenge.fromId);
    challenges.delete(id);
    clearTimeout(challenge.timer);
    if (!from) return notice(user, 'Соперник уже вышел', 'err');

    const room = rooms.get(challenge.roomCode) || mainRoom;
    if (room.code !== user.roomCode) enterRoom(user, room);
    if (room.code !== from.roomCode) enterRoom(from, room);

    startGame(room, from.id, user.id);
    send(from.ws, 'challengeGone', { id });
  }

  function declineChallenge(user, id) {
    const challenge = challenges.get(id);
    if (!challenge) return;
    challenges.delete(id);
    clearTimeout(challenge.timer);
    const from = users.get(challenge.fromId);
    if (from) notice(from, `${user.name} отклонил вызов`, 'info');
  }

  /* ---------------- файлы ---------------- */

  function storeFile(user, room, payload) {
    const name = cleanLine(payload && payload.name, 120) || 'файл';
    const rawMime = String((payload && payload.mime) || '').slice(0, 120);
    const mime = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(rawMime)
      ? rawMime.toLowerCase()
      : 'application/octet-stream';

    const bytes = decodeBase64(payload && payload.data);
    if (!bytes || !bytes.length) return notice(user, 'Пустой файл', 'err');
    if (bytes.length > LIMITS.fileBytes) {
      return notice(user, `Файл больше ${prettySize(LIMITS.fileBytes)}`, 'err');
    }
    if (room.bytes + bytes.length > LIMITS.roomBytes) {
      return notice(user, `Лимит комнаты ${prettySize(LIMITS.roomBytes)} исчерпан`, 'err');
    }

    const id = randomId().slice(0, 16);
    const file = {
      id,
      name,
      mime,
      size: bytes.length,
      data: bytes,
      at: Date.now(),
      roomCode: room.code,
      by: publicUser(user),
    };
    files.set(id, file);
    room.files.unshift({ ...fileMeta(file) });
    room.bytes += bytes.length;

    while (room.files.length > LIMITS.filesPerRoom) {
      const dropped = room.files.pop();
      const stored = files.get(dropped.id);
      if (stored) {
        room.bytes -= stored.size;
        files.delete(dropped.id);
      }
    }

    pushMessage(room, {
      id: shortId(),
      kind: 'file',
      at: file.at,
      by: file.by,
      text: '',
      file: fileMeta(file),
    });
    pushRoom(room);
  }

  /* ---------------- подключение ---------------- */

  function freeColor() {
    const taken = new Set([...users.values()].map((user) => user.color));
    const free = PALETTE.filter((color) => !taken.has(color));
    return free.length ? pick(free) : pick(PALETTE);
  }

  function canChat(user) {
    const now = Date.now();
    user.chatTimes = user.chatTimes.filter((at) => now - at < LIMITS.chatWindowMs);
    if (user.chatTimes.length >= LIMITS.chatBurst) return false;
    user.chatTimes.push(now);
    return true;
  }

  function drop(user) {
    if (!user || user.dropped) return;
    user.dropped = true;

    const current = rooms.get(user.roomCode);
    users.delete(user.id);

    if (current) {
      current.members.delete(user.id);
      if (current.code !== MAIN_ROOM && current.members.size === 0) destroyRoom(current);
      else {
        addSystem(current, `${user.name} вышел`);
        pushRoom(current);
      }
    }

    for (const game of games.values()) {
      if (game.state.status !== 'playing') continue;
      const side = playerSide(game, user.id);
      if (!side) continue;
      const room = rooms.get(game.roomCode);
      if (room) endGame(room, game, checkers.other(side), 'resign');
    }

    pushOnline();
    pushRooms();
  }

  function handleMessage(user, raw) {
    let msg;
    try {
      msg = JSON.parse(toText(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    user.lastSeen = Date.now();
    const room = rooms.get(user.roomCode) || mainRoom;

    switch (msg.type) {
      case 'ping':
        send(user.ws, 'pong', { at: Date.now() });
        break;

      case 'setName': {
        const name = cleanLine(msg.name, LIMITS.nameLength);
        if (!name) return notice(user, 'Имя не может быть пустым', 'err');
        const old = user.name;
        user.name = name;
        addSystem(room, `${old} теперь ${name}`);
        pushRoom(room);
        pushOnline();
        break;
      }

      case 'chat': {
        if (!canChat(user)) return notice(user, 'Слишком часто — подождите пару секунд', 'err');
        const text = cleanText(msg.text, LIMITS.textLength);
        if (!text) return;
        pushMessage(room, {
          id: shortId(),
          kind: 'msg',
          at: Date.now(),
          by: publicUser(user),
          text,
        });
        break;
      }

      case 'typing':
        broadcastRoom(room, 'typing', { user: publicUser(user) }, user.id);
        break;

      case 'createRoom': {
        if (rooms.size >= LIMITS.rooms) return notice(user, 'Слишком много комнат, попробуйте позже', 'err');
        const name = cleanLine(msg.name, LIMITS.roomNameLength) || `Комната ${user.name}`;
        const created = makeRoom({
          code: newRoomCode(),
          name,
          isPublic: Boolean(msg.isPublic),
          hostId: user.id,
        });
        enterRoom(user, created);
        notice(user, `Комната создана: ${created.code}`, 'ok');
        pushRooms();
        break;
      }

      case 'joinRoom': {
        const target = rooms.get(normalizeCode(msg.code));
        if (!target) return notice(user, 'Комната не найдена', 'err');
        enterRoom(user, target);
        break;
      }

      case 'leaveRoom':
        if (user.roomCode === MAIN_ROOM) return;
        enterRoom(user, mainRoom);
        break;

      case 'upload':
        storeFile(user, room, msg);
        break;

      case 'challenge':
        sendChallenge(user, String(msg.toId || ''));
        break;

      case 'challengeReply':
        if (msg.accept) acceptChallenge(user, String(msg.id || ''));
        else declineChallenge(user, String(msg.id || ''));
        break;

      case 'invite': {
        const target = users.get(String(msg.toId || ''));
        if (!target || target.id === user.id) return;
        send(target.ws, 'invite', {
          invite: { roomCode: room.code, roomName: room.name, from: publicUser(user) },
        });
        notice(user, `Приглашение отправлено: ${target.name}`, 'ok');
        break;
      }

      case 'gameMove': {
        const { game } = currentGame(user);
        if (!game) return notice(user, 'Партии нет', 'err');
        if (game.state.status !== 'playing') return notice(user, 'Партия закончена', 'err');
        const side = playerSide(game, user.id);
        if (!side) return notice(user, 'Вы наблюдатель', 'err');
        if (game.state.turn !== side) return notice(user, 'Сейчас не ваш ход', 'err');

        const from = Array.isArray(msg.from) ? msg.from.map(Number) : null;
        const to = Array.isArray(msg.to) ? msg.to.map(Number) : null;
        const result = checkers.applyMove(game.state, from, to);
        if (!result.ok) return notice(user, result.error, 'err');

        broadcastRoom(room, 'game', { game: gameView(game) });
        if (game.state.status === 'over') {
          endGame(room, game, game.state.winner, game.state.reason);
        }
        break;
      }

      case 'gameResign': {
        const { game } = currentGame(user);
        if (!game || game.state.status !== 'playing') return;
        const side = playerSide(game, user.id);
        if (!side) return;
        endGame(room, game, checkers.other(side), 'resign');
        break;
      }

      case 'gameDrawOffer': {
        const { game } = currentGame(user);
        if (!game || game.state.status !== 'playing') return;
        const side = playerSide(game, user.id);
        if (!side) return;
        game.drawOfferBy = side;
        broadcastRoom(room, 'game', { game: gameView(game) });
        break;
      }

      case 'gameDrawReply': {
        const { game } = currentGame(user);
        if (!game || game.state.status !== 'playing') return;
        const side = playerSide(game, user.id);
        if (!side || !game.drawOfferBy || game.drawOfferBy === side) return;
        if (msg.accept) endGame(room, game, null, 'draw');
        else {
          game.drawOfferBy = null;
          broadcastRoom(room, 'game', { game: gameView(game) });
        }
        break;
      }

      case 'gameNew': {
        const { game } = currentGame(user);
        if (!game) return;
        if (game.state.status === 'playing') return notice(user, 'Партия ещё идёт', 'err');
        startGame(room, game.white.id, game.black.id);
        break;
      }

      case 'gameLeave': {
        const { game } = currentGame(user);
        if (!game) return;
        const side = playerSide(game, user.id);
        if (!side) return;
        if (game.state.status === 'playing') endGame(room, game, checkers.other(side), 'resign');
        enterRoom(user, mainRoom);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Подключить сокет. Подходит любой WebSocket с addEventListener/send/close:
   * и `ws` в Node, и Deno.upgradeWebSocket.
   */
  function attach(ws, url) {
    const params = url && url.searchParams ? url.searchParams : new URLSearchParams();
    const user = {
      id: shortId(),
      name: cleanLine(params.get('name'), LIMITS.nameLength) || makeName(),
      color: freeColor(),
      roomCode: MAIN_ROOM,
      ws,
      lastSeen: Date.now(),
      gameId: null,
      chatTimes: [],
      connectedAt: Date.now(),
      dropped: false,
      started: false,
    };
    ws.addEventListener('message', (event) => handleMessage(user, event.data));
    ws.addEventListener('close', () => drop(user));
    ws.addEventListener('error', () => drop(user));

    // В Node сокет уже открыт, в Deno он ещё CONNECTING — ждём open, иначе welcome не уйдёт
    const start = () => {
      if (user.started || user.dropped) return;
      user.started = true;

      users.set(user.id, user);

      const wantedCode = normalizeCode(params.get('room'));
      const wanted = wantedCode ? rooms.get(wantedCode) : null;
      const room = wanted || mainRoom;
      user.roomCode = room.code;
      room.members.add(user.id);

      const game = room.gameId ? games.get(room.gameId) : null;

      send(ws, 'welcome', {
        you: publicUser(user),
        room: roomView(room),
        history: room.messages.slice(-LIMITS.history),
        online: onlineView(),
        rooms: roomList(user),
        game: game ? gameView(game) : null,
        limits: {
          fileBytes: LIMITS.fileBytes,
          roomBytes: LIMITS.roomBytes,
          textLength: LIMITS.textLength,
        },
      });

      if (wantedCode && !wanted) {
        notice(user, 'Комната с таким кодом не найдена — вы в общем чате', 'info');
      }

      addSystem(room, `${user.name} в комнате`);
      pushRoom(room);
      pushOnline();
      pushRooms();
    };

    if (ws.readyState === 1) start();
    else ws.addEventListener('open', start, { once: true });

    return user;
  }

  function sweep(now = Date.now()) {
    for (const user of [...users.values()]) {
      if (now - user.lastSeen < LIMITS.idleMs) continue;
      try {
        user.ws.close();
      } catch {
        /* ignore */
      }
      drop(user);
    }
  }

  const timer = setInterval(() => sweep(), 30000);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    attach,
    sweep,
    stats: () => ({
      ok: true,
      users: users.size,
      rooms: rooms.size,
      files: files.size,
      games: games.size,
    }),
    file(id) {
      const file = files.get(id);
      if (!file) return null;
      return {
        id: file.id,
        name: file.name,
        mime: file.mime,
        size: file.size,
        data: file.data,
        roomCode: file.roomCode,
      };
    },
    close() {
      clearInterval(timer);
      for (const user of [...users.values()]) {
        try {
          user.ws.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
