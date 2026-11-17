import http from 'node:http';
import { isIP } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCOARoute } from './dist/data.js';
import { resolvePageRoute, injectRouteSEO } from './dist/routes.js';
import { parseReportPDFRoute } from './report-pdf.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const conferenceEnabled = process.argv.includes('--conference-reports');
const adminEnabled = process.argv.includes('--admin');
const proxyOptions = process.argv.filter(argument => argument === '--admin-proxy' || argument.startsWith('--admin-proxy='));
const proxyOriginOptions = process.argv.filter(argument => argument === '--admin-proxy-origin' || argument.startsWith('--admin-proxy-origin='));
const proxyEnabled = proxyOptions.length > 0 || proxyOriginOptions.length > 0;
if (proxyEnabled && (proxyOptions.length !== 1 || proxyOriginOptions.length !== 1 || !proxyOptions[0].startsWith('--admin-proxy=') || !proxyOriginOptions[0].startsWith('--admin-proxy-origin='))) throw new Error('Supply both --admin-proxy and --admin-proxy-origin once.');
if (proxyEnabled && (!conferenceEnabled || adminEnabled || process.argv.includes('--watch'))) throw new Error('Admin proxy requires --conference-reports, without --admin or --watch.');
if (adminEnabled && !conferenceEnabled) throw new Error('--admin requires --conference-reports.');
if (conferenceEnabled && process.env.NODE_ENV === 'production') throw new Error('Temporary reports are disabled in production.');
const conference = conferenceEnabled ? await import('./conference/reader.mjs') : null;
const conferenceStore = conferenceEnabled ? path.resolve(process.argv.find(argument => argument.startsWith('--conference-store='))?.slice('--conference-store='.length) ?? conference.DEFAULT_STORE) : null;
const liveReload = process.argv.includes('--watch') && !['production', 'demo'].includes(process.env.NODE_ENV);
const devTools = liveReload ? await import('./dev/context.mjs') : null;
const devModules = new Map([
  ['/__dev/client.js', './dev-client.js'],
  ['/__dev/locator.js', './dev/locator.js'],
  ['/__dev/prompt.js', './dev/prompt.js']
]);
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
const hostOption = process.argv.find((argument) => argument.startsWith('--host='));
const bindAddress = hostOption?.slice('--host='.length) ?? '127.0.0.1';
if (!isIP(bindAddress)) throw new Error('Choose a literal IPv4 or IPv6 address for --host.');
const localAddress = bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress === '::' ? '::1' : bindAddress;
const localHost = isIP(localAddress) === 6 ? `[${localAddress}]` : localAddress;
if (adminEnabled && !['127.0.0.1', '::1'].includes(bindAddress)) throw new Error('--admin requires a loopback bind (127.0.0.1 or ::1).');
const adminOriginOptions = process.argv.filter(argument => argument === '--admin-origin' || argument.startsWith('--admin-origin='));
let adminOrigin = `http://${localHost}:${port}`;
if (adminOriginOptions.length) {
  if (adminOriginOptions.length !== 1 || !adminOriginOptions[0].startsWith('--admin-origin=') || !adminEnabled || proxyEnabled) throw new Error('Supply --admin-origin once with --admin and a loopback authority.');
  const value = adminOriginOptions[0].slice('--admin-origin='.length);
  let url; try { url = new URL(value); } catch { throw new Error('Choose a canonical HTTPS administrator origin.'); }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Choose a canonical HTTPS administrator origin.');
  adminOrigin = value;
}
if (!process.argv.includes('--no-accounts')) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) throw new Error('Customer accounts require Node 24.15 or newer with native SQLite.');
}
const accountOptions = process.argv.includes('--no-accounts') ? { mode: 'disabled' } : (await import('./accounts/config.mjs')).accountConfiguration({
  argv: process.argv.slice(2), env: { NODE_ENV: process.env.NODE_ENV, ASSAYNOVA_ACCOUNT_STORE: process.env.ASSAYNOVA_ACCOUNT_STORE, ASSAYNOVA_ACCOUNT_ORIGIN: process.env.ASSAYNOVA_ACCOUNT_ORIGIN },
  port, bindAddress, adminProxy: proxyEnabled ? { upstream: proxyOptions[0].slice('--admin-proxy='.length), externalOrigin: proxyOriginOptions[0].slice('--admin-proxy-origin='.length) } : null
});
const mailConfiguration = accountOptions.mode === 'authority' || process.env.ASSAYNOVA_MAIL_CONFIG_FILE ? await (await import('./accounts/mail-config.mjs')).loadMailConfig({
  accountOrigin: accountOptions.origins?.[0], adminOrigin: adminEnabled ? adminOrigin : undefined,
  accountDirectory: accountOptions.directory,
  reportDirectory: conferenceStore,
  adminAuthDirectory: process.argv.find(argument => argument.startsWith('--admin-auth-store='))?.slice('--admin-auth-store='.length)
}) : { enabled: false };
if (mailConfiguration.enabled && accountOptions.mode !== 'authority') throw new Error('Mail requires the sole account authority.');
const googleConfiguration = accountOptions.mode === 'authority' || process.env.ASSAYNOVA_GOOGLE_CONFIG_FILE ? await (await import('./accounts/google-config.mjs')).loadGoogleConfig({ accountOptions, bindAddress, reportDirectory: conferenceStore, adminAuthDirectory: process.argv.find(argument => argument.startsWith('--admin-auth-store='))?.slice('--admin-auth-store='.length) }) : { enabled: false };
const reportMailModule = accountOptions.mode === 'authority' && adminEnabled ? await import('./conference/report-mail.mjs') : null;
const customerAccounts = accountOptions.mode === 'authority' ? await (await import('./accounts/handler.mjs')).createAccountHandler({ ...accountOptions, googleOptions: { config: googleConfiguration }, mailOptions: { config: mailConfiguration, reportEligible: code => reportMailModule ? reportMailModule.reportMailEligible(conferenceStore, code) : false } }) : null;
const reportMail = reportMailModule?.createReportMail({ store: conferenceStore, mail: customerAccounts?.reportMail });
const admin = adminEnabled ? await (await import('./conference/admin.mjs')).createAdmin({
  reportMail, origin: adminOrigin, store: conferenceStore,
  authStore: process.argv.find(argument => argument.startsWith('--admin-auth-store='))?.slice('--admin-auth-store='.length),
  images: process.argv.find(argument => argument.startsWith('--admin-images='))?.slice('--admin-images='.length),
  publicOrigin: process.argv.find(argument => argument.startsWith('--admin-public-origin='))?.slice('--admin-public-origin='.length) ?? `http://${localHost}:${port}`
}) : null;
const adminProxy = proxyEnabled ? (await import('./conference/admin-proxy.mjs')).createAdminProxy({
  upstream: proxyOptions[0].slice('--admin-proxy='.length), externalOrigin: proxyOriginOptions[0].slice('--admin-proxy-origin='.length), port, bindAddress
}) : null;

