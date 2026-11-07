import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdminProxy, isPrivateIPv4, isAdminProxyPeer } from '../conference/admin-proxy.mjs';
import { createStudio } from '../conference/studio.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const password = '  Synthetic 密码 proxy 077  ';
async function listen(t, handler, port = 0) {
  const server = http.createServer(handler);
  server.requestTimeout = server.headersTimeout = 10000;
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { server, port: server.address().port, origin: 'http://127.0.0.1:' + server.address().port };
}
async function freePort() {
  const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'assaynova-proxy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const images = path.join(root, 'images'), store = path.join(root, 'reports'), authStore = path.join(root, 'auth');
  await mkdir(images);
  await writeFile(path.join(images, 'BPC-157 10mg.png'), await readFile(path.join(project, 'templates/coa/assets/sample-vial-product.png')));
  return { root, images, store, authStore };
}
function raw(origin, target, { method = 'GET', headers = {}, body, fragments, agent } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = http.request({ hostname: url.hostname, port: url.port, path: target, method, headers, agent }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8'), reusedSocket: req.reusedSocket }));
    });
    req.on('error', reject);
    if (fragments) (async () => { for (const fragment of fragments) { req.write(fragment); await delay(2); } req.end(); })().catch(reject);
    else req.end(body);
  });
}
async function bridge(t, primary, options = {}) {
  const port = await freePort(), origin = 'http://127.0.0.1:' + port, externalOrigin = 'http://192.168.0.60:' + port;
  const proxy = createAdminProxy({ upstream: primary.origin, externalOrigin, port, bindAddress: '0.0.0.0', ...options });
  return { ...await listen(t, (req, res) => { proxy.handle(req, res).catch(() => res.destroy()); }, port), externalOrigin, proxy };
}
function challenge(html) { return html.match(/name="admin-auth-csrf" content="([a-f0-9]+)"/)[1]; }
function cookie(response) { return response.headers['set-cookie'][0].split(';')[0]; }
async function unlock(origin, setup = false, value = password, headers = {}) {
  const page = await raw(origin, '/admin');
  return raw(origin, '/admin/auth/' + (setup ? 'setup' : 'login'), { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Admin-CSRF': challenge(page.text), ...headers }, body: JSON.stringify({ password: value }) });
}
async function renderer(requestFile, output) {
  const request = JSON.parse(await readFile(requestFile)), code = request.lookupCode;
  const report = { id: code, lookupCode: code, publication: 'published', issued: '2026-11-06', purity: '99.42' };
  const record = { client: request.fields.client || '', purity: ['99.41', '99.43', '99.42'], composition: request.product.components, screenings: [], spectra: [], chromatogram: [] };
  await Promise.all([
    writeFile(path.join(output, 'bundle.json'), JSON.stringify({ report, record, label: request.product.name })),
    writeFile(path.join(output, 'report.pdf'), Buffer.from('%PDF-fixture\u0000\u00ff', 'latin1')),
    writeFile(path.join(output, 'report.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>' + code + '</text></svg>')
  ]);
}
async function primary(t, files, render = renderer) {
  const studio = await createStudio({ ...files, port: 0, render, publicOrigin: 'http://127.0.0.1:4318' });
  t.after(() => { studio.server.closeAllConnections(); return new Promise(resolve => studio.server.close(resolve)); });
  return studio;
}

test('proxy configuration is literal, private, canonical and cannot target its own listener', () => {
  const valid = { upstream: 'http://127.0.0.1:4317', externalOrigin: 'http://192.168.0.60:4318', port: 4318, bindAddress: '0.0.0.0' };
  assert.equal(typeof createAdminProxy(valid).handle, 'function');
  for (const upstream of ['http://localhost:4317', 'https://127.0.0.1:4317', 'http://127.1:4317', 'http://2130706433:4317', 'http://127.0.0.1:4318', 'http://127.0.0.1:04317', 'http://127.0.0.1:4317/', 'http://user@127.0.0.1:4317', 'http://127.0.0.1:4317?x', 'http://127.0.0.1:4317#x', 'http://192.168.0.60:4317']) assert.throws(() => createAdminProxy({ ...valid, upstream }), undefined, upstream);
  for (const externalOrigin of ['http://localhost:4318', 'https://192.168.0.60:4318', 'http://8.8.8.8:4318', 'http://127.0.0.1:4318', 'http://192.168.0.60:4319', 'http://192.168.0.60:4318/', 'http://192.168.0.60:4318/admin']) assert.throws(() => createAdminProxy({ ...valid, externalOrigin }), undefined, externalOrigin);
  for (const bindAddress of ['127.0.0.1', '::', 'localhost', '8.8.8.8']) assert.throws(() => createAdminProxy({ ...valid, bindAddress }));
  for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.60']) assert.equal(isPrivateIPv4(address), true);
  for (const address of ['127.0.0.1', '127.0.0.8', '::ffff:127.0.0.1', '::ffff:192.168.0.5', '10.0.0.1']) assert.equal(isAdminProxyPeer(address), true);
  for (const address of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '::1', '::ffff:8.8.8.8', undefined]) assert.equal(isAdminProxyPeer(address), false);
});

test('unmodified peer, exact external Host/Origin, fetch-site, canonical paths and local-only setup guard upstream calls', async t => {
  let calls = 0;
  const upstream = await listen(t, (_req, res) => { calls++; res.end('ok'); }), proxy = await bridge(t, upstream);
  for (const headers of [
    { Host: 'localhost:' + proxy.port }, { Host: 'evil.invalid', 'X-Forwarded-Host': new URL(proxy.origin).host },
    { Origin: 'http://evil.invalid' }, { Origin: proxy.externalOrigin }, { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' }
  ]) assert.equal((await raw(proxy.origin, '/admin', { headers })).status, 403);
  for (const headers of [{}, { Origin: '' }, { 'X-Forwarded-Origin': proxy.origin }, { Origin: proxy.externalOrigin }]) assert.equal((await raw(proxy.origin, '/admin/auth/login', { method: 'POST', headers })).status, 403);
  for (const target of ['/admin/%61pi/session', '/admin%2fapi/session', '/admin/../api/session', '/admin//api/session', '/admin/./api/session', '/admin\\api/session', 'http://127.0.0.1/admin', '/api/session', '/admin/%252e%252e/secret']) assert.equal((await raw(proxy.origin, target)).status, 400, target);
  for (const method of ['GET', 'HEAD', 'POST']) assert.equal((await raw(proxy.origin, '/admin/auth/setup', { method, headers: { Origin: proxy.origin } })).status, 403);
  for (const address of ['8.8.8.8', undefined, '::ffff:8.8.8.8']) {
    let status;
    await proxy.proxy.handle({ url: '/admin', method: 'GET', headers: { host: new URL(proxy.origin).host, forwarded: 'for=127.0.0.1', 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: address } }, { writeHead(value) { status = value; }, end() {} });
    assert.equal(status, 403);
  }
  assert.equal(calls, 0);
  assert.equal((await raw(proxy.origin, '/admin')).status, 200);
  assert.equal((await raw(proxy.origin, '/admin', { headers: { Host: new URL(proxy.externalOrigin).host, Origin: proxy.externalOrigin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal(calls, 2);
});

test('raw Unicode body/query and safe headers survive normal POST completion; cookies and hop headers are isolated', async t => {
  let received;
  const bytes = Buffer.from(JSON.stringify({ password }));
  const upstream = await listen(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { body: Buffer.concat(chunks), headers: req.headers, url: req.url };
    await delay(15); // IncomingMessage normal close must not abort this response.
    res.writeHead(201, { 'Content-Type': 'application/pdf', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'no-store', Location: '/admin', Connection: 'x-remove', 'X-Remove': 'secret', 'Access-Control-Allow-Origin': '*', 'Set-Cookie': ['unrelated=drop; HttpOnly', 'an_admin_' + upstream.port + '=' + 'a'.repeat(64) + '; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800'] });
    res.end(Buffer.from([0, 255, 127, 10]));
  });
  const proxy = await bridge(t, upstream), split = bytes.indexOf(Buffer.from('密')) + 1;
  const response = await raw(proxy.origin, '/admin/auth/login?keep=%2B', { method: 'POST', fragments: [bytes.subarray(0, split), bytes.subarray(split)], headers: {
    Origin: proxy.origin, 'Content-Type': 'application/json', 'X-Admin-CSRF': 'c'.repeat(64), 'X-Studio-Token': 'd'.repeat(64), Accept: 'application/json',
    Cookie: 'an_admin_' + upstream.port + '=' + 'f'.repeat(64) + '; unrelated=hidden; an_admin_' + proxy.port + '=' + 'b'.repeat(64),
    Forwarded: 'host=evil.invalid', 'X-Forwarded-For': '8.8.8.8', Authorization: 'not-forwarded', Connection: 'x-studio-token', 'X-Custom': 'not-forwarded'
  } });
  assert.equal(response.status, 201); assert.deepEqual(received.body, bytes); assert.equal(received.url, '/admin/auth/login?keep=%2B');
  assert.equal(received.headers.origin, upstream.origin); assert.equal(received.headers.host, new URL(upstream.origin).host); assert.equal(received.headers['content-length'], String(bytes.length));
  assert.equal(received.headers.cookie, 'an_admin_' + upstream.port + '=' + 'b'.repeat(64));
  for (const name of ['forwarded', 'x-forwarded-for', 'authorization', 'x-custom', 'x-studio-token', 'transfer-encoding']) assert.equal(received.headers[name], undefined, name);
  assert.deepEqual(response.bytes, Buffer.from([0, 255, 127, 10])); assert.equal(response.headers.location, '/admin'); assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['content-security-policy'], "default-src 'none'");
  assert.equal(response.headers['x-remove'], undefined); assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(response.headers['set-cookie'], ['an_admin_' + proxy.port + '=' + 'a'.repeat(64) + '; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800']);
});

test('oversized input never reaches upstream; unavailable/timeout/aborted clients are bounded and recoverable', async t => {
  let calls = 0, sawAbort;
  const aborted = new Promise(resolve => sawAbort = resolve);
  const upstream = await listen(t, (req, res) => {
    calls++;
    if (req.url === '/admin/abort') { res.on('close', sawAbort); return; }
    if (req.url === '/admin/timeout') return;
    res.end('recovered');
  });
  const proxy = await bridge(t, upstream, { timeout: 50 });
  assert.equal((await raw(proxy.origin, '/admin/api/generate', { method: 'POST', headers: { Origin: proxy.origin }, body: Buffer.alloc(8193) })).status, 413); assert.equal(calls, 0);
  assert.equal((await raw(proxy.origin, '/admin/timeout')).status, 504);
  await new Promise((resolve, reject) => {
    const req = http.get(proxy.origin + '/admin/abort');
    req.on('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error));
    // Wait for the upstream request to exist before aborting downstream.
    const timer = setInterval(() => { if (calls >= 2) { clearInterval(timer); req.destroy(); } }, 2);
  });
  await Promise.race([aborted, delay(1000).then(() => assert.fail('upstream did not observe client abort'))]);
  assert.equal((await raw(proxy.origin, '/admin')).text, 'recovered');
  const down = await bridge(t, { origin: 'http://127.0.0.1:' + await freePort() });
  const response = await raw(down.origin, '/admin'); assert.equal(response.status, 502); assert.equal(response.text, 'Administration is unavailable.'); assert.doesNotMatch(response.text, /127\.0|ECONN|stack|password/i);
});

test('only an exact canonical PUT import-chunk route receives the 256 KiB proxy exception', async t => {
  let calls = 0, bytes = 0;
  const upstream = await listen(t, async (req, res) => { calls++; bytes = 0; for await (const chunk of req) bytes += chunk.length; res.end('accepted'); });
  const proxy = await bridge(t, upstream), target = '/admin/api/imports/' + 'a'.repeat(32) + '/files/' + 'b'.repeat(32) + '?offset=0';
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
  const send = (route = target, method = 'PUT', body = Buffer.alloc(256 * 1024)) => raw(proxy.origin, route, { method, body, agent, headers: { Origin: proxy.origin, 'Content-Type': 'application/octet-stream' } });
  assert.equal((await send()).status, 200); assert.equal(bytes, 256 * 1024); assert.equal(calls, 1);
  const second = await send(); assert.equal(second.status, 200); assert.equal(second.reusedSocket, true); assert.equal(calls, 2);
  assert.equal((await send(target, 'PUT', Buffer.alloc(256 * 1024 + 1))).status, 413);
  assert.equal(calls, 2); const recovered = await send(); assert.equal(recovered.status, 200); assert.equal(recovered.reusedSocket, true);
  for (const [route, method] of [[target, 'POST'], [target.replace('offset=0', 'offset=00'), 'PUT'], [target + '&extra=1', 'PUT'], ['/admin/api/generate', 'PUT']]) {
    const before = calls; assert.equal((await send(route, method)).status, 413); assert.equal(calls, before);
    const recovery = await send(); assert.equal(recovery.status, 200); assert.equal(recovery.reusedSocket, true); assert.equal(calls, before + 1);
  }
});

test('real primary authentication stays private behind bridge, and bridge cookie cannot borrow/revoke distinct local login', async t => {
  const files = await fixture(t), studio = await primary(t, files), local = await unlock(studio.origin, true), localCookie = cookie(local);
  assert.equal(local.status, 200);
  const proxy = await bridge(t, studio), page = await raw(proxy.origin, '/admin');
  assert.match(page.text, /Unlock administration/); assert.doesNotMatch(page.text, /<select|operator\.js/);
  for (const asset of ['login.js', 'login.css', 'admin-i18n.mjs']) for (const method of ['GET', 'HEAD']) assert.equal((await raw(proxy.origin, '/admin/' + asset, { method })).status, 200);
  for (const target of ['/admin/operator.js', '/admin/operator.css', '/admin/product-search.mjs', '/admin/api/session', '/admin/api/history', '/admin/images/opaque', '/admin/bundles/previews/AN-AAAA-1111/report.pdf']) {
    for (const method of ['GET', 'HEAD']) assert.equal((await raw(proxy.origin, target, { method })).status, 401, target);
  }
  assert.equal((await raw(proxy.origin, '/admin/api/generate', { method: 'POST', headers: { Origin: proxy.origin } })).status, 401);
  assert.equal((await raw(proxy.origin, '/admin/api/session', { headers: { Cookie: localCookie } })).status, 401, 'primary cookie must not be borrowed');
  assert.equal((await unlock(proxy.origin, false, 'wrong fixture password')).status, 401);
  const loggedIn = await unlock(proxy.origin), bridgeCookie = cookie(loggedIn);
  assert.equal(loggedIn.status, 200); assert.match(bridgeCookie, new RegExp('^an_admin_' + proxy.port + '=[a-f0-9]{64}$'));
  assert.match(loggedIn.headers['set-cookie'][0], /Path=\/admin; HttpOnly; SameSite=Strict; Max-Age=28800/);
  assert.notEqual(bridgeCookie.split('=')[1], localCookie.split('=')[1]);
  const get = (target, cookies = localCookie + '; ' + bridgeCookie) => raw(proxy.origin, target, { headers: { Cookie: cookies } });
  const session = JSON.parse((await get('/admin/api/session')).text), localSession = JSON.parse((await raw(studio.origin, '/admin/api/session', { headers: { Cookie: localCookie } })).text);
  assert.equal(session.token, localSession.token); assert.deepEqual(session.products, localSession.products); assert.deepEqual(JSON.parse((await get('/admin/api/history')).text), []);
  for (const value of [bridgeCookie + '; ' + bridgeCookie, bridgeCookie + '; an_admin_' + proxy.port + ' =malformed', 'an_admin_' + proxy.port + '=malformed', 'an_admin_' + proxy.port + '=' + 'a'.repeat(64), localCookie + '; an_admin_' + proxy.port]) assert.equal((await get('/admin/api/session', value)).status, 401);
  const logout = headers => raw(proxy.origin, '/admin/auth/logout', { method: 'POST', headers: { Cookie: localCookie + '; ' + bridgeCookie, Origin: proxy.origin, 'X-Studio-Token': session.token, ...headers } });
  assert.equal((await logout({ 'X-Studio-Token': 'f'.repeat(64) })).status, 403); assert.equal((await logout({ Origin: '' })).status, 403);
  const loggedOut = await logout(); assert.equal(loggedOut.status, 200); assert.match(loggedOut.headers['set-cookie'][0], new RegExp('^an_admin_' + proxy.port + '=;.*Max-Age=0'));
  assert.equal((await get('/admin/api/session')).status, 401);
  assert.equal((await raw(studio.origin, '/admin/api/session', { headers: { Cookie: localCookie } })).status, 200, 'distinct primary browser session survives bridge logout');
});

test('bridge and primary generate through one writer/busy lock, with unchanged private/public snapshot bytes', async t => {
  const files = await fixture(t); let enter, release;
  const entered = new Promise(resolve => enter = resolve), held = new Promise(resolve => release = resolve);
  let hold = true;
  const studio = await primary(t, files, async (...args) => { if (hold) { enter(); await held; } await renderer(...args); });
  const localCookie = cookie(await unlock(studio.origin, true)), proxy = await bridge(t, studio), bridgeCookie = cookie(await unlock(proxy.origin));
  const session = JSON.parse((await raw(proxy.origin, '/admin/api/session', { headers: { Cookie: bridgeCookie } })).text);
  const input = { customerId: session.defaultCustomerId, productId: session.products[0].id, fields: {}, publish: false };
  const generate = (origin, cookieValue, extra = {}, value = input) => raw(origin, '/admin/api/generate', { method: 'POST', headers: { Origin: origin, Cookie: cookieValue, 'Content-Type': 'application/json', 'X-Studio-Token': session.token, ...extra }, body: JSON.stringify(value) });
  assert.equal((await generate(proxy.origin, bridgeCookie, { 'X-Studio-Token': '' })).status, 403);
  const running = generate(proxy.origin, bridgeCookie); await entered;
  assert.equal((await generate(studio.origin, localCookie)).status, 409); release();
  const preview = JSON.parse((await running).text); hold = false;
  assert.equal((await raw(proxy.origin, preview.previewURL)).status, 401);
  assert.deepEqual((await raw(proxy.origin, preview.pdfURL, { headers: { Cookie: bridgeCookie } })).bytes, await readFile(path.join(files.store, 'previews', preview.report.lookupCode, 'report.pdf')));
  const publishedResponse = await generate(proxy.origin, bridgeCookie, {}, { ...input, publish: true }); assert.equal(publishedResponse.status, 201);
  const published = JSON.parse(publishedResponse.text), code = published.report.lookupCode;
  assert.deepEqual(JSON.parse((await raw(studio.origin, '/admin/api/history', { headers: { Cookie: localCookie } })).text).map(row => row.lookupCode), [code]);
  const reader = await launch(t, files, ['--conference-reports', '--conference-store=' + files.store]);
  assert.equal((await raw(reader.origin, '/verify')).status, 200);
  const dto = JSON.parse((await raw(reader.origin, '/__reports/' + code)).text); assert.equal(dto.report.lookupCode, code); assert.equal(dto.record.client, 'Research Client');
  for (const ext of ['pdf', 'svg']) assert.deepEqual((await raw(reader.origin, '/__reports/' + code + '/report.' + ext)).bytes, (await raw(proxy.origin, '/admin/bundles/published/' + code + '/report.' + ext, { headers: { Cookie: bridgeCookie } })).bytes);
  assert.equal((await raw(reader.origin, '/__reports/' + preview.report.lookupCode)).status, 404);
  const stateChange = (action, extra = {}) => raw(proxy.origin, '/admin/api/reports/' + code + '/' + action, { method: 'POST', headers: { Origin: proxy.origin, Cookie: bridgeCookie, 'Content-Type': 'application/json', 'X-Studio-Token': session.token, ...extra }, body: '{}' });
  assert.equal((await stateChange('remove', { 'X-Studio-Token': '' })).status, 403);
  assert.equal((await stateChange('remove')).status, 200);
  assert.deepEqual(JSON.parse((await raw(studio.origin, '/admin/api/history', { headers: { Cookie: localCookie } })).text), []);
  assert.equal(JSON.parse((await raw(proxy.origin, '/admin/api/history?state=removed', { headers: { Cookie: bridgeCookie } })).text)[0].lookupCode, code);
  for (const route of ['/__reports/' + code, '/__reports/' + code + '/report.pdf', '/__reports/' + code + '/report.svg', '/coa/' + code + '/report.pdf']) for (const method of ['GET', 'HEAD']) assert.equal((await raw(reader.origin, route, { method })).status, 404, method + ' ' + route);
  for (const ext of ['pdf', 'svg']) {
    const route = '/admin/bundles/removed/' + code + '/report.' + ext;
    assert.equal((await raw(proxy.origin, route)).status, 401);
    assert.deepEqual((await raw(proxy.origin, route, { headers: { Cookie: bridgeCookie } })).bytes, await readFile(path.join(files.store, 'removed', code, 'report.' + ext)));
  }
  assert.equal((await stateChange('restore')).status, 200);
  assert.deepEqual((await raw(reader.origin, '/coa/' + code + '/report.pdf')).bytes, await readFile(path.join(files.store, 'published', code, 'report.pdf')));
});

async function launch(t, files, args, { production = false, reject = false } = {}) {
  const port = await freePort(), origin = 'http://127.0.0.1:' + port;
  const preload = path.join(files.root, 'timeouts.mjs');
  await writeFile(preload, "import http from 'node:http';const create=http.createServer;http.createServer=function(...args){const server=create(...args);server.once('listening',()=>console.log('TIMEOUT_PROOF:'+JSON.stringify([server.requestTimeout,server.headersTimeout])));return server;};");
  const actual = typeof args === 'function' ? args(port) : args;
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'server.mjs', '--no-accounts', '--port=' + port, ...actual], { cwd: project, env: { ...process.env, NODE_ENV: production ? 'production' : 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  let stopping;
  const stop = () => stopping ??= child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  t.after(stop);
  if (reject) { const code = await new Promise(resolve => child.once('exit', resolve)); assert.notEqual(code, 0); return output; }
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(origin + '/')).ok) return { origin, stop, output: () => output }; } catch {}
    await delay(25);
  }
  throw new Error('Proxy fixture startup did not complete: ' + output);
}

test('server flags opt into bridge before method guards with ten-second bounds; default LAN/default production stay closed', async t => {
  const files = await fixture(t), studio = await primary(t, files); await unlock(studio.origin, true);
  const args = port => ['--host=0.0.0.0', '--conference-reports', '--conference-store=' + files.store, '--admin-proxy=' + studio.origin, '--admin-proxy-origin=http://192.168.0.60:' + port];
  const server = await launch(t, files, args);
  assert.match(server.output(), /TIMEOUT_PROOF:\[10000,10000\]/);
  assert.match((await raw(server.origin, '/admin')).text, /Unlock administration/);
  assert.equal((await raw(server.origin, '/admin/api/history')).status, 401);
  assert.equal((await unlock(server.origin)).status, 200);
  assert.equal((await raw(server.origin, '/__dev/status')).status, 404);
  for (const [args, options] of [[['--host=0.0.0.0', '--conference-reports', '--conference-store=' + files.store], {}], [[], { production: true }]]) {
    const closed = await launch(t, files, args, options);
    for (const method of ['GET', 'HEAD', 'POST']) assert.equal((await raw(closed.origin, '/admin/api/generate', { method })).status, 404);
  }
  for (const invalid of [
    port => ['--admin-proxy=' + studio.origin],
    port => ['--admin-proxy-origin=http://192.168.0.60:' + port],
    port => args(port).filter(value => value !== '--conference-reports'),
    port => [...args(port), '--admin'], port => [...args(port), '--watch'],
    port => args(port).filter(value => value !== '--host=0.0.0.0'),
    port => args(port).map(value => value.startsWith('--admin-proxy=') ? '--admin-proxy=http://localhost:4317' : value),
    port => args(port).map(value => value.startsWith('--admin-proxy-origin=') ? '--admin-proxy-origin=http://8.8.8.8:' + port : value)
  ]) assert.match(await launch(t, files, invalid, { reject: true }), /proxy|Proxy/);
  assert.match(await launch(t, files, args, { reject: true, production: true }), /disabled in production/);
});
