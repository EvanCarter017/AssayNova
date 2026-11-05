import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { scrypt } from 'node:crypto';
import http from 'node:http';
import { createStudio } from '../conference/studio.mjs';
import { createAuth, validPassword } from '../conference/auth.mjs';

const PASSWORD = 'Synthetic authentication fixture 073';
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'assaynova-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const images = path.join(root, 'images'), store = path.join(root, 'reports'), authStore = path.join(root, 'credentials');
  await mkdir(images); await writeFile(path.join(images, 'BPC-157 10mg.png'), await readFile(new URL('../templates/coa/assets/sample-vial-product.png', import.meta.url)));
  let studio;
  async function start() {
    studio = await createStudio({ images, store, authStore, port: 0, ...options });
    const server = studio.server;
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    return studio;
  }
  await start();
  return { root, images, store, authStore, start, get studio() { return studio; } };
}
async function loginPage(origin) {
  const response = await fetch(origin + '/admin'), html = await response.text();
  return { response, html, csrf: html.match(/name="admin-auth-csrf" content="([^"]+)"/)?.[1], mode: html.match(/name="admin-auth-mode" content="([^"]+)"/)?.[1] };
}
function attempt(origin, csrf, route, password = PASSWORD, headers = {}) {
  return fetch(origin + '/admin/auth/' + route, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf, ...headers }, body: JSON.stringify({ password }) });
}
const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
const secured = (origin, cookie, pathname, options = {}) => fetch(origin + pathname, { ...options, headers: { Cookie: cookie, ...options.headers } });

test('anonymous admin offers exactly one password input and protects every private API/asset/method', async t => {
  const files = await fixture(t), origin = files.studio.origin, page = await loginPage(origin);
  assert.equal(page.response.status, 200); assert.equal(page.mode, 'setup'); assert.match(page.html, /Set administrator password/); assert.match(page.html, /autocomplete="new-password"/);
  assert.equal([...page.html.matchAll(/<input\b/g)].length, 1); assert.doesNotMatch(page.html, /username|registration|recovery|operator\.js|product-search|api\/session|BPC-157/i); assert.match(page.csrf, /^[a-f0-9]{64}$/);
  for (const asset of ['/admin/login.js', '/admin/login.css', '/admin/admin-i18n.mjs']) for (const method of ['GET', 'HEAD']) assert.equal((await fetch(origin + asset, { method })).status, 200);
  assert.equal((await fetch(origin + '/admin/admin-i18n.mjs', { method: 'POST' })).status, 401);
  for (const pathname of ['/admin/operator.js', '/admin/operator.css', '/admin/product-search.mjs', '/admin/api/session', '/admin/api/history', '/admin/api/generate', '/admin/images/opaque', '/admin/bundles/previews/AN-TEST-0001/report.svg', '/admin/bundles/published/AN-TEST-0001/report.pdf', '/admin/auth/credential.json']) {
    for (const method of ['GET', 'HEAD', 'POST']) { const response = await fetch(origin + pathname, { method }); assert.equal(response.status, 401, method + ' ' + pathname); assert.equal(response.headers.get('cache-control'), 'no-store'); }
  }
  assert.equal((await fetch(origin + '/admin/api/session', { headers: { Cookie: 'an_admin_' + new URL(origin).port + '=' + 'f'.repeat(64) } })).status, 401);
  assert.equal((await fetch(origin + '/admin/auth/setup')).status, 405);
  assert.equal((await fetch(origin + '/admin/api/session', { headers: { Origin: 'http://evil.invalid' } })).status, 403);
});

