import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { PuzzleStore, puzzleDayFor, msUntilRollover } from './src/puzzle.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = process.env.ARXIV_CACHE_DIR ?? path.join(ROOT, 'cache');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const store = new PuzzleStore(CACHE_DIR);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function serveStatic(req, res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, relative);

  // Refuse anything that escapes public/ via ../ or symlink-ish paths.
  if (path.relative(PUBLIC_DIR, filePath).startsWith('..')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    // Vendored assets are immutable; app files should revalidate.
    const cacheControl = relative.startsWith('vendor/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': cacheControl,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (pathname === '/api/puzzle') {
    try {
      const puzzle = await store.get();
      // Let the browser hold it only until the next 2am ET rollover.
      const maxAge = Math.max(60, Math.floor(msUntilRollover() / 1000));
      sendJson(res, 200, puzzle, { 'Cache-Control': `public, max-age=${maxAge}` });
    } catch (error) {
      console.error('[api] puzzle build failed:', error);
      sendJson(res, 503, { error: "Couldn't reach arXiv to build today's puzzle." },
        { 'Cache-Control': 'no-store' });
    }
    return;
  }

  await serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`arXiv Connections on http://localhost:${PORT}  (puzzle day ${puzzleDayFor()})`);
  // Warm the cache so the first visitor of the day doesn't wait on arXiv.
  store.get().catch((error) => console.warn('[warmup]', error.message));
});
