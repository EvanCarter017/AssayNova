import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import http from 'node:http';
import path from 'node:path';
import { accountFixture, browser, draftRecord, fixturePassword } from './support/customer-account-fixture.mjs';
import { validPassword } from '../accounts/auth.mjs';

test('customer signup uses real SQLite hashes, browser-bound CSRF, exact Unicode passwords and private cookies', async t => {
  const f = await accountFixture(); t.after(() => f.close()); const a = browser(f.base), b = browser(f.base);
  const anon = await a.call('/session'); assert.deepEqual({ ...anon.data, csrfToken: '' }, { authenticated: false, user: null, csrfToken: '', mail: { enabled: false }, google: { enabled: false } }); assert.match(anon.data.csrfToken, /^[a-f0-9]{64}$/);
  await b.call('/session'); b.csrf = a.csrf;
  assert.equal((await b.call('/signup', 'POST', { email: 'b@example.invalid', password: fixturePassword })).status, 403);
  const password = '  密碼🧪 exact password 088  ';
  const created = await a.call('/signup', 'POST', { email: ' Fixture@Example.invalid ', password, name: 'Research team' });
  assert.equal(created.status, 201); assert.equal(created.data.user.email, 'fixture@example.invalid'); assert.equal(created.data.user.emailVerified, false); assert.equal(created.data.recoveryCodes.length, 8); assert.equal(new Set(created.data.recoveryCodes).size, 8);
  assert.equal(created.setCookies.length, 2); for (const cookie of created.setCookies) { assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /Path=\/api\/account/); assert.doesNotMatch(cookie, /Domain=|an_admin/); }
  assert.doesNotMatch(created.text, /sessionToken|password_hash|password_salt/);
  const db = new DatabaseSync(path.join(f.directory, 'accounts.sqlite'), { readOnly: true }); t.after(() => db.close());
  const user = db.prepare('SELECT * FROM account_users').get(); assert.equal(user.password_salt.length, 32); assert.equal(user.password_hash.length, 64); assert.notEqual(user.password_hash, password);
  const session = db.prepare('SELECT * FROM account_sessions').get(); assert.notEqual(session.token_hash, a.jar.get('an_customer_' + f.port)); assert.notEqual(session.csrf_hash, a.csrf);
  for (const code of created.data.recoveryCodes) assert.ok(!JSON.stringify(db.prepare('SELECT * FROM account_recovery_codes').all()).includes(code.replaceAll('-', '')));
  const other = browser(f.base); await other.call('/session'); assert.equal((await other.call('/login', 'POST', { email: 'fixture@example.invalid', password: password.trim() })).status, 401); assert.equal((await other.call('/login', 'POST', { email: 'FIXTURE@example.invalid', password })).status, 200);
  assert.equal(validPassword('x'.repeat(14)), false); assert.equal(validPassword('🧪'.repeat(15)), true); assert.equal(validPassword('x'.repeat(129)), false); assert.equal(validPassword('x'.repeat(15) + '\ud800'), false);
  const duplicate = browser(f.base); assert.equal((await duplicate.signup('fixture@example.invalid')).status, 409);
});

