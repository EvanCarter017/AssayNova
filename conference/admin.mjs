import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_IMAGES } from './catalog.mjs';
import { createCustomerCatalog } from './customer-catalog.mjs';
import { createImports } from './imports.mjs';
import { importChunkRoute } from './import-limits.mjs';
import { searchableCatalog } from './import-match.mjs';
import { recordsDTO } from './catalog-records.mjs';
import { DEFAULT_STORE, validCode } from './reader.mjs';
import { createStore, validateFields, validateComponents } from './store.mjs';
import { createAuth, DEFAULT_AUTH_STORE } from './auth.mjs';

const headers = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
const files = new Map([['/admin', 'operator.html'], ['/admin/', 'operator.html'], ['/admin/operator.js', 'operator.js'], ['/admin/operator.css', 'operator.css'], ['/admin/product-search.mjs', 'product-search.mjs'], ['/admin/import-ui.mjs', 'import-ui.mjs'], ['/admin/catalog-correction-ui.mjs', 'catalog-correction-ui.mjs'], ['/admin/report-removal-ui.mjs', 'report-removal-ui.mjs'], ['/admin/report-mail-ui.mjs', 'report-mail-ui.mjs']]);
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
export async function createAdmin({ origin, images = DEFAULT_IMAGES, store = DEFAULT_STORE, authStore = DEFAULT_AUTH_STORE, authOptions, publicOrigin, render, codeFactory, reportMail } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local administration is disabled in production.');
  if (!path.isAbsolute(images) && !/^[a-z]:[\\/]/i.test(images)) throw new Error('Choose an absolute admin image directory.');
  const publicURL = plainOrigin(publicOrigin);
  const reports = await createStore(store, { render, codeFactory });
  const customers = await createCustomerCatalog({ store: reports.root, images });
  const imports = await createImports({ store: reports.root, customers });
  const catalogResponse = catalog => ({ customer: catalog.customer, ...(catalog.customer.catalogRevision ? recordsDTO(catalog) : { catalogRevision: null, entries: [], counts: { total: catalog.products.length, ready: catalog.products.length, blocked: 0 }, products: searchableCatalog(catalog.products).map(dto => ({ ...dto, imageURL: '/admin/images/' + catalog.customer.id + '/' + dto.id })) }) });
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
    const previewDeadline = Date.now() + 60000;
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
    if (['/admin/login.js', '/admin/login.css', '/admin/admin-i18n.mjs'].includes(pathname) && ['GET', 'HEAD'].includes(request.method)) {
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
    if (pathname === '/admin/api/imports' || pathname.startsWith('/admin/api/imports/')) {
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) { send(response, 405, { error: 'Method not allowed.' }, undefined, head); return true; }
      if (request.method !== 'GET' && (request.headers.origin !== currentOrigin || !validRunToken(request.headers['x-studio-token']))) { send(response, 403, { error: 'Run token required.' }); return true; }
      try {
        const route = /^\/admin\/api\/imports\/([a-f0-9]{32})(?:\/(files|inspect|preview|confirm))?$/.exec(pathname);
        let value;
        if (request.method === 'GET' && request.url === pathname && pathname === '/admin/api/imports') value = await imports.list();
        else if (request.method === 'GET' && request.url === pathname && route && !route[2]) value = await imports.detail(route[1]);
        else if (request.method === 'PUT' && importChunkRoute(request.method, request.url)) value = await imports.put(request);
        else if (pathname === '/admin/api/imports' && request.method === 'POST') value = await imports.create(await bodyJSON(request));
        else if (route && request.method === 'DELETE' && !route[2] && request.url === pathname) {
          if (Number(request.headers['content-length']) > 0 || request.headers['transfer-encoding']) { const input = await bodyJSON(request); if (!input || Object.keys(input).length) throw new Error(); }
          value = await imports.cancel(route[1]);
        } else if (route && request.method === 'POST' && route[2] && request.url === pathname) {
          const input = await bodyJSON(request);
          if (route[2] === 'files') value = await imports.register(route[1], input);
          else if (route[2] === 'inspect') value = await imports.inspect(route[1], input);
          else if (route[2] === 'preview') value = await imports.preview(route[1], input);
          else { const saved = await imports.confirm(route[1], input); value = { customers: saved.customers, ...catalogResponse(saved) }; }
        } else { send(response, 404, { error: 'Import route not found.' }); return true; }
        send(response, 200, value);
      } catch (error) { send(response, error.status || 400, { error: error.status ? error.message : 'Import could not be completed. The current customer catalog is unchanged.' }); }
      return true;
    }
    const correction = /^\/admin\/api\/catalog\/([a-f0-9]{20})\/entries\/([a-f0-9]{20})$/.exec(pathname);
    if (correction) {
      if (request.url !== pathname) { send(response, 400, { error: 'Use an exact catalog correction route.' }); return true; }
      if (!['GET', 'PATCH'].includes(request.method)) { send(response, 405, { error: 'Method not allowed.' }); return true; }
      if (request.method === 'PATCH' && (request.headers.origin !== currentOrigin || !validRunToken(request.headers['x-studio-token']))) { send(response, 403, { error: 'Run token required.' }); return true; }
      try {
        if (request.method === 'GET') send(response, 200, await imports.entry(correction[1], correction[2]));
        else { const saved = await imports.correct(correction[1], correction[2], await bodyJSON(request)); const display = catalogResponse(saved); send(response, 200, { customers: saved.customers, ...display, entry: display.entries.find(entry => entry.id === correction[2]) }); }
      } catch (error) { send(response, error.status || 400, { error: error.status ? error.message : 'The catalog correction could not be saved.' }); }
      return true;
    }
    if (request.method === 'POST' && pathname === '/admin/api/customers') {
      if (request.headers.origin !== currentOrigin || !validRunToken(request.headers['x-studio-token'])) { send(response, 403, { error: 'Run token required.' }); return true; }
      try {
        const saved = await customers.save(await bodyJSON(request));
        send(response, 200, { customers: saved.customers, ...catalogResponse(saved) });
      } catch (error) { send(response, error.status || 400, { error: error.status ? error.message : 'Customer configuration could not be saved.' }); }
      return true;
    }
    if (pathname === '/admin/api/preview') {
      if (request.url !== pathname) { send(response, 400, { error: 'Use an exact preview route.' }, undefined, head); return true; }
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); send(response, 405, { error: 'Method not allowed.' }, undefined, head); return true; }
      if (request.headers.origin !== currentOrigin || !validRunToken(request.headers['x-studio-token'])) { send(response, 403, { error: 'Run token required.' }); return true; }
      try {
        const input = await bodyJSON(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['customerId', 'productId', 'fields', 'catalogRevision', 'previewSeed'].includes(key))) throw new Error('Unsupported preview request.');
        if (typeof input.previewSeed !== 'string' || !/^[a-f0-9]{48}$/i.test(input.previewSeed)) throw new Error('Use a valid preview seed.');
        if (input.fields && Object.hasOwn(input.fields, 'client')) throw new Error('Client is determined by the saved customer.');
        const fields = validateFields(input.fields), catalog = await customers.scan(input.customerId);
        if (catalog.customer.catalogRevision && input.catalogRevision !== catalog.customer.catalogRevision) throw Object.assign(new Error('Catalog changed. Reload products before generating a report.'), { status: 409 });
        const selected = catalog.products.find(product => product.id === input.productId && (!product.status || product.status === 'ready'));
        if (!selected) throw new Error('Select a catalog product.');
        const components = validateComponents(undefined, selected.components);
        const product = { ...selected, components, unit: new Set(components.map(row => row.unit)).size === 1 ? components[0].unit : 'mixed' };
        if (Date.now() >= previewDeadline - 1000) throw new Error('Report renderer timed out.');
        send(response, 200, await reports.preview(product, { ...fields, client: catalog.customer.name }, { seed: input.previewSeed, deadline: previewDeadline }));
      } catch (error) { send(response, error.status || 400, { error: error.code ? 'Report operation failed; previous reports are preserved.' : error.message }); }
      return true;
    }
    if (request.method === 'POST' && pathname === '/admin/api/generate') {
      const supplied = request.headers['x-studio-token'];
      if (request.headers.origin !== currentOrigin || !validRunToken(supplied)) {
        send(response, 403, { error: 'Run token required.' }); return true;
      }
      try {
        const input = await bodyJSON(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['customerId', 'productId', 'fields', 'components', 'publish', 'catalogRevision'].includes(key)) || typeof input.publish !== 'boolean') throw new Error('Choose Preview or Generate and publish.');
        if (input.fields && Object.hasOwn(input.fields, 'client')) throw new Error('Client is determined by the saved customer.');
        const fields = validateFields(input.fields);
        const catalog = await customers.scan(input.customerId);
        if (catalog.customer.catalogRevision && input.catalogRevision !== catalog.customer.catalogRevision) throw Object.assign(new Error('Catalog changed. Reload products before generating a report.'), { status: 409 });
        const selected = catalog.products.find(product => product.id === input.productId);
        if (!selected) throw new Error('Select a catalog product.');
        const components = validateComponents(input.components, selected.components);
        const product = { ...selected, components, unit: new Set(components.map(row => row.unit)).size === 1 ? components[0].unit : 'mixed' };
        const result = await reports.generate(product, { ...fields, client: catalog.customer.name }, input.publish);
        send(response, 201, { ...result, previewURL: '/admin' + result.previewURL, pdfURL: '/admin' + result.pdfURL, publicURL: new URL('/coa/' + result.report.lookupCode, publicURL).href });
      } catch (error) { send(response, error.status || 400, { error: error.code ? 'Report operation failed; previous reports are preserved.' : error.message }); }
      return true;
    }
    const noticeCode = /^\/admin\/api\/reports\/(AN-[A-Z0-9]{4}-[A-Z0-9]{4})\/notification$/.exec(pathname)?.[1];
    if (noticeCode) {
      if (request.url !== pathname) { send(response, 400, { error: 'Use an exact notification route.' }, undefined, head); return true; }
      if (!['GET', 'POST'].includes(request.method)) { send(response, 405, { error: 'Method not allowed.' }, undefined, head); return true; }
      if (request.method === 'POST' && (request.headers.origin !== currentOrigin || !validRunToken(request.headers['x-studio-token']))) { send(response, 403, { error: 'Run token required.' }); return true; }
      try {
        if (request.method === 'GET' && (Number(request.headers['content-length']) > 0 || request.headers['transfer-encoding'])) throw Object.assign(new Error('Body rejected.'), { status: 400 });
        const input = request.method === 'POST' ? await bodyJSON(request) : null;
        if (input && (!input || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'recipientEmail') || input.confirm !== true || typeof input.recipientEmail !== 'string' || input.recipientEmail.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.recipientEmail))) throw Object.assign(new Error('Supply a recipient email and explicit confirmation.'), { status: 400 });
        if (request.method === 'POST' && !input) throw Object.assign(new Error('Supply a recipient email and explicit confirmation.'), { status: 400 });
        send(response, 200, !reportMail ? { state: 'not_configured' } : request.method === 'GET' ? reportMail.status(noticeCode) : await reportMail.request(noticeCode, input));
      } catch (error) { send(response, error.status || 400, { error: error.status ? error.message : 'Publication notice could not be queued.' }); }
      return true;
    }
    if (pathname === '/admin/api/reports' || pathname.startsWith('/admin/api/reports/')) {
      const route = /^\/admin\/api\/reports\/(AN-[A-Z0-9]{4}-[A-Z0-9]{4})\/(remove|restore)$/.exec(pathname);
      if (!route || request.url !== pathname) { send(response, 400, { error: 'Use an exact report operation route.' }, undefined, head); return true; }
      if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); send(response, 405, { error: 'Method not allowed.' }, undefined, head); return true; }
      if (request.headers.origin !== currentOrigin || !validRunToken(request.headers['x-studio-token'])) { send(response, 403, { error: 'Run token required.' }); return true; }
      try {
        const input = await bodyJSON(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) { send(response, 400, { error: 'Supply an empty JSON object.' }); return true; }
        send(response, 200, await reports[route[2]](route[1]));
      } catch (error) { send(response, error.status || 400, { error: error.status ? error.message : 'Report state could not be changed. Refresh the library and retry.' }); }
      return true;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD'); send(response, 405, { error: 'Method not allowed.' }); return true;
    }
    try {
      if (pathname === '/admin/api/session') {
        const profiles = await customers.list(), defaultCustomerId = profiles[0]?.id || '';
        let initial = { customer: null, products: [], catalogRevision: null, entries: [], counts: { total: 0, ready: 0, blocked: 0 } };
        if (defaultCustomerId) {
          try { initial = catalogResponse(await customers.scan(defaultCustomerId)); }
          catch (error) { initial = { customer: profiles[0], products: [], catalogRevision: null, entries: [], counts: { total: 0, ready: 0, blocked: 0 }, catalogError: error.message }; }
        }
        send(response, 200, { token, customers: profiles, defaultCustomerId, ...initial, publicOrigin: publicURL, mail: { reportNoticesEnabled: !!reportMail?.enabled() } }, undefined, head); return true;
      }
      if (pathname === '/admin/api/catalog') {
        const query = new URL(request.url, currentOrigin).searchParams;
        if ([...query.keys()].length !== 1 || query.getAll('customerId').length !== 1) { send(response, 400, { error: 'Choose a saved customer.' }, undefined, head); return true; }
        send(response, 200, catalogResponse(await customers.scan(query.get('customerId'))), undefined, head); return true;
      }
      if (pathname === '/admin/api/history') {
        if (!['/admin/api/history', '/admin/api/history?state=removed'].includes(request.url)) { send(response, 400, { error: 'Choose Published or Removed reports.' }, undefined, head); return true; }
        send(response, 200, await reports.history(request.url.endsWith('?state=removed') ? 'removed' : 'published'), undefined, head); return true;
      }
      if (files.has(pathname)) {
        const file = files.get(pathname), type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        send(response, 200, await readFile(new URL(file, import.meta.url)), type, head); return true;
      }
      const image = /^\/admin\/images\/([a-f0-9]{20})\/([a-f0-9]{20})$/.exec(pathname);
      if (image) {
        const product = (await customers.scan(image[1])).products.find(row => row.id === image[2]);
        if (product) { send(response, 200, await readFile(product.imagePath), 'image/png', head); return true; }
      }
      const asset = /^\/admin\/catalog-assets\/([a-f0-9]{20})\/([a-f0-9]{32})$/.exec(pathname);
      if (asset) {
        if (request.url !== pathname) { send(response, 404, { error: 'Asset route not found.' }, undefined, head); return true; }
        const catalog = await customers.scan(asset[1]), image = catalog.sources?.find(image => image.id === asset[2]);
        if (image) { send(response, 200, await readFile(image.path), 'image/png', head); return true; }
      }
      const bundle = /^\/admin\/bundles\/(published|previews|removed)\/(AN-[A-Z0-9]{4}-[A-Z0-9]{4})\/(report\.svg|report\.pdf)$/.exec(pathname);
      if (bundle && validCode(bundle[2])) {
        const base = await realpath(path.join(reports.root, bundle[1]));
        const file = await realpath(path.join(base, bundle[2], bundle[3]));
        if (path.dirname(path.dirname(file)) !== base) throw new Error('Path rejected.');
        send(response, 200, await readFile(file), bundle[3].endsWith('.pdf') ? 'application/pdf' : 'image/svg+xml', head); return true;
      }
      send(response, 404, { error: 'Not found.' }, undefined, head);
    } catch (error) { send(response, error.status || 404, { error: error.status ? error.message : 'Not found.' }, undefined, head); }
    return true;
  }
  return { handle, store: reports.root };
}