const customerAccountProxy = accountOptions.mode === 'proxy' ? (await import('./accounts/proxy.mjs')).createAccountProxy(accountOptions) : null;
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer(async (request, response) => {
  let pathname;
  let encodedPathname;
  try { encodedPathname = new URL(request.url, 'http://localhost').pathname; pathname = decodeURIComponent(encodedPathname); }
  catch { response.writeHead(400); response.end('Bad request'); return; }
  const rawPathname = request.url.split('?')[0];
  let decodedRawPathname;
  try { decodedRawPathname = decodeURIComponent(rawPathname); }
  catch { response.writeHead(400); response.end('Bad request'); return; }
  const accountPath = value => value === '/api/account' || value.startsWith('/api/account/');
  if (accountPath(pathname) || accountPath(rawPathname) || accountPath(decodedRawPathname)) {
    if (customerAccounts) { await customerAccounts.handle(request, response); return; }
    if (customerAccountProxy) { await customerAccountProxy.handle(request, response); return; }
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ error: { code: 'ACCOUNTS_DISABLED', message: 'Customer accounts are unavailable on this server.' } })); return;
  }
  const adminPath = value => value === '/admin' || value.startsWith('/admin/');
  if (adminPath(pathname) || adminPath(rawPathname)) {
    if (admin && await admin.handle(request, response)) return;
    if (adminProxy && await adminProxy.handle(request, response)) return;
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(request.method === 'HEAD' ? undefined : 'Not found'); return;
  }
  if (['/api/session', '/api/history', '/api/generate', '/images', '/bundles'].includes(pathname) || pathname.startsWith('/images/') || pathname.startsWith('/bundles/')) {
    response.writeHead(404, { 'Cache-Control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : 'Not found'); return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }
  // Retired specimen files must stay unavailable even if left in an old dist tree.
  if (/^\/reports\/(?:sample-[ac]\.(?:pdf|svg)|sample-data\.js|bitstream-vera-license\.txt|\.gitattributes)$/i.test(pathname)) {
    response.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : 'Not found'); return;
  }
  if (conference && await conference.handlePublicReport(request, response, pathname, conferenceStore)) return;
  if (parseReportPDFRoute(request.url) || pathname === '/__reports' || pathname.startsWith('/__reports/')) {
    response.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : 'Not found'); return;
  }
  if (pathname === '/privacy/signals') {
    response.writeHead(200, {
      'Content-Type': mime['.json'], 'Cache-Control': 'no-store', 'Vary': 'Sec-GPC',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ gpc: request.headers['sec-gpc'] === '1' }));
    return;
  }
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
  if (liveReload && (devModules.has(pathname) || pathname === '/__dev/context')) {
    try {
      const contents = pathname === '/__dev/context'
        ? JSON.stringify(devTools.sourceMetadata(path.dirname(root), await readFile(path.join(root, 'app.js'), 'utf8')))
        : await readFile(new URL(devModules.get(pathname), import.meta.url));
      response.writeHead(200, {
        'Content-Type': pathname === '/__dev/context' ? mime['.json'] : mime['.js'],
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : 'Development context unavailable');
    }
    return;
  }
  if (pathname === '/__dev' || pathname.startsWith('/__dev/')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : 'Not found');
    return;
  }
  const coaRoute = resolveCOARoute(encodedPathname);
  const generatedReport = conference && coaRoute?.code ? await conference.readPublished(conferenceStore, coaRoute.code) : null;
  const pageRoute = resolvePageRoute(encodedPathname);
  const filename = path.resolve(root, '.' + (pageRoute || coaRoute ? '/index.html' : pathname));
  if (!filename.startsWith(root + path.sep)) {
    response.writeHead(403); response.end('Forbidden'); return;
  }
  try {
    if (!(await stat(filename)).isFile()) throw new Error('Not a file');
    let contents = await readFile(filename);
    if (liveReload && path.extname(filename) === '.html') {
      const sourceFile = 'dist/' + path.relative(root, filename).split(path.sep).join('/');
      contents = Buffer.from(devTools.annotateHTML(contents.toString('utf8'), sourceFile)
        .replace(/<\/body>/i, '<script type="module" src="/__dev/client.js"></script></body>'));
    }
    const isHTML = path.extname(filename) === '.html';
    if (isHTML) {
      let html = contents.toString('utf8');
      // Add production privacy assets after development annotation so original source lines remain accurate.
      html = html
        .replace(/<\/head>/i, '<link rel="stylesheet" href="/vendor/cookieconsent-3.2.1/cookieconsent.css"><link rel="stylesheet" href="/privacy/consent.css"></head>')
        .replace(/<\/body>/i, '<script type="module" src="/privacy/consent.js"></script></body>');
      if (conferenceEnabled) html = html.replace(/<\/head>/i, '<meta name="assaynova-report-reader" content="enabled"></head>');
      if (accountOptions.mode !== 'disabled') html = html.replace(/<\/head>/i, '<meta name="assaynova-accounts" content="enabled"></head>');
      if (pageRoute || coaRoute) {
        html = injectRouteSEO(html, { pageRoute, coaRoute, generatedReport, liveReload });
      }
      contents = Buffer.from(html);
    }
    const isPrivateRoute = Boolean(coaRoute || pageRoute?.noindex);
    const cacheControl = isPrivateRoute
      ? 'no-store'
      : liveReload
        ? 'no-cache'
        : isHTML
          ? 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400'
          : 'public, max-age=86400, stale-while-revalidate=604800';
    const responseHeaders = {
      'Content-Type': mime[path.extname(filename)] ?? 'application/octet-stream',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Referrer-Policy': ['/verify-email', '/reset-password', '/google-signin'].includes(pathname.replace(/\/$/, '')) ? 'no-referrer' : 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    };
    if (coaRoute) responseHeaders['X-Robots-Tag'] = 'noindex, noarchive';
    else if (pageRoute?.noindex) responseHeaders['X-Robots-Tag'] = 'noindex, nofollow';
    response.writeHead(coaRoute && !generatedReport ? 404 : 200, responseHeaders);
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch {
    response.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    });
    response.end(request.method === 'HEAD' ? undefined : 'Not found');
  }
});
if (adminEnabled || proxyEnabled || accountOptions.mode !== 'disabled') { server.requestTimeout = 10000; server.headersTimeout = 10000; }
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is in use. Try: node server.mjs --port=${port + 1}` : error.message);
  process.exitCode = 1;
});
server.listen(port, bindAddress, () => {
  customerAccounts?.startMail();
  console.log(`AssayNova ready\nLocal: http://${localHost}:${port}\nBind: ${bindAddress}\nProject: ${path.dirname(root)}\nLive reload: ${liveReload ? 'ON — CSS updates in place; HTML/JS changes reload the page' : 'OFF (add --watch to enable)'}\nPress Ctrl+C to stop.`);
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

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  await customerAccounts?.stopMail();
  clearTimeout(changeTimer);
  watcher?.close();
  for (const client of clients) client.end();
  server.close(async () => { await customerAccounts?.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
