/**
 * Deno-версия запуска: Deno.serve + Deno.upgradeWebSocket.
 * Логика та же, что в Node-версии — lib/hub.js.
 *
 * Локально: deno run --allow-net --allow-env --allow-read main.ts
 * Deno Deploy: entrypoint main.ts, install/build команды не нужны.
 */

import { createHub, MIME } from './lib/hub.js';

const hub = createHub({
  randomId: () => crypto.randomUUID().replace(/-/g, '').slice(0, 16),
  randomInt: (max: number) => Math.floor(Math.random() * max),
});

const PUBLIC_DIR = new URL('./public/', import.meta.url);
const MIME_MAP: Record<string, string> = MIME;

const textResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' },
  });

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return textResponse('Forbidden', 403);

  try {
    const data = await Deno.readFile(new URL(rel, PUBLIC_DIR));
    const dot = rel.lastIndexOf('.');
    const ext = dot >= 0 ? rel.slice(dot) : '';
    return new Response(data, {
      headers: {
        'content-type': MIME_MAP[ext] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      },
    });
  } catch {
    if (!rel.includes('.')) return serveStatic('index.html');
    return textResponse('Not found', 404);
  }
}

function serveFile(id: string): Response {
  const file = hub.file(id);
  if (!file) return textResponse('Файл не найден или уже удалён', 404);

  const safeInline = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|audio\/|video\/)/i.test(file.mime);
  return new Response(file.data, {
    headers: {
      'content-type': file.mime,
      'content-disposition': `${safeInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
    },
  });
}

const port = Number(Deno.env.get('PORT') ?? 8000);

Deno.serve({ port, hostname: '0.0.0.0' }, (req: Request): Response | Promise<Response> => {
  const url = new URL(req.url);

  if (req.method !== 'GET' && req.method !== 'HEAD') return textResponse('Method not allowed', 405);

  if (url.pathname === '/health') {
    return new Response(JSON.stringify(hub.stats()), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const download = url.pathname.match(/^\/f\/([A-Za-z0-9]{8,64})(?:\/.*)?$/);
  if (download) return serveFile(download[1]);

  if ((req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
    const { socket, response } = Deno.upgradeWebSocket(req);
    hub.attach(socket, url);
    return response;
  }

  return serveStatic(url.pathname);
});

console.log(`Messages Online (Deno): http://localhost:${port}`);
