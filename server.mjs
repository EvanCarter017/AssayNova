import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const liveReload = process.argv.includes('--watch');
const clients = new Set();
const version = Date.now().toString();
let revision = 0;
let lastChange = null;
const pendingChanges = new Set();
let changeTimer;
let watcher;
const portOption = process.argv.find((argument) => argument.startsWith('--port='));
const port = Number(portOption?.split('=')[1] ?? process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port between 1 and 65535.');
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8'
};

const server = http.createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400); response.end('Bad request'); return; }
  if (liveReload && pathname === '/__dev/events') {
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }); response.end(); return; }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.write(`event: connected\ndata: ${JSON.stringify({ version, revision })}\n\n`);
    clients.add(response);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
    request.on('close', () => { clearInterval(heartbeat); clients.delete(response); });
    return;
  }
  if (liveReload && pathname === '/__dev/status') {
    response.writeHead(200, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ liveReload: true, version, revision, clients: clients.size, lastChange }));
    return;
  }
  if (liveReload && pathname === '/__dev/client.js') {
    const client = await readFile(new URL('./dev-client.js', import.meta.url));
    response.writeHead(200, { 'Content-Type': mime['.js'], 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : client);
    return;
  }
  const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!filename.startsWith(root + path.sep)) {
    response.writeHead(403); response.end('Forbidden'); return;
  }
  try {
    if (!(await stat(filename)).isFile()) throw new Error('Not a file');
    let contents = await readFile(filename);
    if (liveReload && path.extname(filename) === '.html') {
      contents = Buffer.from(contents.toString('utf8').replace('</body>', '<script type="module" src="/__dev/client.js"></script></body>'));
    }
    response.writeHead(200, {
      'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is in use. Try: node server.mjs --port=${port + 1}` : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`AssayNova prototype ready\nLocal: http://127.0.0.1:${port}\nProject: ${path.dirname(root)}\nLive reload: ${liveReload ? 'ON — CSS updates in place; HTML/JS changes reload the page' : 'OFF (add --watch to enable)'}\nPress Ctrl+C to stop.`);
  if (liveReload) {
    watcher = watch(root, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const changedPath = '/' + String(filename).split(path.sep).join('/');
      if (!/\.(html|css|js|json|png|jpg|jpeg|webp|svg|ico)$/i.test(changedPath)) return;
      pendingChanges.add(changedPath);
      clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        revision++;
        lastChange = { paths: [...pendingChanges], revision, at: new Date().toISOString() };
        pendingChanges.clear();
        const payload = `event: change\ndata: ${JSON.stringify(lastChange)}\n\n`;
        for (const client of clients) client.write(payload);
        console.log(`[live reload ${revision}] ${lastChange.paths.join(', ')}`);
      }, 100);
    });
    watcher.on('error', (error) => console.error('File watcher:', error.message));
  }
});

function shutdown() {
  clearTimeout(changeTimer);
  watcher?.close();
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