test('account Host/Origin/method/metadata/JSON/overposting guards and exact body bounds', async t => {
  const f = await accountFixture(); t.after(() => f.close()); const a = browser(f.base); await a.call('/session');
  for (const headers of [{ Host: 'evil.invalid' }, { Origin: 'http://evil.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const result = await rawRequest(f.base, '/api/account/signup', { Cookie: a.cookie(), Origin: f.base, 'X-Account-CSRF': a.csrf, 'Content-Type': 'application/json', ...headers }, 'POST', [Buffer.from(JSON.stringify({ email: 'x@example.invalid', password: fixturePassword }))]);
    assert.equal(result.status, 403);
  }
  assert.equal((await a.call('/signup', 'POST', { email: 'x@example.invalid', password: fixturePassword }, { origin: false })).status, 403);
  assert.equal((await a.call('/signup', 'GET')).status, 405);
  assert.equal((await a.call('/signup', 'POST', { email: 'x@example.invalid', password: fixturePassword, role: 'admin' })).status, 400);
  assert.equal((await a.call('/signup', 'POST', { email: 'x@example.invalid', password: fixturePassword }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await a.call('/signup', 'POST', undefined, { raw: '{' })).status, 400);
  assert.equal((await a.call('/signup', 'POST', undefined, { raw: ' '.repeat(8193) })).status, 413);
  for (const route of ['/session?x=1', '/%73ession', '//session', '/session/../login']) {
    const result = await rawRequest(f.base, '/api/account' + route, { Cookie: a.cookie() }); assert.equal(result.status, 400);
  }
  const privateResult = await browser(f.base).call('/requests'); assert.equal(privateResult.status, 401);
  for (const result of [privateResult, await a.call('/session')]) { assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.headers.get('x-content-type-options'), 'nosniff'); assert.equal(result.headers.get('referrer-policy'), 'no-referrer'); assert.equal(result.headers.get('access-control-allow-origin'), null); }
});

test('account body reader preserves fragmented UTF8 passwords and rejects invalid encoding', async t => {
  const f = await accountFixture(); t.after(() => f.close()); const a = browser(f.base); await a.call('/session');
  const password = 'fragment 密碼🧪 password 088', body = Buffer.from(JSON.stringify({ email: 'unicode@example.invalid', password }));
  const at = body.indexOf(Buffer.from('密')) + 1;
  const result = await rawRequest(f.base, '/api/account/signup', { Cookie: a.cookie(), Origin: f.base, 'X-Account-CSRF': a.csrf, 'Content-Type': 'application/json' }, 'POST', [body.subarray(0, at), body.subarray(at)]);
  assert.equal(result.status, 201);
  const b = browser(f.base); await b.call('/session'); assert.equal((await b.call('/login', 'POST', { email: 'unicode@example.invalid', password })).status, 200);
  const bad = await rawRequest(f.base, '/api/account/login', { Cookie: b.cookie(), Origin: f.base, 'X-Account-CSRF': b.csrf, 'Content-Type': 'application/json' }, 'POST', [Buffer.from([0xff])]); assert.equal(bad.status, 400);
});

test('customer sessions and auth limits survive restart, expire, and logout-all revokes every session', async t => {
  let now = Date.now(); const options = { clock: () => now, authOptions: { identityLimit: 3, rateWindowMs: 60000, idleMs: 30000, absoluteMs: 600000 } };
  let f = await accountFixture(options); t.after(() => f.close()); const a = browser(f.base); await a.signup(); const b = browser(f.base); await b.call('/session'); await b.call('/login', 'POST', { email: 'fixture@example.invalid', password: fixturePassword });
  assert.equal((await b.call('/login', 'POST', { email: 'fixture@example.invalid', password: 'wrong password long enough' })).status, 401);
  const limited = await b.call('/login', 'POST', { email: 'fixture@example.invalid', password: fixturePassword }); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const { directory, port } = f; await f.close(); f = await accountFixture({ ...options, directory, port });
  assert.equal((await a.call('/session')).data.authenticated, true); assert.equal((await b.call('/login', 'POST', { email: 'fixture@example.invalid', password: fixturePassword })).status, 429);
  assert.equal((await a.call('/logout-all', 'POST', {})).status, 200); assert.equal((await b.call('/requests')).status, 401);
  now += 60001; await b.call('/session'); assert.equal((await b.call('/login', 'POST', { email: 'fixture@example.invalid', password: fixturePassword })).status, 200);
  now += 30001; assert.equal((await b.call('/session')).data.authenticated, false);
});

test('password rotation, eight recovery codes and concurrent recovery replay revoke prior sessions', async t => {
  const f = await accountFixture(); t.after(() => f.close()); const a = browser(f.base), created = await a.signup(); const oldCookie = a.cookie();
  const password = 'Replacement customer password 088'; const changed = await a.call('/password', 'POST', { currentPassword: fixturePassword, newPassword: password }); assert.equal(changed.status, 200); assert.notEqual(a.cookie(), oldCookie);
  const stolen = browser(f.base); for (const value of oldCookie.split('; ')) { const [key, content] = value.split('='); stolen.jar.set(key, content); } assert.equal((await stolen.call('/requests')).status, 401);
  const rotated = await a.call('/recovery-codes', 'POST', { currentPassword: password }); assert.equal(rotated.data.recoveryCodes.length, 8);
  const b = browser(f.base), c = browser(f.base); await b.call('/session'); await c.call('/session');
  assert.equal((await b.call('/recover', 'POST', { email: 'fixture@example.invalid', recoveryCode: created.data.recoveryCodes[0], newPassword: password })).status, 401);
  const payload = { email: 'fixture@example.invalid', recoveryCode: rotated.data.recoveryCodes[0], newPassword: 'Recovered customer password 088' };
  const results = await Promise.all([b.call('/recover', 'POST', payload), c.call('/recover', 'POST', payload)]); assert.deepEqual(results.map(value => value.status).sort(), [200, 401]);
  const success = results.find(value => value.status === 200); assert.equal(success.data.recoveryCodes.length, 8); assert.equal((await a.call('/requests')).status, 401);
  const login = browser(f.base); await login.call('/session'); assert.equal((await login.call('/login', 'POST', { email: 'fixture@example.invalid', password: payload.newPassword })).status, 200);
  assert.equal((await login.call('/profile', 'PATCH', { name: 'Updated', emailVerified: true })).status, 400); assert.equal((await login.call('/profile', 'PATCH', { name: 'Updated' })).data.user.name, 'Updated');
});

test('two users have isolated owned drafts, revision checks, replay-safe cap and lost-ack retry', async t => {
  const f = await accountFixture(); t.after(() => f.close()); const a = browser(f.base), b = browser(f.base); await a.signup('a@example.invalid'); await b.signup('b@example.invalid');
  const payload = { record: draftRecord(), idempotencyKey: 'frozen-first-attempt-088' };
  const committed = await a.call('/requests', 'POST', payload); assert.equal(committed.status, 201); const doc = committed.data.request; assert.notEqual(doc.id, payload.record.id);
  // Treat the first successful acknowledgement as lost; retry the identical frozen request.
  const replay = await a.call('/requests', 'POST', structuredClone(payload)); assert.equal(replay.status, 200); assert.equal(replay.data.request.id, doc.id);
  assert.equal((await b.call('/requests/' + doc.id)).status, 404); assert.equal((await b.call('/requests/' + doc.id, 'PUT', { record: payload.record, expectedRevision: 1 })).status, 404); assert.equal((await b.call('/requests/' + doc.id, 'DELETE', { expectedRevision: 1 })).status, 404); assert.deepEqual((await b.call('/requests')).data.requests, []);
  const updated = structuredClone(payload.record); updated.samples[0].name = 'Updated sample'; updated.sample = 'Updated sample';
  assert.equal((await a.call('/requests/' + doc.id, 'PUT', { record: updated, expectedRevision: 1 })).data.request.revision, 2);
  assert.equal((await a.call('/requests/' + doc.id, 'PUT', { record: updated, expectedRevision: 1 })).status, 409);
  assert.equal((await a.call('/requests', 'POST', { ...payload, record: updated })).status, 409);
  assert.equal((await a.call('/requests', 'POST', { ...payload, ownerId: b.jar.size })).status, 400);
  for (let index = 1; index < 50; index++) assert.equal((await a.call('/requests', 'POST', { record: draftRecord('Sample ' + index, 'FIXTURE-' + index), idempotencyKey: 'quota-fixture-key-' + index })).status, 201);
  assert.equal((await a.call('/requests', 'POST', { record: draftRecord('Beyond cap'), idempotencyKey: 'quota-fixture-beyond' })).status, 409);
  assert.equal((await a.call('/requests', 'POST', payload)).status, 200); assert.equal((await a.call('/requests')).data.requests.length, 50);
  assert.equal((await a.call('/requests/' + doc.id, 'DELETE', { expectedRevision: 1 })).status, 409); assert.equal((await a.call('/requests/' + doc.id, 'DELETE', { expectedRevision: 2 })).status, 200);
});

test('KDF admission is bounded and unknown valid login performs dummy derivation', async t => {
  let paused = false, calls = 0; const waiting = [], real = promisify(scrypt);
  const derive = async (...args) => { calls++; if (paused) await new Promise(resolve => waiting.push(resolve)); return real(...args); };
  const f = await accountFixture({ authOptions: { derive } }); t.after(() => f.close()); const a = browser(f.base); await a.signup();
  const unknown = browser(f.base); await unknown.call('/session'); const before = calls; assert.equal((await unknown.call('/login', 'POST', { email: 'unknown@example.invalid', password: fixturePassword })).status, 401); assert.equal(calls, before + 1);
  const browsers = [browser(f.base), browser(f.base), browser(f.base)]; for (const item of browsers) await item.call('/session'); paused = true;
  const first = browsers[0].call('/login', 'POST', { email: 'fixture@example.invalid', password: fixturePassword }); const second = browsers[1].call('/login', 'POST', { email: 'fixture@example.invalid', password: fixturePassword });
  while (waiting.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await browsers[2].call('/login', 'POST', { email: 'fixture@example.invalid', password: fixturePassword })).status, 429);
  paused = false; waiting.splice(0).forEach(resolve => resolve()); assert.equal((await first).status, 200); assert.equal((await second).status, 200);
});

test('a login derived before logout-all cannot create a late session after the security epoch changed', async t => {
  const real = promisify(scrypt); let holdNext = false, release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const derive = async (...args) => { if (holdNext) { holdNext = false; entered(); await new Promise(resolve => { release = resolve; }); } return real(...args); };
  const f = await accountFixture({ authOptions: { derive } }); t.after(() => f.close()); const a = browser(f.base); await a.signup(); const pendingBrowser = browser(f.base); await pendingBrowser.call('/session');
  holdNext = true; const pending = pendingBrowser.call('/login', 'POST', { email: 'fixture@example.invalid', password: fixturePassword }); await started;
  assert.equal((await a.call('/logout-all', 'POST', {})).status, 200); release(); assert.equal((await pending).status, 409); assert.equal((await pendingBrowser.call('/session')).data.authenticated, false);
});

test('peer and global auth quotas persist and expired preauth CSRF cannot be reused', async t => {
  for (const limits of [{ peerLimit: 2, globalLimit: 100 }, { peerLimit: 100, globalLimit: 2 }]) {
    let now = Date.now(); const options = { clock: () => now, authOptions: { ...limits, identityLimit: 100, rateWindowMs: 60000, challengeMs: 1000 } };
    let f = await accountFixture(options); t.after(() => f.close()); const a = browser(f.base); await a.call('/session');
    for (const email of ['one@example.invalid', 'two@example.invalid']) assert.equal((await a.call('/login', 'POST', { email, password: fixturePassword })).status, 401);
    assert.equal((await a.call('/login', 'POST', { email: 'three@example.invalid', password: fixturePassword })).status, 429);
    const { port, directory } = f; await f.close(); f = await accountFixture({ ...options, port, directory }); assert.equal((await a.call('/login', 'POST', { email: 'four@example.invalid', password: fixturePassword })).status, 429);
    now += 1001; assert.equal((await a.call('/signup', 'POST', { email: 'new@example.invalid', password: fixturePassword })).status, 403);
  }
});

test('preauth mint quotas persist without charging valid reuse or allowing one peer to monopolize the pool', async t => {
  let f = await accountFixture({ authOptions: { challengePeerLimit: 3, challengeGlobalLimit: 12 } }); t.after(() => f.close());
  const a = browser(f.base); await a.call('/session'); const original = a.csrf;
  assert.equal((await browser(f.base).call('/session')).status, 200); assert.equal((await browser(f.base).call('/session')).status, 200);
  const denied = await browser(f.base).call('/session'); assert.equal(denied.status, 429); assert.ok(Number(denied.headers.get('retry-after')) > 0);
  assert.equal((await a.call('/session')).data.csrfToken, original);
  const { port, directory } = f; await f.close(); f = await accountFixture({ port, directory, authOptions: { challengePeerLimit: 3, challengeGlobalLimit: 12 } });
  assert.equal((await browser(f.base).call('/session')).status, 429); assert.equal((await a.call('/session')).data.csrfToken, original);
  assert.equal((await rawRequest(f.base, '/api/account/session', {}, 'GET', [], '127.0.0.2')).status, 200);
  const db = new DatabaseSync(path.join(directory, 'accounts.sqlite'), { readOnly: true }); assert.equal(db.prepare('SELECT count(*) AS n FROM account_challenges').get().n, 4); db.close();
  const global = await accountFixture({ authOptions: { challengePeerLimit: 10, challengeGlobalLimit: 2 } }); t.after(() => global.close());
  assert.equal((await rawRequest(global.base, '/api/account/session', {}, 'GET', [], '127.0.0.1')).status, 200);
  assert.equal((await rawRequest(global.base, '/api/account/session', {}, 'GET', [], '127.0.0.2')).status, 200);
  assert.equal((await rawRequest(global.base, '/api/account/session', {}, 'GET', [], '127.0.0.3')).status, 429);
});

test('nonpassword text budgets match DOM and draft UTF16 limits while password counts code points', async t => {
  const f = await accountFixture(); t.after(() => f.close()); const a = browser(f.base); await a.call('/session');
  const expandingEmail = '\u0130'.repeat(76) + '@e.invalid'; assert.ok(expandingEmail.length <= 160); assert.equal(expandingEmail.toLowerCase().length, 162);
  assert.equal((await a.call('/signup', 'POST', { email: expandingEmail, password: fixturePassword })).status, 400);
  assert.equal((await a.call('/signup', 'POST', { email: 'astral@example.invalid', password: fixturePassword, name: '🧪'.repeat(51) })).status, 400);
  const accepted = await a.call('/signup', 'POST', { email: 'astral@example.invalid', password: '🧪'.repeat(15), name: '🧪'.repeat(50), company: '🧪'.repeat(80) }); assert.equal(accepted.status, 201); assert.equal(accepted.data.user.name.length, 100); assert.equal(accepted.data.user.company.length, 160);
  assert.equal((await a.call('/profile', 'PATCH', { company: '🧪'.repeat(81) })).status, 400); assert.equal((await a.call('/session')).data.user.company.length, 160);
});

function rawRequest(base, route, headers = {}, method = 'GET', chunks = [], localAddress) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = http.request({ hostname: url.hostname, port: url.port, path: route, method, headers, ...(localAddress ? { localAddress } : {}) }, response => { let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text, headers: response.headers })); });
    request.setTimeout(10000, () => request.destroy(new Error('Synthetic HTTP fixture timed out.')));
    request.on('error', reject);
    (async () => { for (const chunk of chunks) { request.write(chunk); await new Promise(resolve => setTimeout(resolve, 2)); } request.end(); })().catch(reject);
  });
}
