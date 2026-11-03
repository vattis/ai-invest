import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { openLocalStore } from '../lib/local-store.mjs';
import { createLocalHandler } from '../local/handler.mjs';

const types = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8'
};
const store = await openLocalStore();
const handler = createLocalHandler(store);
const port = Number(process.env.PORT) || 3000;
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/') || pathname.startsWith('/internal/')) return handler(req, res);
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!Object.hasOwn(types, file)) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', types[file]);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.end(await readFile(new URL(`../web/${file}`, import.meta.url)));
});
server.listen(port, '127.0.0.1', () => console.log(`Local dashboard: http://127.0.0.1:${port}`));

function shutdown() {
  server.close(async () => { await store.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