test('setup requires exact CSRF/Origin/JSON/password bounds and persists only the fixed scrypt hash', async t => {
  const files = await fixture(t), origin = files.studio.origin, { csrf } = await loginPage(origin);
  assert.equal((await attempt(origin, csrf, 'setup', PASSWORD, { 'X-Admin-CSRF': 'é'.repeat(64) })).status, 403);
  assert.equal((await attempt(origin, csrf, 'setup', PASSWORD, { Origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await attempt(origin, csrf, 'setup', PASSWORD, { 'Content-Type': 'text/plain' })).status, 415);
  for (const password of ['', 'short', 'x'.repeat(129), '😀'.repeat(129), null, {}, 42]) assert.equal((await attempt(origin, csrf, 'setup', password)).status, 400);
  assert.equal((await attempt(origin, csrf, 'setup', 'x'.repeat(9000))).status, 413);
  const extra = await fetch(origin + '/admin/auth/setup', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf }, body: JSON.stringify({ password: PASSWORD, username: 'excluded' }) }); assert.equal(extra.status, 400);
  const response = await attempt(origin, csrf, 'setup'); assert.equal(response.status, 200); const cookie = cookieOf(response);
  assert.match(response.headers.get('set-cookie'), new RegExp('^an_admin_' + new URL(origin).port + '=[a-f0-9]{64};')); assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=28800/); assert.match(response.headers.get('set-cookie'), /Path=\/admin/);
  const raw = await readFile(path.join(files.authStore, 'credential.json'), 'utf8'), record = JSON.parse(raw);
  assert.deepEqual(Object.keys(record).sort(), ['hash', 'salt', 'version']); assert.equal(record.version, 1); assert.match(record.salt, /^[a-f0-9]{32}$/); assert.match(record.hash, /^[a-f0-9]{64}$/); assert.ok(!raw.includes(PASSWORD));
  const expected = await promisify(scrypt)(Buffer.from(PASSWORD), Buffer.from(record.salt, 'hex'), 32, { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 }); assert.equal(record.hash, expected.toString('hex'));
  assert.equal((await secured(origin, cookie, '/admin/api/session')).status, 200); assert.equal((await attempt(origin, csrf, 'setup', 'another synthetic password')).status, 409); assert.equal(await readFile(path.join(files.authStore, 'credential.json'), 'utf8'), raw);
  const page = await loginPage(origin); assert.equal(page.mode, 'login'); assert.match(page.html, /autocomplete="current-password"/);
  const loginScript = await (await fetch(origin + '/admin/login.js')).text();
  assert.match(loginScript, /createAdminI18n/); assert.doesNotMatch(loginScript, /setItem|getItem|sessionStorage/);
  assert.equal(validPassword(' '.repeat(10)), true); assert.equal(validPassword('😀'.repeat(128)), true);
});

test('malformed, oversized or unreadable credential records fail closed and are never overwritten', async t => {
  for (const record of ['', '{broken', JSON.stringify({ version: 1, salt: 'a'.repeat(32), hash: 'f'.repeat(64), extra: true }), JSON.stringify({ version: 1, salt: 'a'.repeat(32), hash: 'é'.repeat(64) }), 'x'.repeat(1025), null]) {
    const files = await fixture(t), origin = files.studio.origin; await mkdir(files.authStore);
    const filename = path.join(files.authStore, 'credential.json'); if (record === null) await mkdir(filename); else await writeFile(filename, record);
    const page = await loginPage(origin); assert.equal(page.response.status, 503); assert.match(page.html, /Administration unavailable/); assert.doesNotMatch(page.html, /Set administrator password/);
    assert.equal((await attempt(origin, page.csrf, 'setup')).status, 503); assert.equal((await fetch(origin + '/admin/api/session')).status, 503);
    if (record !== null) assert.equal(await readFile(filename, 'utf8'), record);
  }
});

