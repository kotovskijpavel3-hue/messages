'use strict';

/**
 * Messages Online — общий чат, комнаты по коду, файлы и русские шашки.
 *
 * Один процесс Node.js: http для статики и раздачи файлов + ws для реального времени.
 * Всё состояние (комнаты, сообщения, файлы, партии) живёт в памяти и пропадает
 * при перезапуске — как в Just Online и chess-online.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const checkers = require('./lib/checkers');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAIN_ROOM = 'MAIN';

const LIMITS = {
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
};

/* ------------------------------------------------------------------ */
/* утилиты                                                             */
/* ------------------------------------------------------------------ */

const MIME = {
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

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shortId = () => crypto.randomBytes(4).toString('hex');
const makeName = () => `${pick(ADJ)} ${pick(NOUN)}`;

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

const cleanLine = (value, max) => cleanText(value, max).replace(/\s+/g, ' ');

function normalizeCode(value) {
  const code = String(value == null ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code === 'MAIN' ? MAIN_ROOM : code;
}

function newRoomCode() {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    let code = '';
    for (let i = 0; i < 6; i += 1) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return `R${Date.now().toString(36).toUpperCase().slice(-5)}`;
}

const prettySize = (bytes) => {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
};

/* ------------------------------------------------------------------ */
/* состояние                                                           */
/* ------------------------------------------------------------------ */

/** id -> { id, name, color, roomCode, ws, alive, gameId, chatTimes } */
const users = new Map();
/** code -> { code, name, isPublic, hostId, createdAt, members:Set, messages:[], files:[], bytes, gameId } */
const rooms = new Map();
/** id -> { id, name, mime, size, buf, at, roomCode, by } */
const files = new Map();
/** id -> { id, roomCode, white, black, state, createdAt, drawOfferBy } */
const games = new Map();
/** id -> { id, fromId, toId, roomCode, timer } */
const challenges = new Map();

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

/* ------------------------------------------------------------------ */
/* представления для клиента                                           */
/* ------------------------------------------------------------------ */

function publicUser(user) {
  return { id: user.id, name: user.name, color: user.color };
}

function onlineView() {
  return [...users.values()]
    .map((u) => {
      const room = rooms.get(u.roomCode);
      return {
        id: u.id,
        name: u.name,
        color: u.color,
        roomCode: u.roomCode,
        roomName: room ? room.name : '',
        inGame: Boolean(u.gameId),
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
      .map((u) => ({ ...publicUser(u), inGame: Boolean(u.gameId) })),
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
    moves: moves.map((m) => ({ from: m.from, to: m.to, capture: m.capture })),
  };
}

/* ------------------------------------------------------------------ */
/* отправка                                                            */
/* ------------------------------------------------------------------ */

function send(ws, type, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify({ type, ...(payload || {}) }));
  } catch {
    /* сокет умер — молча */
  }
}

function broadcastAll(type, payload) {
  const data = JSON.stringify({ type, ...(payload || {}) });
  for (const user of users.values()) {
    if (user.ws && user.ws.readyState === 1) {
      try {
        user.ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }
}

function broadcastRoom(room, type, payload, exceptId) {
  if (!room) return;
  const data = JSON.stringify({ type, ...(payload || {}) });
  for (const id of room.members) {
    if (id === exceptId) continue;
    const user = users.get(id);
    if (user && user.ws && user.ws.readyState === 1) {
      try {
        user.ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }
}

const pushOnline = () => broadcastAll('online', { users: onlineView(), total: users.size });

// список комнат у каждого свой: приватные видны только участникам
function pushRooms() {
  for (const user of users.values()) {
    send(user.ws, 'rooms', { rooms: roomList(user) });
  }
}
const pushRoom = (room) => broadcastRoom(room, 'room', { room: roomView(room) });

function notice(user, text, level = 'info') {
  send(user.ws, 'notice', { text, level });
}

/* ------------------------------------------------------------------ */
/* сообщения                                                           */
/* ------------------------------------------------------------------ */

function pushMessage(room, message) {
  room.messages.push(message);
  if (room.messages.length > LIMITS.history) room.messages.shift();
  broadcastRoom(room, 'message', { message });
}

function addSystem(room, text) {
  pushMessage(room, { id: shortId(), kind: 'system', at: Date.now(), text });
}

/* ------------------------------------------------------------------ */
/* комнаты                                                             */
/* ------------------------------------------------------------------ */

function destroyRoom(room) {
  for (const meta of room.files) files.delete(meta.id);
  if (room.gameId && games.has(room.gameId)) {
    const game = games.get(room.gameId);
    [game.white, game.black].forEach((p) => {
      const u = users.get(p.id);
      if (u && u.gameId === game.id) {
        u.gameId = null;
      }
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
  if (game) send(user.ws, 'game', { game: gameView(game) });
  else send(user.ws, 'game', { game: null });

  addSystem(room, `${user.name} в комнате`);
  pushRoom(room);
  pushOnline();
  pushRooms();
}

/* ------------------------------------------------------------------ */
/* шашки                                                               */
/* ------------------------------------------------------------------ */

function startGame(room, aId, bId) {
  const a = users.get(aId);
  const b = users.get(bId);
  if (!a || !b) return null;

  const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
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
  [game.white, game.black].forEach((p) => {
    const u = users.get(p.id);
    if (u && u.gameId === game.id) u.gameId = null;
  });

  let text;
  if (reason === 'draw') text = 'Ничья';
  else if (reason === 'resign') text = `${winner === 'w' ? game.white.name : game.black.name} победил — соперник сдался`;
  else text = `${winner === 'w' ? game.white.name : game.black.name} победил`;

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

const playerSide = (game, userId) => {
  if (!game) return null;
  if (game.white.id === userId) return 'w';
  if (game.black.id === userId) return 'b';
  return null;
};

/* ------------------------------------------------------------------ */
/* вызовы                                                             */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* файлы                                                               */
/* ------------------------------------------------------------------ */

function storeFile(user, room, payload) {
  const name = cleanLine(payload && payload.name, 120) || 'файл';
  const rawMime = String((payload && payload.mime) || '').slice(0, 120);
  const mime = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(rawMime)
    ? rawMime.toLowerCase()
    : 'application/octet-stream';
  const raw = String((payload && payload.data) || '');

  if (!raw) return notice(user, 'Пустой файл', 'err');

  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return notice(user, 'Не удалось прочитать файл', 'err');
  }
  if (!buf.length) return notice(user, 'Пустой файл', 'err');
  if (buf.length > LIMITS.fileBytes) {
    return notice(user, `Файл больше ${prettySize(LIMITS.fileBytes)}`, 'err');
  }
  if (room.bytes + buf.length > LIMITS.roomBytes) {
    return notice(user, `Лимит комнаты ${prettySize(LIMITS.roomBytes)} исчерпан`, 'err');
  }

  const id = crypto.randomBytes(8).toString('hex');
  const file = {
    id,
    name,
    mime,
    size: buf.length,
    buf,
    at: Date.now(),
    roomCode: room.code,
    by: publicUser(user),
  };
  files.set(id, file);
  room.files.unshift({ id, name, mime, size: buf.length, at: file.at, by: file.by, url: `/f/${id}/${encodeURIComponent(name)}` });
  room.bytes += buf.length;

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

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (rel !== 'index.html' && !path.extname(rel)) return serveStatic(req, res, '/');
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function serveFile(req, res, id) {
  const file = files.get(id);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Файл не найден или уже удалён');
  }
  const safeInline = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|audio\/|video\/)/i.test(file.mime);
  const disposition = safeInline && !req.url.includes('dl=1') ? 'inline' : 'attachment';
  res.writeHead(200, {
    'Content-Type': file.mime,
    'Content-Length': file.size,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(file.buf);
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url || '/';
  const urlPath = decodeURIComponent(rawUrl.split('?')[0]);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method not allowed');
  }

  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      users: users.size,
      rooms: rooms.size,
      files: files.size,
      games: games.size,
      uptime: Math.round(process.uptime()),
    }));
  }

  const download = urlPath.match(/^\/f\/([a-f0-9]{8,64})(?:\/.*)?$/);
  if (download) return serveFile(req, res, download[1]);

  return serveStatic(req, res, urlPath);
});

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024 });

function freeColor() {
  const taken = new Set([...users.values()].map((u) => u.color));
  const free = PALETTE.filter((c) => !taken.has(c));
  return free.length ? pick(free) : pick(PALETTE);
}

wss.on('connection', (ws, req) => {
  let query = new URLSearchParams();
  try {
    query = new URL(String(req.url || '/'), 'http://localhost').searchParams;
  } catch {
    /* ignore */
  }

  const user = {
    id: shortId(),
    name: cleanLine(query.get('name'), LIMITS.nameLength) || makeName(),
    color: freeColor(),
    roomCode: MAIN_ROOM,
    ws,
    alive: true,
    gameId: null,
    chatTimes: [],
    connectedAt: Date.now(),
  };
  users.set(user.id, user);

  const wantedCode = normalizeCode(query.get('room'));
  const wanted = wantedCode ? rooms.get(wantedCode) : null;
  const room = wanted || mainRoom;
  user.roomCode = room.code;
  room.members.add(user.id);

  send(ws, 'welcome', {
    you: publicUser(user),
    room: roomView(room),
    history: room.messages.slice(-LIMITS.history),
    online: onlineView(),
    rooms: roomList(user),
    game: room.gameId && games.get(room.gameId) ? gameView(games.get(room.gameId)) : null,
    limits: {
      fileBytes: LIMITS.fileBytes,
      roomBytes: LIMITS.roomBytes,
      textLength: LIMITS.textLength,
    },
  });

  if (wantedCode && !wanted) notice(user, 'Комната с таким кодом не найдена — вы в общем чате', 'info');
  addSystem(room, `${user.name} в комнате`);
  pushRoom(room);
  pushOnline();
  pushRooms();

  ws.on('pong', () => {
    user.alive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    const room = rooms.get(user.roomCode) || mainRoom;

    switch (msg.type) {
      case 'ping':
        send(ws, 'pong', { at: Date.now() });
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
        const code = normalizeCode(msg.code);
        const target = rooms.get(code);
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

      case 'challengeReply': {
        const id = String(msg.id || '');
        if (msg.accept) acceptChallenge(user, id);
        else declineChallenge(user, id);
        break;
      }

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
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
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
    // партия, где он был игроком, завершается
    for (const game of games.values()) {
      if (game.state.status !== 'playing') continue;
      const side = playerSide(game, user.id);
      if (!side) continue;
      const room = rooms.get(game.roomCode);
      if (room) endGame(room, game, checkers.other(side), 'resign');
    }
    pushOnline();
    pushRooms();
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

function canChat(user) {
  const now = Date.now();
  user.chatTimes = user.chatTimes.filter((t) => now - t < LIMITS.chatWindowMs);
  if (user.chatTimes.length >= LIMITS.chatBurst) return false;
  user.chatTimes.push(now);
  return true;
}

/* ------------------------------------------------------------------ */
/* сердцебиение                                                        */
/* ------------------------------------------------------------------ */

const heartbeat = setInterval(() => {
  for (const [id, user] of users) {
    if (!user.ws) continue;
    if (!user.alive) {
      try {
        user.ws.terminate();
      } catch {
        /* ignore */
      }
      users.delete(id);
      continue;
    }
    user.alive = false;
    try {
      user.ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Messages Online: http://localhost:${PORT}`);
});
