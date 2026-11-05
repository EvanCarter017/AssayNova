import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdmin, isLoopbackPeer } from './admin.mjs';
import { DEFAULT_IMAGES } from './catalog.mjs';
import { DEFAULT_STORE } from './reader.mjs';

// Compatibility host; normal use mounts the same handler with server --admin.
export async function createStudio({ images = DEFAULT_IMAGES, store = DEFAULT_STORE, port = 4320, publicOrigin = 'http://127.0.0.1:4317', render, codeFactory } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local administration is disabled in production.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid studio port.');
  let origin;
  const admin = await createAdmin({ origin: () => origin, images, store, publicOrigin, render, codeFactory });
  const server = http.createServer(async (request, response) => {
    if (await admin.handle(request, response)) return;
    if (request.url === '/' && ['GET', 'HEAD'].includes(request.method) && isLoopbackPeer(request.socket.remoteAddress) && request.headers.host === new URL(origin).host && (!request.headers.origin || request.headers.origin === origin)) {
      response.writeHead(302, { Location: '/admin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(); return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(request.method === 'HEAD' ? undefined : 'Not found');
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { origin = 'http://127.0.0.1:' + server.address().port; resolve(); }); });
  return { server, origin, store: admin.store };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name, fallback) => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback;
  try {
    const studio = await createStudio({ images: option('images', DEFAULT_IMAGES), store: option('store', DEFAULT_STORE), publicOrigin: option('public-origin', 'http://127.0.0.1:4317') });
    console.log('AssayNova Admin compatibility host: ' + studio.origin + '/admin');
    const stop = () => studio.server.close(() => process.exit(0)); process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