test('fragmented HTTP UTF-8 setup and login preserve the exact Unicode password bytes', async t => {
  const files = await fixture(t), origin = files.studio.origin, { csrf } = await loginPage(origin);
  const password = 'Exact-é-😃-测试-password-073';
  async function fragmented(route) {
    const body = Buffer.from(JSON.stringify({ password })), split = body.indexOf(Buffer.from('é')) + 1;
    assert.equal(body[split - 1], 0xc3); assert.equal(body[split], 0xa9);
    return new Promise((resolve, reject) => {
      const url = new URL(origin);
      const request = http.request({ hostname: url.hostname, port: url.port, path: '/admin/auth/' + route, method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
      request.on('error', reject); request.write(body.subarray(0, split));
      // Distinct HTTP chunks split the two-byte code point on the wire.
      setTimeout(() => request.end(body.subarray(split)), 15);
    });
  }
  assert.equal(await fragmented('setup'), 200); assert.equal((await attempt(origin, csrf, 'login', password)).status, 200); assert.equal(await fragmented('login'), 200);
  const record = JSON.parse(await readFile(path.join(files.authStore, 'credential.json'), 'utf8'));
  const expected = await promisify(scrypt)(Buffer.from(password, 'utf8'), Buffer.from(record.salt, 'hex'), 32, { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 }); assert.equal(record.hash, expected.toString('hex'));
});

test('independent concurrent setups cannot overwrite the first exclusively created credential', async t => {
  const files = await fixture(t), store = path.join(files.root, 'setup-race');
  const first = createAuth({ store, origin: 'http://127.0.0.1:41001' }), second = createAuth({ store, origin: 'http://127.0.0.1:41002' });
  const passwords = ['First synthetic setup password', 'Second synthetic setup password'];
  const results = await Promise.allSettled([first.unlock(passwords[0], true), second.unlock(passwords[1], true)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const loser = results.find(result => result.status === 'rejected'); assert.ok([409, 503].includes(loser.reason.status));
  const winner = results.findIndex(result => result.status === 'fulfilled'), before = await readFile(path.join(store, 'credential.json'));
  const reader = createAuth({ store, origin: 'http://127.0.0.1:41003' }); await reader.unlock(passwords[winner], false);
  await assert.rejects(reader.unlock(passwords[1 - winner], false), error => error.status === 401); assert.deepEqual(await readFile(path.join(store, 'credential.json')), before);
});

test('server sessions expire on idle/absolute clocks, logout invalidates captured cookies and new login rotates them', async t => {
  let now = 0; const files = await fixture(t, { authOptions: { clock: () => now } }), origin = files.studio.origin, { csrf } = await loginPage(origin);
  const first = await attempt(origin, csrf, 'setup'), cookie = cookieOf(first);
  now += 29 * 60000; assert.equal((await secured(origin, cookie, '/admin/api/session')).status, 200);
  now += 29 * 60000; assert.equal((await secured(origin, cookie, '/admin/api/session')).status, 200);
  now += 30 * 60000; assert.equal((await secured(origin, cookie, '/admin/api/session')).status, 401);
  const second = await attempt(origin, csrf, 'login'), nextCookie = cookieOf(second); assert.notEqual(nextCookie, cookie);
  for (let index = 0; index < 16; index++) { now += 29 * 60000; assert.equal((await secured(origin, nextCookie, '/admin/api/session')).status, 200); }
  now += 29 * 60000; assert.equal((await secured(origin, nextCookie, '/admin/api/session')).status, 401);
  const third = await attempt(origin, csrf, 'login'), current = cookieOf(third), session = await (await secured(origin, current, '/admin/api/session')).json();
  assert.equal((await secured(origin, current, '/admin/auth/logout', { method: 'POST', headers: { Origin: origin, 'X-Studio-Token': 'a'.repeat(64) } })).status, 403);
  assert.equal((await secured(origin, current, '/admin/auth/logout')).status, 405);
  const logout = await secured(origin, current, '/admin/auth/logout', { method: 'POST', headers: { Origin: origin, 'X-Studio-Token': session.token } }); assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await secured(origin, current, '/admin/api/session')).status, 401); assert.equal((await fetch(origin + '/admin/api/session')).status, 401);
});

test('one shared setup/login hash limit, five-failure cooldown, bounded sessions and exact password bytes', async t => {
  const files = await fixture(t); let now = 0;
  const auth = createAuth({ store: path.join(files.root, 'unit-auth'), origin: 'https://127.0.0.1:443', clock: () => now, maxSessions: 2 });
  const password = '  synthetic exact password  ';
  const first = auth.unlock(password, true); await assert.rejects(auth.unlock(password, false), error => error.status === 429 && error.retryAfter === 1); const initial = await first; assert.match(initial, /; Secure$/); assert.match(initial, /^an_admin_443=/);
  await assert.rejects(auth.unlock(password.trim(), false), error => error.status === 401);
  for (let index = 1; index < 4; index++) await assert.rejects(auth.unlock('incorrect synthetic password', false), error => error.status === 401);
  await assert.rejects(auth.unlock('incorrect synthetic password', false), error => error.status === 429 && error.retryAfter === 60);
  await assert.rejects(auth.unlock(password, false), error => error.status === 429); now += 60001;
  const next = await auth.unlock(password, false), last = await auth.unlock(password, false);
  assert.equal(auth.authorized({ headers: { cookie: initial.split(';')[0] } }), false); assert.equal(auth.authorized({ headers: { cookie: next.split(';')[0] } }), true); assert.equal(auth.authorized({ headers: { cookie: last.split(';')[0] } }), true);
});

test('real HTTP cooldown and restart preserve the password while old cookies lose all private access', async t => {
  let now = 0; const files = await fixture(t, { authOptions: { clock: () => now } }); let origin = files.studio.origin;
  const page = await loginPage(origin), setup = await attempt(origin, page.csrf, 'setup'), oldCookie = cookieOf(setup);
  for (let index = 0; index < 4; index++) assert.equal((await attempt(origin, page.csrf, 'login', 'incorrect fixture password')).status, 401);
  const blocked = await attempt(origin, page.csrf, 'login', 'incorrect fixture password'); assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '60'); assert.equal((await attempt(origin, page.csrf, 'login')).status, 429);
  now += 60001; assert.equal((await attempt(origin, page.csrf, 'login')).status, 200);
  const before = await readFile(path.join(files.authStore, 'credential.json'));
  files.studio.server.closeAllConnections(); await new Promise(resolve => files.studio.server.close(resolve));
  await files.start(); origin = files.studio.origin; const after = await loginPage(origin); assert.equal(after.mode, 'login'); assert.notEqual(after.csrf, page.csrf);
  assert.equal((await secured(origin, oldCookie, '/admin/api/session')).status, 401); assert.equal((await attempt(origin, after.csrf, 'login', PASSWORD, { 'X-Admin-CSRF': page.csrf })).status, 403);
  const unlocked = await attempt(origin, after.csrf, 'login'); assert.equal(unlocked.status, 200); assert.equal((await secured(origin, cookieOf(unlocked), '/admin/operator.js')).status, 200); assert.deepEqual(await readFile(path.join(files.authStore, 'credential.json')), before);
});
