import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const CSP =
  "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/**
 * Optional single-host deployment: serve the built client from this process.
 * Returns true if the request was handled. Includes path-traversal protection and an SPA fallback
 * so that /join/ROOMCODE links open the app.
 */
export function serveStatic(rootDir: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const root = resolve(rootDir);
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return true;
  }
  if (pathname.includes('\0')) {
    res.writeHead(400).end('Bad request');
    return true;
  }

  let file = normalize(join(root, pathname));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }

  const isFile = ((): boolean => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  })();
  if (!isFile) {
    // SPA fallback for client-side routes (/join/CODE) but not for missing assets.
    if (extname(pathname) !== '') {
      res.writeHead(404).end('Not found');
      return true;
    }
    file = join(root, 'index.html');
    try {
      if (!statSync(file).isFile()) throw new Error('missing');
    } catch {
      res.writeHead(503).end('Client build not found. Run "npm run build" first.');
      return true;
    }
  }

  const ext = extname(file).toLowerCase();
  const hashed = /[-.][A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(file) && pathname.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}
