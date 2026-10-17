// Serves the app locally with src/api.js swapped for tests/ui/fake-api.js (in-browser Postgres).
// Usage: npm run local  →  http://localhost:8787  (accounts: alp / Ayşe / mehmet …, password test1234; ?reset to start over)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.PORT) || 8787;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.sql': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.gz': 'application/gzip', '.json': 'application/json' };

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  if (path === '/src/api.js') path = '/tests/ui/fake-api.js';
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, () => console.log(`SJ Kelimelik (local database) → http://localhost:${port}`));
