import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createAccountProxy } from '../accounts/proxy.mjs';
import { requestBoundary } from '../accounts/boundary.mjs';
import { accountFixture, browser, draftRecord, fixturePassword } from './support/customer-account-fixture.mjs';

async function bridge(upstream, options = {}) {
  let handler, closed = false;
  const server = http.createServer((request, response) => handler.handle(request, response)); server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port, externalOrigin = `http://192.168.0.60:${port}`;
  handler = createAccountProxy({ upstream, externalOrigin, bindAddress: '0.0.0.0', port, ...options });
  return { server, port, base: `http://127.0.0.1:${port}`, externalOrigin, async close() { if (closed) return; closed = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function raw(base, route, { method = 'GET', headers = {}, body, agent } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port, path: route, method, headers, agent }, response => { let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text, headers: response.headers, reusedSocket: request.reusedSocket })); });
    request.setTimeout(10000, () => request.destroy(new Error('Synthetic proxy fixture timed out.'))); request.on('error', reject); request.end(body);
  });
}

test('account bridge shares one authority while isolating both customer cookies from local and admin sessions', async t => {
  const primary = await accountFixture(); t.after(() => primary.close()); const proxy = await bridge(primary.base); t.after(() => proxy.close());
  const headers = []; primary.server.on('request', request => headers.push({ cookie: request.headers.cookie, forwarded: request.headers['x-forwarded-for'] }));
  const remote = browser(proxy.base), signup = await remote.signup(); assert.equal(signup.status, 201);
  assert.equal(signup.setCookies.length, 2); for (const value of signup.setCookies) { assert.ok(value.includes('_' + proxy.port + '=')); assert.match(value, /HttpOnly; SameSite=Strict/); assert.doesNotMatch(value, /an_admin_|Domain=/); }
  const local = browser(primary.base); await local.call('/session'); assert.equal((await local.call('/login', 'POST', { email: 'fixture@example.invalid', password: fixturePassword })).status, 200);
  const localSession = local.jar.get('an_customer_' + primary.port), remoteSession = remote.jar.get('an_customer_' + proxy.port); assert.notEqual(localSession, remoteSession);
  const created = await remote.call('/requests', 'POST', { record: draftRecord(), idempotencyKey: 'proxy-first-draft-088' }); assert.equal(created.status, 201); assert.equal((await local.call('/requests')).data.requests[0].id, created.data.request.id);
  const forged = `an_admin_${primary.port}=${'a'.repeat(64)}; an_customer_${primary.port}=${localSession}; ${remote.cookie()}`;
  assert.equal((await remote.call('/session', 'GET', undefined, { headers: { Cookie: forged, 'X-Forwarded-For': '8.8.8.8' } })).status, 200);
  const forwarded = headers.at(-1); assert.doesNotMatch(forwarded.cookie, /an_admin/); assert.ok(forwarded.cookie.includes('an_customer_' + primary.port + '=' + remoteSession)); assert.ok(!forwarded.cookie.includes(localSession)); assert.equal(forwarded.forwarded, undefined);
  assert.equal((await remote.call('/logout', 'POST', {})).status, 200); assert.equal((await remote.call('/requests')).status, 401); assert.equal((await local.call('/requests')).status, 200);
  const duplicate = await raw(proxy.base, '/api/account/requests', { headers: { Cookie: `an_customer_${proxy.port}=${remoteSession}; an_customer_${proxy.port}=${remoteSession}` } }); assert.equal(duplicate.status, 401);
});

test('bridge rejects Host/Origin/path/peer and foreign CSRF before allowing account mutations', async t => {
  const primary = await accountFixture(); t.after(() => primary.close()); const proxy = await bridge(primary.base); t.after(() => proxy.close()); let calls = 0; primary.server.on('request', () => calls++);
  for (const options of [{ headers: { Host: 'evil.invalid' } }, { method: 'POST', headers: {} }, { method: 'POST', headers: { Origin: 'http://evil.invalid' } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }]) { const before = calls; assert.equal((await raw(proxy.base, '/api/account/session', options)).status, 403); assert.equal(calls, before); }
  for (const route of ['/api/account/%73ession', '/api/account//session', '/api/account/session/../login', '/api/other']) assert.equal((await raw(proxy.base, route)).status, 400);
  assert.equal((await raw(proxy.base, '/api/account/session', { headers: { Host: `192.168.0.60:${proxy.port}` } })).status, 200);
  assert.throws(() => requestBoundary({ method: 'GET', headers: { host: `127.0.0.1:${proxy.port}` }, socket: { remoteAddress: '8.8.8.8' } }, [proxy.base], true), /rejected/);
  const a = browser(proxy.base), b = browser(proxy.base); await a.call('/session'); await b.call('/session'); b.csrf = a.csrf; assert.equal((await b.call('/signup', 'POST', { email: 'x@example.invalid', password: fixturePassword })).status, 403);
  assert.throws(() => createAccountProxy({ upstream: 'http://example.invalid:4317', externalOrigin: proxy.externalOrigin, port: proxy.port, bindAddress: '0.0.0.0' }), /loopback/);
});

