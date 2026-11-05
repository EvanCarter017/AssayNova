import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_IMAGES, loadCatalog, catalogDTO } from './catalog.mjs';
import { DEFAULT_STORE, validCode } from './reader.mjs';
import { createStore, validateFields, validateComponents } from './store.mjs';
import { createAuth, DEFAULT_AUTH_STORE } from './auth.mjs';

const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
const files = new Map([['/admin', 'operator.html'], ['/admin/', 'operator.html'], ['/admin/operator.js', 'operator.js'], ['/admin/operator.css', 'operator.css'], ['/admin/product-search.mjs', 'product-search.mjs']]);
const inNamespace = pathname => pathname === '/admin' || pathname.startsWith('/admin/');
export const isLoopbackPeer = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

function send(response, status, value, type = 'application/json; charset=utf-8', head = false) {
  response.writeHead(status, { ...headers, 'Content-Type': type });
  response.end(head ? undefined : Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
}
function plainOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use a plain public origin.');
  return url.origin;
}
async function bodyJSON(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) {
    const error = new Error('Use application/json.'); error.status = 415; throw error;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8192) { const error = new Error('Request exceeds 8192 bytes.'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid JSON.'); }
}

// One catalog/store writer and one security boundary, shared by both HTTP hosts.
export async function createAdmin({ origin, images = DEFAULT_IMAGES, store = DEFAULT_STORE, authStore = DEFAULT_AUTH_STORE, authOptions, publicOrigin, render, codeFactory } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local administration is disabled in production.');
  if (!path.isAbsolute(images)) throw new Error('Choose an absolute admin image directory.');
  const publicURL = plainOrigin(publicOrigin);
  const catalog = await loadCatalog(images), products = new Map(catalog.map(product => [product.id, product]));
  const reports = await createStore(store, { render, codeFactory });
  const token = randomBytes(32).toString('hex');
  const auth = createAuth({ ...authOptions, store: authStore, origin });
  const validRunToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));

  async function loginPage(response, configured, head, unavailable = false) {
    const values = { MODE: unavailable ? 'unavailable' : configured ? 'login' : 'setup', CSRF: auth.challenge,
      TITLE: unavailable ? 'Administration unavailable' : configured ? 'Unlock administration' : 'Set administrator password',
      INTRO: unavailable ? 'The saved administrator credential could not be opened. Ask the local owner to check its storage.' : configured ? 'Enter the administrator password to open Reports.' : 'Choose the administrator password for this computer. You will use it to unlock Reports.',
      AUTOCOMPLETE: unavailable ? 'off' : configured ? 'current-password' : 'new-password', BUTTON: unavailable ? 'Unavailable' : configured ? 'Unlock admin' : 'Set administrator password', DISABLED: unavailable ? 'disabled' : '', ERROR: unavailable ? 'Administrator credential storage is unavailable.' : '' };
    const html = (await readFile(new URL('./login.html', import.meta.url), 'utf8')).replace(/\{\{([A-Z]+)\}\}/g, (_match, key) => values[key]);
    send(response, unavailable ? 503 : 200, html, 'text/html; charset=utf-8', head);
  }

  async function handle(request, response) {
    const encodedPath = request.url.split('?')[0];
    let pathname;
    try { pathname = decodeURIComponent(encodedPath); }
    catch { if (!encodedPath.startsWith('/admin')) return false; send(response, 400, { error: 'Invalid URL.' }); return true; }
    if (!inNamespace(pathname) && !inNamespace(encodedPath)) return false;
    const head = request.method === 'HEAD';
    const currentOrigin = typeof origin === 'function' ? origin() : origin;
    if (!isLoopbackPeer(request.socket?.remoteAddress) || request.headers.host !== new URL(currentOrigin).host || (request.headers.origin && request.headers.origin !== currentOrigin) || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) {
      send(response, 403, { error: 'Loopback peer, Origin or Host rejected.' }, undefined, head); return true;
    }
    // Generated URLs use plain ASCII segments; reject alternate path spellings.
    if (encodedPath !== pathname || pathname.includes('\\') || /[\x00-\x20]/.test(pathname) || pathname.includes('//') || pathname.split('/').some(segment => segment === '.' || segment === '..')) {
      send(response, 400, { error: 'Invalid admin path.' }, undefined, head); return true;
    }
    if (['/admin/login.js', '/admin/login.css'].includes(pathname) && ['GET', 'HEAD'].includes(request.method)) {
      const file = pathname.slice('/admin/'.length);
      send(response, 200, await readFile(new URL(file, import.meta.url)), file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', head); return true;
    }
    if (['/admin/auth/setup', '/admin/auth/login'].includes(pathname)) {
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); send(response, 405, { error: 'Use POST to unlock administration.' }, undefined, head); return true; }
      if (request.headers.origin !== currentOrigin || !auth.validChallenge(request.headers['x-admin-csrf'])) { send(response, 403, { error: 'Sign-in request rejected.' }); return true; }
      try {
        const input = await bodyJSON(request);
        if (!input || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'password')) { send(response, 400, { error: 'Supply only the administrator password.' }); return true; }
        const cookie = await auth.unlock(input.password, pathname.endsWith('/setup'));
        response.setHeader('Set-Cookie', cookie); send(response, 200, { ok: true });
      } catch (error) {
        if (error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter));
        send(response, error.status || 400, { error: error.status ? error.message : 'Sign-in request could not be processed.' });
      }
      return true;
    }
    let configured;
    try { configured = await auth.configured(); }
    catch {
      if (['/admin', '/admin/'].includes(pathname) && ['GET', 'HEAD'].includes(request.method)) await loginPage(response, false, head, true);
      else send(response, 503, { error: 'Administrator credential storage is unavailable.' }, undefined, head);
      return true;
    }
    if (pathname === '/admin/login' && ['GET', 'HEAD'].includes(request.method)) { response.writeHead(302, { ...headers, Location: '/admin' }); response.end(); return true; }
    if (!configured || !auth.authorized(request)) {
      if (['/admin', '/admin/'].includes(pathname) && ['GET', 'HEAD'].includes(request.method)) await loginPage(response, configured, head);
      else send(response, 401, { error: 'Unlock administration to continue.' }, undefined, head);
      return true;
    }
    if (pathname === '/admin/auth/logout') {
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); send(response, 405, { error: 'Use POST to log out.' }, undefined, head); return true; }
      if (request.headers.origin !== currentOrigin || !validRunToken(request.headers['x-studio-token'])) { send(response, 403, { error: 'Logout request rejected.' }); return true; }
      response.setHeader('Set-Cookie', auth.logout(request)); send(response, 200, { ok: true }); return true;
    }
    if (request.method === 'POST' && pathname === '/admin/api/generate') {
      const supplied = request.headers['x-studio-token'];
      if (request.headers.origin !== currentOrigin || !validRunToken(supplied)) {
        send(response, 403, { error: 'Run token required.' }); return true;
      }
      try {
        const input = await bodyJSON(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['productId', 'fields', 'components', 'publish'].includes(key)) || typeof input.publish !== 'boolean') throw new Error('Choose Preview or Generate and publish.');
        const selected = products.get(input.productId);
        if (!selected) throw new Error('Select a catalog product.');
        const components = validateComponents(input.components, selected.components);
        const product = { ...selected, components, unit: new Set(components.map(row => row.unit)).size === 1 ? components[0].unit : 'mixed' };
        const result = await reports.generate(product, validateFields(input.fields), input.publish);
        send(response, 201, { ...result, previewURL: '/admin' + result.previewURL, pdfURL: '/admin' + result.pdfURL, publicURL: new URL('/coa/' + result.report.lookupCode, publicURL).href });
      } catch (error) { send(response, error.status || 400, { error: error.code ? 'Report operation failed; previous reports are preserved.' : error.message }); }
      return true;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD'); send(response, 405, { error: 'Method not allowed.' }); return true;
    }
    try {
      if (pathname === '/admin/api/session') {
        send(response, 200, { token, products: catalog.map(product => { const dto = catalogDTO(product); return { ...dto, imageURL: '/admin' + dto.imageURL }; }), publicOrigin: publicURL }, undefined, head); return true;
      }
      if (pathname === '/admin/api/history') { send(response, 200, await reports.history(), undefined, head); return true; }
      if (files.has(pathname)) {
        const file = files.get(pathname), type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        send(response, 200, await readFile(new URL(file, import.meta.url)), type, head); return true;
      }
      const image = /^\/admin\/images\/([a-f0-9]{20})$/.exec(pathname);
      if (image && products.has(image[1])) { send(response, 200, await readFile(products.get(image[1]).imagePath), 'image/png', head); return true; }
      const bundle = /^\/admin\/bundles\/(published|previews)\/(AN-[A-Z0-9]{4}-[A-Z0-9]{4})\/(report\.svg|report\.pdf)$/.exec(pathname);
      if (bundle && validCode(bundle[2])) {
        const base = await realpath(path.join(reports.root, bundle[1]));
        const file = await realpath(path.join(base, bundle[2], bundle[3]));
        if (path.dirname(path.dirname(file)) !== base) throw new Error('Path rejected.');
        send(response, 200, await readFile(file), bundle[3].endsWith('.pdf') ? 'application/pdf' : 'image/svg+xml', head); return true;
      }
      send(response, 404, { error: 'Not found.' }, undefined, head);
    } catch { send(response, 404, { error: 'Not found.' }, undefined, head); }
    return true;
  }
  return { handle, store: reports.root };
}
