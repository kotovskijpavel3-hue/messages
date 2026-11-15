/**
 * Node-версия запуска: http для статики и файлов + ws для реального времени.
 * Вся логика комнат, чата и шашек — в lib/hub.js (одна и та же для Node и Deno).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createHub, MIME } from './lib/hub.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const hub = createHub({
  randomId: () => crypto.randomBytes(8).toString('hex'),
  randomInt: (max) => crypto.randomInt(max),
});

/* ---------------- http ---------------- */

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
  const file = hub.file(id);
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
  res.end(Buffer.from(file.data));
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
    return res.end(JSON.stringify({ ...hub.stats(), uptime: Math.round(process.uptime()) }));
  }

  const download = urlPath.match(/^\/f\/([A-Za-z0-9]{8,64})(?:\/.*)?$/);
  if (download) return serveFile(req, res, download[1]);

  return serveStatic(req, res, urlPath);
});

/* ---------------- websocket ---------------- */

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    url = new URL('/', 'http://localhost');
  }
  hub.attach(ws, url);
});

server.listen(PORT, () => {
  console.log(`Messages Online: http://localhost:${PORT}`);
});
