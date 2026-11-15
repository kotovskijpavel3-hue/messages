import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL('..', import.meta.url));

let child = null;

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let log = '';
    const timer = setTimeout(() => reject(new Error(`сервер не стартовал: ${log}`)), 10000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };

    child.stdout.on('data', (chunk) => {
      log += chunk;
      if (log.includes('http://localhost')) done();
    });
    child.stderr.on('data', (chunk) => {
      log += chunk;
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`сервер упал (${code}): ${log}`));
      }
    });
  });
}

function makeClient(name, room) {
  const query = `?name=${encodeURIComponent(name)}${room ? `&room=${encodeURIComponent(room)}` : ''}`;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${query}`);
  const buffered = [];
  const waiters = [];
  const all = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    all.push(msg);
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i];
      if (waiter.type === msg.type && (!waiter.pred || waiter.pred(msg))) {
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
        return;
      }
    }
    buffered.push(msg);
  });

  function wait(type, pred, ms = 6000) {
    const found = buffered.findIndex((m) => m.type === type && (!pred || pred(m)));
    if (found >= 0) return Promise.resolve(buffered.splice(found, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, pred, resolve };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timeout ожидания «${type}»`));
      }, ms);
      waiters.push(waiter);
    });
  }

  return {
    name,
    ws,
    all,
    wait,
    send(type, payload) {
      ws.send(JSON.stringify({ type, ...(payload || {}) }));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

test('сервер: чат, файлы, комнаты по коду и партия', async (t) => {
  await startServer();
  t.after(() => {
    if (child) child.kill('SIGKILL');
  });

  const health = await fetch(`${BASE}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);

  const index = await fetch(BASE);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Messages Online/);

  const a = makeClient('Тест А');
  const b = makeClient('Тест Б');
  const c = makeClient('Наблюдатель');
  t.after(() => {
    a.close();
    b.close();
    c.close();
  });

  const aw = await a.wait('welcome');
  const bw = await b.wait('welcome');
  await c.wait('welcome');

  assert.equal(aw.room.code, 'MAIN');
  assert.equal(aw.you.name, 'Тест А');
  assert.ok(aw.online.length >= 1);

  // --- чат ---
  a.send('chat', { text: 'привет из теста' });
  const chat = await b.wait('message', (m) => m.message.kind === 'msg' && m.message.text === 'привет из теста');
  assert.equal(chat.message.by.name, 'Тест А');

  // --- файл ---
  const payload = Buffer.from('файл из теста', 'utf8');
  a.send('upload', { name: 'note.txt', mime: 'text/plain', data: payload.toString('base64') });
  const fileMsg = await b.wait('message', (m) => m.message.kind === 'file');
  assert.equal(fileMsg.message.file.name, 'note.txt');
  assert.equal(fileMsg.message.file.size, payload.length);

  const download = await fetch(BASE + fileMsg.message.file.url);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'файл из теста');

  const missing = await fetch(`${BASE}/f/deadbeefdeadbeef/x.txt`);
  assert.equal(missing.status, 404);

  // --- вызов и партия ---
  a.send('challenge', { toId: bw.you.id });
  const challenge = await b.wait('challenge');
  assert.equal(challenge.challenge.from.name, 'Тест А');

  b.send('challengeReply', { id: challenge.challenge.id, accept: true });
  const gameA = await a.wait('game', (m) => m.game && m.game.status === 'playing');
  await b.wait('game', (m) => m.game && m.game.status === 'playing');

  const game = gameA.game;
  assert.equal(game.board.length, 64);
  assert.ok(Array.isArray(game.moves) && game.moves.length > 0);

  const whiteClient = game.white.id === aw.you.id ? a : b;
  const blackClient = whiteClient === a ? b : a;
  const firstMove = game.moves[0];

  whiteClient.send('gameMove', { from: firstMove.from, to: firstMove.to });
  const afterMove = await blackClient.wait('game', (m) => m.game && m.game.ply === 1);
  assert.equal(afterMove.game.turn, 'b');
  assert.notDeepEqual(afterMove.game.board, game.board);

  // --- сдача завершает партию ---
  whiteClient.send('gameResign', {});
  const ended = await blackClient.wait('game', (m) => m.game && m.game.status === 'over');
  assert.equal(ended.game.winner, 'b');

  // --- комната по коду ---
  a.send('createRoom', { name: 'Тестовая комната', isPublic: false });
  const roomMsg = await a.wait('room', (m) => m.room.code !== 'MAIN');
  const code = roomMsg.room.code;
  assert.match(code, /^[A-Z0-9]{6}$/);

  b.send('joinRoom', { code: code.toLowerCase() });
  const joined = await b.wait('room', (m) => m.room.code === code);
  assert.equal(joined.room.name, 'Тестовая комната');

  a.send('chat', { text: 'секрет для комнаты' });
  await b.wait('message', (m) => m.message.text === 'секрет для комнаты');
  await new Promise((resolve) => setTimeout(resolve, 250));

  const leaked = c.all.filter((m) => m.type === 'message' && m.message.text === 'секрет для комнаты');
  assert.equal(leaked.length, 0, 'сообщение приватной комнаты не должно уходить в общий чат');

  // --- неверный код ---
  c.send('joinRoom', { code: 'ZZZZZZ' });
  const notFound = await c.wait('notice', (m) => m.text.includes('не найдена'));
  assert.ok(notFound);

});