test('account bridge allows exact 64KiB draft route and recovers reused connections after rejected bodies', async t => {
  const primary = await accountFixture(); t.after(() => primary.close()); const proxy = await bridge(primary.base); t.after(() => proxy.close()); const a = browser(proxy.base); await a.signup();
  const record = draftRecord(); record.notes = '\x01'.repeat(1200); record.samples = Array.from({ length: 10 }, (_, index) => ({ ...record.samples[0], id: 'sample-' + index, name: 'n'.repeat(160), batch: 'b'.repeat(160), amount: 'a'.repeat(80) })); record.sample = record.samples[0].name; record.quantity = 10;
  const input = { record, idempotencyKey: 'large-draft-route-088' }; assert.ok(Buffer.byteLength(JSON.stringify(input)) > 8192); assert.equal((await a.call('/requests', 'POST', input)).status, 201);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
  const first = await raw(proxy.base, '/api/account/session', { agent, headers: { Cookie: a.cookie() } }); assert.equal(first.status, 200);
  const rejected = await raw(proxy.base, '/api/account/login', { method: 'POST', agent, headers: { Origin: proxy.base, Cookie: a.cookie(), 'X-Account-CSRF': a.csrf, 'Content-Type': 'application/json' }, body: ' '.repeat(8193) }); assert.equal(rejected.status, 413); assert.equal(rejected.reusedSocket, true);
  const recovery = await raw(proxy.base, '/api/account/session', { agent, headers: { Cookie: a.cookie() } }); assert.equal(recovery.status, 200); assert.equal(recovery.reusedSocket, true);
  assert.equal((await a.call('/requests', 'POST', undefined, { raw: ' '.repeat(65537) })).status, 413);
});

test('bridge failures and peer admission stay bounded and do not expose upstream diagnostics', async t => {
  const primary = await accountFixture(); const proxy = await bridge(primary.base, { peerMaximum: 2 }); t.after(() => proxy.close()); const a = browser(proxy.base); await a.call('/session');
  assert.equal((await a.call('/login', 'POST', { email: 'none@example.invalid', password: fixturePassword })).status, 401); assert.equal((await a.call('/login', 'POST', { email: 'none@example.invalid', password: fixturePassword })).status, 429);
  await primary.close(); const result = await a.call('/session'); assert.equal(result.status, 502); assert.doesNotMatch(result.text, /ECONN|127\.0\.0\.1|sqlite|password_hash/i);
  const silent = http.createServer(() => {}); silent.listen(0, '127.0.0.1'); await once(silent, 'listening'); t.after(() => { silent.closeAllConnections(); silent.close(); });
  const timed = await bridge(`http://127.0.0.1:${silent.address().port}`, { timeout: 25 }); t.after(() => timed.close()); assert.equal((await browser(timed.base).call('/session')).status, 504);
});

test('bridge admits new challenge GETs while reusing its issued valid nonce without another mint charge', async t => {
  const primary = await accountFixture(); t.after(() => primary.close()); const proxy = await bridge(primary.base, { peerMaximum: 2 }); t.after(() => proxy.close());
  let calls = 0; primary.server.on('request', () => calls++);
  const a = browser(proxy.base), b = browser(proxy.base); assert.equal((await a.call('/session')).status, 200); assert.equal((await b.call('/session')).status, 200);
  const before = calls; assert.equal((await browser(proxy.base).call('/session')).status, 429); assert.equal(calls, before);
  const nonce = a.csrf; assert.equal((await a.call('/session')).data.csrfToken, nonce);
  const forged = `an_customer_csrf_${proxy.port}=${'a'.repeat(64)}`;
  assert.equal((await raw(proxy.base, '/api/account/session', { headers: { Cookie: forged } })).status, 429);
});
