import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, cp, stat, chmod, realpath } from 'node:fs/promises';
import { randomUUID, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { googleFixture, hash, canonicalBrowser, googleConfig, signingKey } from './support/fake-google.mjs';
import { fixtureBase, fixturePassword } from './support/customer-account-fixture.mjs';
import { openAccountDatabase, accountSchemaDefinitions } from '../accounts/database.mjs';
import { createAccountAuth } from '../accounts/auth.mjs';
import { createGoogleFlows, parseGoogleCallback, googleBrowserCookie } from '../accounts/google-flows.mjs';
import { backupAccounts } from '../scripts/account-backup.mjs';
import { pathToFileURL } from 'node:url';
import { createAccountRequest } from '../dist/account-requests.js';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

test('Google creation uses flag-disabled reserved credentials, one-time codes, bound cookie and immutable linked profile', async t => {
  const f = await googleFixture(t), a = f.client(); const start = await f.start(a);
  const cookie = start.started.setCookies[0]; for (const part of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/api/account/oauth/google', 'Max-Age=600']) assert.ok(cookie.includes(part));
  const row = f.db.prepare('SELECT * FROM account_google_flows').get();
  assert.equal(row.status, 'started'); assert.equal(row.state_hash, hash('state\0' + start.state));
  assert.ok(!JSON.stringify(row).includes(start.code)); assert.ok(!JSON.stringify(row).includes(start.state));
  const strict = new Map(a.jar); for (const key of a.jar.keys()) if (!key.startsWith('an_google_flow_')) a.jar.delete(key);
  const callback = await f.callback(a, start); assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/google-signin'); assert.equal(callback.setCookies.length, 0);
  for (const [key, value] of strict) if (!key.startsWith('an_google_flow_')) a.jar.set(key, value);
  assert.deepEqual((await a.call('/oauth/google/status')).data, { ready: true, intent: 'login' });
  const completed = await a.call('/oauth/google/complete', 'POST', {}); assert.equal(completed.status, 200, completed.text); assert.equal(completed.data.recoveryCodes.length, 8);
  assert.equal(completed.data.user.passwordEnabled, false); assert.equal(completed.data.user.googleLinked, true); assert.equal(completed.data.user.emailVerified, true);
  const user = f.db.prepare('SELECT * FROM account_users').get(); assert.equal(user.password_salt.length, 32); assert.equal(user.password_hash.length, 64); assert.equal(user.password_enabled, 0);
  assert.equal((await a.call('/oauth/google/complete', 'POST', {})).status, 400); assert.equal(f.db.prepare('SELECT count(*) n FROM account_users').get().n, 1);
  await a.call('/logout', 'POST', {}); const again = await f.login(a, { email: 'changed102@gmail.com', name: 'Changed provider' });
  assert.equal(again.data.user.email, user.email); assert.equal(again.data.user.name, user.name); assert.equal(again.data.recoveryCodes, undefined);
});

test('third party Google email is unverified, email collisions never merge, explicit link/unlink requires password', async t => {
  const f = await googleFixture(t), a = f.client(); await a.signup();
  const b = f.client(), flow = await f.start(b, { email: 'fixture@example.invalid', subject: 'collision' }); await f.callback(b, flow);
  const collision = await b.call('/oauth/google/complete', 'POST', {}); assert.equal(collision.status, 409); assert.equal(f.db.prepare('SELECT count(*) n FROM account_identities').get().n, 0);
  assert.equal((await a.call('/oauth/google/link', 'POST', { currentPassword: 'Wrong but long password 102' })).status, 401);
  const link = await f.start(a, { subject: 'linked102', email: 'different@gmail.com' }, 'link', { currentPassword: fixturePassword }); await f.callback(a, link);
  const linked = await a.call('/oauth/google/complete', 'POST', {}); assert.equal(linked.status, 200, linked.text); assert.equal(linked.data.user.email, 'fixture@example.invalid'); assert.equal(linked.data.user.googleLinked, true);
  const unlinked = await a.call('/oauth/google/unlink', 'POST', { currentPassword: fixturePassword }); assert.equal(unlinked.status, 200); assert.equal(unlinked.data.user.googleLinked, false);
  const c = f.client(); const fresh = await f.login(c, { email: 'third102@example.invalid', subject: 'third102', hd: '' }); assert.equal(fresh.data.user.emailVerified, false);
  assert.equal((await c.call('/oauth/google/unlink', 'POST', { currentPassword: fixturePassword })).status, 401);
});

test('password flag overrides a known real hash, setup uses purpose grant, code recovery enables a password and preserves identity', async t => {
  const f = await googleFixture(t), a = f.client(); const registered = await a.signup();
  const known = f.db.prepare('SELECT password_salt,password_hash FROM account_users WHERE id=?').get(registered.data.user.id);
  const b = f.client(); const google = await f.login(b, { subject: 'disabled102', email: 'disabled102@gmail.com' });
  f.db.prepare('UPDATE account_users SET password_salt=?,password_hash=? WHERE id=?').run(known.password_salt, known.password_hash, google.data.user.id);
  const c = f.client(); await c.call('/session'); assert.equal((await c.call('/login', 'POST', { email: 'disabled102@gmail.com', password: fixturePassword })).status, 401);
  assert.equal((await b.call('/recovery-codes', 'POST', { currentPassword: fixturePassword })).status, 401);
  const setup = await b.call('/password/setup', 'POST', { newPassword: 'A new Google setup password 102' }); assert.equal(setup.status, 200, setup.text); assert.equal(setup.data.user.passwordEnabled, true);
  assert.equal((await b.call('/password/setup', 'POST', { newPassword: 'Another setup password 102' })).status, 400);
  const recovered = await c.call('/recover', 'POST', { email: 'disabled102@gmail.com', recoveryCode: google.data.recoveryCodes[0], newPassword: 'Recovered Google password 102' }); assert.equal(recovered.status, 200, recovered.text);
  assert.equal((await b.call('/session')).data.authenticated, false); assert.equal(f.db.prepare('SELECT count(*) n FROM account_identities WHERE user_id=?').get(google.data.user.id).n, 1);
});

test('callback parser/cookies reject duplicates, encoding, paths and unrelated callback cannot clear a valid browser flow', async t => {
  for (const raw of ['?state=' + 'a'.repeat(64) + '&code=x&code=y', '?%73tate=' + 'a'.repeat(64) + '&code=x', '?state=' + 'a'.repeat(64) + '&code=%00', '?state=' + 'a'.repeat(64) + '&code=x&error=denied']) assert.throws(() => parseGoogleCallback('/api/account/oauth/google/callback' + raw));
  assert.throws(() => googleBrowserCookie('an_google_flow_1=' + 'A'.repeat(43) + '; an_google_flow_1=' + 'A'.repeat(43), 1));
  const f = await googleFixture(t), a = f.client(), flow = await f.start(a);
  const bad = await a.call('/oauth/google/callback?state=' + 'b'.repeat(64) + '&code=wrong'); assert.equal(bad.status, 303); assert.equal(bad.setCookies.length, 0); assert.equal(f.provider.exchanges, 0);
  for (const route of ['/oauth/google/%63allback?state=x', '/oauth/google//callback?state=x', '/oauth/google/callback/../callback?state=x', '/oauth/google/status?x=y']) assert.ok((await a.call(route)).status >= 400);
  assert.ok((await a.call('/oauth/google/callback?state=' + flow.state + '&code=' + flow.code, 'POST', {})).status >= 400);
  assert.equal((await f.callback(a, flow)).status, 303); assert.equal(f.provider.exchanges, 1);
});

test('one callback wins, origin/CSRF remain strict, denial/expired/changed-owner flows never complete', async t => {
  const f = await googleFixture(t), a = f.client(), flow = await f.start(a);
  const results = await Promise.all([f.callback(a, flow), f.callback(a, flow)]); assert.deepEqual(results.map(r => r.status), [303, 303]); assert.equal(f.provider.exchanges, 1);
  assert.equal((await a.call('/oauth/google/complete', 'POST', {}, { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await a.call('/oauth/google/complete', 'POST', {}, { headers: { 'X-Account-CSRF': 'a'.repeat(64) } })).status, 403);
  const own = await a.signup('owner102@example.invalid'); assert.equal(own.status, 201); assert.equal((await a.call('/oauth/google/complete', 'POST', {})).status, 400);
  const b = f.client(), denied = await f.start(b); const denial = await b.call('/oauth/google/callback?state=' + denied.state + '&error=access_denied'); assert.equal(denial.status, 303); assert.ok(denial.setCookies[0].includes('Max-Age=0'));
  const expired = await f.start(b); f.advance(600001); assert.equal((await f.callback(b, expired)).status, 303); assert.deepEqual((await b.call('/oauth/google/status')).data, { ready: false, intent: null });
});

async function twoSessions(f) { const a = f.client(), first = await f.login(a), b = f.client(); await f.login(b); return { a, b, id: first.data.user.id }; }
const grants = (f, id) => f.db.prepare('SELECT google_reauth_at,google_reauth_purpose FROM account_sessions WHERE user_id=?').all(id);
test('Google recovery regeneration clears both grants on every surviving session and invalidates in-flight and ready recovery epochs', async t => {
  const f = await googleFixture(t), { a, b, id } = await twoSessions(f);
  f.db.prepare("UPDATE account_sessions SET google_reauth_at=?,google_reauth_purpose='recovery_codes' WHERE user_id=?").run(f.now, id);
  const hold = f.provider.hold(); let began; const waiting = new Promise(resolve => { began = resolve; }); f.provider.onExchange = began;
  const flow = await f.start(b, {}, 'reauth', { purpose: 'password_setup' }), pending = f.callback(b, flow); await waiting;
  const before = f.db.prepare('SELECT recovery_version FROM account_users WHERE id=?').get(id).recovery_version;
  const regenerated = await a.call('/oauth/google/recovery-codes', 'POST', {}); assert.equal(regenerated.status, 200, regenerated.text); hold.release(); await pending;
  assert.equal(f.db.prepare('SELECT recovery_version FROM account_users WHERE id=?').get(id).recovery_version, before + 1);
  for (const grant of grants(f, id)) assert.deepEqual({ ...grant }, { google_reauth_at: null, google_reauth_purpose: null });
  assert.equal((await a.call('/session')).data.authenticated, true); assert.equal((await b.call('/session')).data.authenticated, true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM account_google_flows').get().n, 0);
  assert.equal((await b.call('/password/setup', 'POST', { newPassword: fixturePassword })).status, 400);
  const ready = await f.start(b, {}, 'reauth', { purpose: 'recovery_codes' }); await f.callback(b, ready);
  f.db.prepare("UPDATE account_sessions SET google_reauth_at=?,google_reauth_purpose='recovery_codes' WHERE token_hash=?").run(f.now, hash(a.jar.get('an_customer_' + f.port)));
  assert.equal((await a.call('/oauth/google/recovery-codes', 'POST', {})).status, 200); assert.equal((await b.call('/oauth/google/complete', 'POST', {})).status, 400);
  const fresh = await f.start(b, {}, 'reauth', { purpose: 'password_setup' }); await f.callback(b, fresh); assert.equal((await b.call('/oauth/google/complete', 'POST', {})).status, 200); assert.equal((await b.call('/password/setup', 'POST', { newPassword: fixturePassword })).status, 200);
});

test('password regeneration clears all surviving grants; disabled-provider invalidation is local and rolls back atomically', async t => {
  const f = await googleFixture(t), a = f.client(); const signup = await a.signup(); const b = f.client(); await b.call('/session'); await b.call('/login', 'POST', { email: signup.data.user.email, password: fixturePassword }); const id = signup.data.user.id;
  f.db.prepare("UPDATE account_sessions SET google_reauth_at=?,google_reauth_purpose='password_setup' WHERE user_id=?").run(f.now, id);
  assert.equal((await a.call('/recovery-codes', 'POST', { currentPassword: fixturePassword })).status, 200);
  for (const grant of grants(f, id)) assert.equal(grant.google_reauth_at, null);
  assert.equal((await b.call('/session')).data.authenticated, true);
  const directory = path.join(fixtureBase, randomUUID()), db = await openAccountDatabase({ directory }); t.after(() => db.close());
  const auth = createAccountAuth({ db }), google = createGoogleFlows({ db, auth, config: { enabled: false }, rate() { throw Error('No rate call expected.'); } });
  db.run("INSERT INTO account_users(id,email,name,company,password_salt,password_hash,security_version,recovery_version,created_at,updated_at,email_verified_at,password_enabled) VALUES(?,?,'','',?,?,1,1,1,1,NULL,1)", 'a'.repeat(32), 'local102@example.invalid', 'b'.repeat(32), 'c'.repeat(64));
  db.run("INSERT INTO account_sessions VALUES(?,?,?,1,1,1,9999999999999,'password',1,'password_setup')", 'd'.repeat(64), 'a'.repeat(32), 'e'.repeat(64));
  assert.throws(() => db.transaction(() => { db.run('UPDATE account_users SET recovery_version=2'); google.invalidateUser('a'.repeat(32)); throw Error('Synthetic transaction fault'); }));
  assert.equal(db.get('SELECT recovery_version FROM account_users').recovery_version, 1); assert.equal(db.get('SELECT google_reauth_at FROM account_sessions').google_reauth_at, 1);
  db.transaction(() => { db.run('UPDATE account_users SET recovery_version=2'); google.invalidateUser('a'.repeat(32)); }); assert.equal(db.get('SELECT google_reauth_at FROM account_sessions').google_reauth_at, null); assert.equal(db.get('SELECT google_reauth_purpose FROM account_sessions').google_reauth_purpose, null); await google.close();
});

test('fresh schema3 and additive schema2 migration have identical shapes and preserve all original source bytes', async t => {
  const definitions = await accountSchemaDefinitions(), schema2 = await readFile(new URL('../accounts/schema-v2.sql', import.meta.url), 'utf8');
  assert.match(schema2, /user_version=2/); assert.doesNotMatch(schema2, /password_enabled|account_identities/);
  const directory = path.join(fixtureBase, randomUUID()); await mkdir(directory, { recursive: true }); const raw = new DatabaseSync(path.join(directory, 'accounts.sqlite')); raw.exec(schema2);
  raw.prepare("INSERT INTO account_users VALUES(?,?,'Name','Company',?,?,1,1,1,1,NULL)").run('a'.repeat(32), 'migrate102@example.invalid', 'b'.repeat(32), 'c'.repeat(64)); raw.close();
  const db = await openAccountDatabase({ directory }); t.after(() => db.close()); assert.equal(db.get('PRAGMA user_version').user_version, 3); assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1); const user = db.get('SELECT * FROM account_users'); assert.equal(user.password_salt, 'b'.repeat(32)); assert.equal(user.password_hash, 'c'.repeat(64)); assert.equal(user.password_enabled, 1); assert.ok(definitions.shapes[1] && definitions.shapes[2] && definitions.shapes[3]);
});

test('schema2 native backup retains version2; additive migration faults roll back every DDL stage including version', async t => {
  const schema2 = await readFile(new URL('../accounts/schema-v2.sql', import.meta.url), 'utf8'), migration = await readFile(new URL('../accounts/migrate-2-to-3.sql', import.meta.url), 'utf8');
  for (const version of [1,2]) for (const marker of ['ALTER TABLE account_sessions', 'CREATE TABLE account_identities', 'CREATE TABLE account_google_flows', 'CREATE INDEX account_google_flows_expiry', 'PRAGMA user_version=3;']) {
    const root = path.join(fixtureBase, randomUUID()), directory = path.join(root, 'store'), modules = path.join(root, 'modules'); await mkdir(directory, { recursive: true }); await mkdir(modules);
    const raw = new DatabaseSync(path.join(directory, 'accounts.sqlite')); const initial=version===2?schema2:schema2.split('-- Transactional mail tables')[0].replace(/,\s*email_verified_at INTEGER CHECK\(email_verified_at IS NULL OR email_verified_at>0\)/,'').replace(/,\s*notification_revision INTEGER CHECK\(notification_revision IS NULL OR notification_revision>0\)/,'')+'; PRAGMA user_version=1;';raw.exec(initial);raw.prepare("INSERT INTO account_users VALUES(?,?,'Name','Company',?,?,1,1,1,1"+(version===2?',NULL':'')+")").run('a'.repeat(32),'fault102@example.invalid','b'.repeat(32),'c'.repeat(64));raw.close();
    const backup = path.join(root, 'backup.sqlite'); assert.deepEqual(await backupAccounts({ directory, output: backup }), { ok: true, schemaVersion: version }); const saved = new DatabaseSync(backup, { readOnly: true }); assert.equal(saved.prepare('PRAGMA user_version').get().user_version, version); saved.close();
    for (const file of ['database.mjs', 'schema.sql', 'schema-v2.sql', 'migrate-1-to-2.sql']) await cp(new URL('../accounts/' + file, import.meta.url), path.join(modules, file));
    const offset = migration.indexOf(marker); assert.ok(offset >= 0); const end = marker.startsWith('PRAGMA') ? offset + marker.length : offset;
    await writeFile(path.join(modules, 'migrate-2-to-3.sql'), migration.slice(0, end) + '\nSELECT missing_column FROM synthetic_missing_table;\n');
    const { openAccountDatabase: broken } = await import(pathToFileURL(path.join(modules, 'database.mjs')).href); await assert.rejects(broken({ directory }), /unavailable/);
    const check = new DatabaseSync(path.join(directory, 'accounts.sqlite'), { readOnly: true }); assert.equal(check.prepare('PRAGMA user_version').get().user_version, version); assert.equal(check.prepare('PRAGMA table_info(account_users)').all().some(r => r.name === 'password_enabled'), false); assert.equal(check.prepare('SELECT password_hash FROM account_users').get().password_hash, 'c'.repeat(64)); assert.equal(check.prepare("SELECT count(*) n FROM sqlite_master WHERE name='account_identities'").get().n, 0); check.close();
  }
});

test('schema2 to3 preserves every synthetic preexisting table row, raw request and encrypted mail bytes', async t => {
  const schema = await readFile(new URL('../accounts/schema-v2.sql', import.meta.url), 'utf8'), directory = path.join(fixtureBase, randomUUID()); await mkdir(directory, { recursive: true });
  const raw = new DatabaseSync(path.join(directory, 'accounts.sqlite')); raw.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;'); raw.exec(schema);
  const id = 'a'.repeat(32); raw.prepare("INSERT INTO account_users VALUES(?,?,'Name','Company',?,?,1,1,1,1,1)").run(id, 'preserve102@example.invalid', 'b'.repeat(32), 'c'.repeat(64)); raw.prepare('INSERT INTO account_sessions VALUES(?,?,?,1,1,1,9999999999999)').run('d'.repeat(64), id, 'e'.repeat(64)); raw.prepare('INSERT INTO account_challenges VALUES(?,9999999999999)').run('f'.repeat(64)); raw.prepare('INSERT INTO account_recovery_codes VALUES(?,?)').run(id, '1'.repeat(64)); raw.prepare('INSERT INTO account_rates VALUES(?,1,1,1)').run('2'.repeat(64));
  const db2 = { get: (sql, ...v) => raw.prepare(sql).get(...v), all: (sql, ...v) => raw.prepare(sql).all(...v), run: (sql, ...v) => raw.prepare(sql).run(...v), exec: sql => raw.exec(sql), transaction(fn) { raw.exec('BEGIN IMMEDIATE'); try { const result = fn(); raw.exec('COMMIT'); return result; } catch (e) { raw.exec('ROLLBACK'); throw e; } } };
  const { createMailOutbox } = await import('../accounts/mail-outbox.mjs'), { createAccountRequests } = await import('../accounts/requests.mjs');
  const config = { enabled: true, reportNoticesEnabled: false, publicOrigin: 'https://assaynovalabs.com', key: randomBytes(32), smtp: { host: 'mail102.invalid', port: 587, username: 'supports@example.invalid', from: 'supports@example.invalid', supportTo: 'supports@example.invalid', password: 'synthetic only' } }, mail = createMailOutbox({ db: db2, config, clock: () => Date.parse('2026-11-08T00:00:00Z') });
  const request = createAccountRequest('contact', { name: 'Synthetic preservation', email: 'preserve102@example.invalid', topic: 'other', message: 'Exact synthetic bytes' }, { id: 'AN-REQ-PRESERVE102', createdAt: '2026-11-08T00:00:00.000Z' });
  const saved = createAccountRequests({ db: db2, mail }).create(db2.get('SELECT * FROM account_users'), { record: request, idempotencyKey: 'preserve102-unique-request-key' }); assert.equal(saved.status, 201);
  raw.prepare("INSERT INTO account_mail_tokens VALUES(?,?,'verify_email',?,1,1,1,9999999999999,NULL)").run('3'.repeat(64), id, '4'.repeat(64)); db2.transaction(() => mail.rate([['oauth-preservation', 'synthetic', 10, 600000]]));
  const before = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => { const columns = raw.prepare('PRAGMA table_info(' + name + ')').all().map(r => r.name); return { name, columns, rows: raw.prepare('SELECT ' + columns.join(',') + ' FROM ' + name + ' ORDER BY 1').all() }; });
  assert.ok(before.every(table => table.rows.length > 0)); const ciphertext = db2.all('SELECT ciphertext,nonce,tag FROM account_mail_outbox ORDER BY event_key'); assert.equal(ciphertext.length, 2); raw.close();
  const db = await openAccountDatabase({ directory }); t.after(() => db.close());
  for (const table of before) assert.deepEqual(db.all('SELECT ' + table.columns.join(',') + ' FROM ' + table.name + ' ORDER BY 1'), table.rows, table.name);
  assert.deepEqual(db.all('SELECT ciphertext,nonce,tag FROM account_mail_outbox ORDER BY event_key'), ciphertext); assert.equal(db.get('SELECT password_enabled FROM account_users').password_enabled, 1); assert.deepEqual({ ...db.get('SELECT auth_method,google_reauth_at,google_reauth_purpose FROM account_sessions') }, { auth_method: 'password', google_reauth_at: null, google_reauth_purpose: null }); assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1); assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
});

test('ready resolved login cannot survive code regeneration and wrong/expired reauth purposes cannot perform setup', async t => {
  const f = await googleFixture(t), { a, b } = await twoSessions(f), c = f.client();
  const login = await f.start(c); await f.callback(c, login); assert.equal((await c.call('/oauth/google/status')).data.ready, true);
  const proof = await f.start(a, {}, 'reauth', { purpose: 'recovery_codes' }); await f.callback(a, proof); assert.equal((await a.call('/oauth/google/complete', 'POST', {})).status, 200);
  assert.equal((await a.call('/password/setup', 'POST', { newPassword: fixturePassword })).status, 400); assert.equal((await a.call('/oauth/google/recovery-codes', 'POST', {})).status, 200);
  assert.equal((await c.call('/oauth/google/complete', 'POST', {})).status, 400);
  const expired = await f.start(b, {}, 'reauth', { purpose: 'password_setup' }); await f.callback(b, expired); await b.call('/oauth/google/complete', 'POST', {}); f.advance(300001); assert.equal((await b.call('/password/setup', 'POST', { newPassword: fixturePassword })).status, 400);
});

test('bounded start rates and source-session logout cannot promote or recreate a ready flow', async t => {
  const f = await googleFixture(t), a = f.client(); await f.login(a); const flow = await f.start(a, {}, 'reauth', { purpose: 'password_setup' }); await a.call('/logout', 'POST', {}); await f.callback(a, flow); assert.equal(f.db.prepare('SELECT count(*) n FROM account_google_flows').get().n, 0);
  const b = f.client(); await b.call('/session'); for (let index = 0; index < 8; index++) assert.equal((await b.call('/oauth/google/start', 'POST', { next: '/account' })).status, 200); assert.equal((await b.call('/oauth/google/start', 'POST', { next: '/account' })).status, 429); assert.equal(f.db.prepare('SELECT count(*) n FROM account_google_flows').get().n, 1);
});

test('failed provider exchange consumes only its bound flow and returns no provider response text', async t => {
  const f = await googleFixture(t), a = f.client(), flow = await f.start(a); flow.code = 'unknown-synthetic-code';
  const callback = await f.callback(a, flow); assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/google-signin'); assert.equal(callback.text, ''); assert.ok(callback.setCookies[0].includes('Max-Age=0')); assert.equal(f.db.prepare('SELECT count(*) n FROM account_google_flows').get().n, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM account_users').get().n, 0);
});

test('Google-only verified-mail reset enables password and atomically invalidates sessions, codes and Google actions', async t => {
  const messages = [], config = { enabled: true, reportNoticesEnabled: false, publicOrigin: 'https://assaynovalabs.com', key: randomBytes(32), smtp: { host: 'mail102.invalid', port: 587, username: 'supports@example.invalid', from: 'supports@example.invalid', supportTo: 'supports@example.invalid', password: 'synthetic only' } };
  const f = await googleFixture(t, { mailOptions: { config, transport: { async send(payload) { messages.push(payload); return { outcome: 'accepted' }; } } } }), a = f.client(); const initial = await f.login(a), b = f.client(); await b.call('/session');
  const flow = await f.start(a, {}, 'reauth', { purpose: 'recovery_codes' }); await f.callback(a, flow);
  assert.equal((await b.call('/password/reset-request', 'POST', { email: initial.data.user.email })).status, 202); await f.handler.pumpMail(); const token = /#token=([a-f0-9]{64})/.exec(messages.at(-1).body)[1];
  const reset = await b.call('/password/reset', 'POST', { token, newPassword: fixturePassword }); assert.equal(reset.status, 200, reset.text); assert.equal(reset.data.recoveryCodes.length, 8); assert.notDeepEqual(reset.data.recoveryCodes, initial.data.recoveryCodes);
  assert.equal((await a.call('/session')).data.authenticated, false); assert.equal((await b.call('/session')).data.authenticated, false); assert.equal(f.db.prepare('SELECT password_enabled FROM account_users').get().password_enabled, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM account_identities').get().n, 1); assert.equal(f.db.prepare('SELECT count(*) n FROM account_google_flows').get().n, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM account_mail_tokens').get().n, 0);
});

test('post-KDF Google linking cannot use a replaced originating session or changed password state', async t => {
  const real = promisify(scrypt); let hold = false, entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), derive = async (...args) => { if (hold) { hold = false; entered(); await new Promise(resolve => { release = resolve; }); } return real(...args); };
  const f = await googleFixture(t, { authOptions: { derive } }), a = f.client(); await a.signup();
  hold = true; const pending = a.call('/oauth/google/link', 'POST', { currentPassword: fixturePassword }); await waiting; await a.call('/logout-all', 'POST', {}); release(); assert.ok((await pending).status >= 400); assert.equal(f.db.prepare('SELECT count(*) n FROM account_google_flows').get().n, 0); assert.equal(f.db.prepare('SELECT count(*) n FROM account_identities').get().n, 0);
});

test('staged source package exercises Google completion, request/mail behavior and restart persistence without operational inputs', async t => {
  const release = path.join(fixtureBase, randomUUID(), 'release'); await mkdir(release, { recursive: true });
  for (const name of ['accounts', 'dist/customer-account.js', 'dist/account-requests.js', 'dist/submission.js', 'dist/data.js', 'dist/contact.js', 'dist/support.js', 'dist/account-google.js', 'dist/account-page.js', 'dist/account-mail.js', 'dist/routes.js', 'dist/index.html', 'dist/account.css', 'dist/styles.css', 'dist/assets/google-signin-light.png', 'dist/assets/google-signin-PROVENANCE.md']) {
    const target = path.join(release, name); await mkdir(path.dirname(target), { recursive: true }); await cp(new URL('../' + name, import.meta.url), target, { recursive: true });
  }
  const { createAccountHandler: factory } = await import(pathToFileURL(path.join(release, 'accounts/handler.mjs')).href);
  const key = (await import('node:crypto')).randomBytes(32), delivered = [];
  const config = { enabled: true, reportNoticesEnabled: false, publicOrigin: 'https://assaynovalabs.com', key, smtp: { host: 'mail102.invalid', port: 587, username: 'supports@example.invalid', from: 'supports@example.invalid', supportTo: 'supports@example.invalid', password: 'synthetic only' } };
  const mailOptions = { config, transport: { async send(payload, { beforeData }) { if (!await beforeData()) return { outcome: 'canceled' }; delivered.push(payload); return { outcome: 'accepted' }; } } };
  const f = await googleFixture(t, { factory, mailOptions }), a = f.client(); const created = await f.login(a);
  const record = createAccountRequest('contact', { name: 'Stage', email: created.data.user.email, topic: 'testing', message: 'Synthetic staged request' }, { id: 'AN-REQ-STAGE102', createdAt: '2026-11-08T00:00:00.000Z' });
  const saved = await a.call('/requests', 'POST', { record, idempotencyKey: 'stage102-contact-request-key' }); assert.equal(saved.status, 201); assert.equal(saved.data.request.notifications.receipt, 'queued'); await f.handler.pumpMail(); await f.handler.pumpMail(); assert.equal(delivered.length, 2);
  const id = created.data.user.id; await f.close(); const restarted = await googleFixture(t, { factory, mailOptions, directory: f.directory }), b = restarted.client(); const existing = await restarted.login(b); assert.equal(existing.data.user.id, id); assert.equal(existing.data.recoveryCodes, undefined); assert.equal((await b.call('/requests')).data.requests[0].record.id, record.id);
  for (const file of ['accounts/schema-v2.sql', 'accounts/migrate-1-to-2.sql', 'accounts/migrate-2-to-3.sql', 'dist/assets/google-signin-light.png']) assert.ok((await stat(path.join(release, file))).isFile());
});

test('actual staged server enables synthetic Google and actual client/controller automatic signup, reauth, link and password fallback', async t => {
  const parent = path.join(fixtureBase, randomUUID()), release = path.join(parent, 'release'), privateDirectory = path.join(parent, 'private');
  await mkdir(release, { recursive: true }); await mkdir(privateDirectory, { mode: 0o700 }); await chmod(privateDirectory, 0o700);
  for (const name of ['server.mjs', 'report-pdf.mjs', 'package.json', 'accounts', 'conference/reader.mjs', 'conference/admin-proxy.mjs', 'conference/import-limits.mjs', 'dist/customer-account.js', 'dist/account-requests.js', 'dist/submission.js', 'dist/data.js', 'dist/contact.js', 'dist/support.js', 'dist/account-google.js', 'dist/account-page.js', 'dist/account-mail.js', 'dist/routes.js', 'dist/index.html', 'dist/account.css', 'dist/styles.css', 'dist/assets/google-signin-light.png']) {
    const target = path.join(release, name); await mkdir(path.dirname(target), { recursive: true }); await cp(new URL('../' + name, import.meta.url), target, { recursive: true });
  }
  const key = signingKey('staged-runtime102'), keyFile = path.join(privateDirectory, 'synthetic-signing-key.json'), clientFile = path.join(privateDirectory, 'synthetic-web-client.json'), configFile = path.join(privateDirectory, 'synthetic-google-config.json'), bootstrap = path.join(privateDirectory, 'synthetic-fetch-bootstrap.mjs');
  await writeFile(keyFile, JSON.stringify({ privateJwk: key.privateKey.export({ format: 'jwk' }), publicJwk: key.jwk }), { mode: 0o600 });
  await writeFile(clientFile, JSON.stringify({ web: { client_id: googleConfig.clientId, client_secret: googleConfig.clientSecret, redirect_uris: ['https://assaynovalabs.com/api/account/oauth/google/callback'] } }), { mode: 0o600 });
  await writeFile(configFile, JSON.stringify({ version: 1, enabled: true, publicOrigin: 'https://assaynovalabs.com', clientFile }), { mode: 0o600 });
  // A disposable process-only preload injects synthetic outbound fetch before
  // the unchanged actual server entry runs. It never falls back to networking.
  await writeFile(bootstrap, `import {readFileSync} from 'node:fs';
import {createPrivateKey,createHash,sign} from 'node:crypto';
const keys=JSON.parse(readFileSync(${JSON.stringify(keyFile)},'utf8'));
const key=createPrivateKey({key:keys.privateJwk,format:'jwk'});
globalThis.fetch=async(url,options)=>{
 if(url==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[keys.publicJwk]},{headers:{'Cache-Control':'max-age=300'}});
 if(url!=='https://oauth2.googleapis.com/token')throw Error('Synthetic stage denied unexpected outbound request.');
 const form=new URLSearchParams(options.body),data=JSON.parse(Buffer.from(form.get('code'),'base64url').toString('utf8'));
 if(form.get('redirect_uri')!=='https://assaynovalabs.com/api/account/oauth/google/callback'||form.get('client_id')!==${JSON.stringify(googleConfig.clientId)}||form.get('client_secret')!==${JSON.stringify(googleConfig.clientSecret)}||createHash('sha256').update(form.get('code_verifier')).digest('base64url')!==data.challenge)throw Error('Synthetic stage rejected exchange.');
 const now=Math.floor(Date.now()/1000),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),head=encode({alg:'RS256',kid:keys.publicJwk.kid,typ:'JWT'}),body=encode({iss:'https://accounts.google.com',aud:form.get('client_id'),sub:data.subject,email:data.email,email_verified:true,name:'Synthetic staged account',nonce:data.nonce,iat:now,exp:now+3600}),content=head+'.'+body;
 return Response.json({id_token:content+'.'+sign('RSA-SHA256',Buffer.from(content),key).toString('base64url')});
};
`, { mode: 0o600 });
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const store = path.join(parent, 'accounts'), child = spawn(process.execPath, ['--import', pathToFileURL(bootstrap).href, path.join(release, 'server.mjs'), '--port=' + port, '--host=127.0.0.1', '--account-origin=https://assaynovalabs.com', '--account-store=' + store], { cwd: release, windowsHide: true, env: { NODE_ENV: 'test', ASSAYNOVA_CATALOG_QA: '0', PYTHONDONTWRITEBYTECODE: '1', ASSAYNOVA_GOOGLE_CONFIG_FILE: configFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', stopped = false;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { if (stopped || child.exitCode !== null || child.signalCode !== null) return; stopped = true; const done = once(child, 'close'); child.kill(); await done; });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Synthetic staged Google server startup timed out.')), 10000); child.stdout.on('data', () => { if (output.includes('AssayNova ready')) { clearTimeout(timer); resolve(); } }); child.once('close', () => { clearTimeout(timer); if (!output.includes('AssayNova ready')) reject(Error(errors || 'Synthetic staged server failed.')); }); });
  const publicRequest = (route, method = 'GET') => new Promise((resolve, reject) => { const request = http.request({ hostname: '127.0.0.1', port, path: route, method }, response => { let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text, headers: response.headers })); }); request.on('error', reject); request.end(); });
  for (const method of ['GET', 'HEAD']) { const privacy = await publicRequest('/privacy-policy', method); assert.equal(privacy.status, 200); assert.equal(privacy.headers['set-cookie'], undefined); assert.equal(method === 'GET' ? privacy.text.includes('Privacy policy') : privacy.text === '', true); }
  assert.equal((await publicRequest('/google-signin')).status, 200); assert.equal((await publicRequest('/assets/google-signin-light.png')).status, 200); assert.equal((await publicRequest('/__dev/client.js')).status, 404);
  const { createCustomerAccountClient } = await import(pathToFileURL(path.join(release, 'dist/customer-account.js')).href), { createGoogleAccountController } = await import(pathToFileURL(path.join(release, 'dist/account-google.js')).href);
  const transport = canonicalBrowser(port), requests = [], completions = [], states = [], navigations = [];
  const client = createCustomerAccountClient({ fetcher: async (url, options) => { requests.push(url); const result = await transport.call(url.slice('/api/account'.length), options.method, undefined, { headers: options.headers, ...(options.body === undefined ? {} : { raw: options.body }) }); return { ok: result.status < 400, status: result.status, headers: result.headers, json: async () => result.data }; } });
  const controller = createGoogleAccountController({ client, navigateExternal: url => navigations.push(url), onComplete: result => completions.push(result), onState: (...args) => states.push(args) });
  async function roundTrip(intent, value, subject, email) {
    await controller.begin(intent, value); const auth = new URL(navigations.at(-1));
    const code = Buffer.from(JSON.stringify({ subject, email, nonce: auth.searchParams.get('nonce'), challenge: auth.searchParams.get('code_challenge') })).toString('base64url');
    const callback = await transport.call('/oauth/google/callback?' + new URLSearchParams({ state: auth.searchParams.get('state'), code }), 'GET', undefined, { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site' } }); assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), '/google-signin');
    const before = requests.filter(url => url.endsWith('/complete')).length, count = completions.length;
    await controller.enter(); assert.equal(completions.length, count + 1, states.at(-1)?.[1]?.code); assert.equal(requests.filter(url => url.endsWith('/complete')).length, before + 1); assert.ok(requests.at(-1).endsWith('/session')); await controller.enter(); assert.equal(requests.filter(url => url.endsWith('/complete')).length, before + 1);
    return completions.at(-1);
  }
  await client.getSession(); assert.equal(client.snapshot().google.enabled, true);
  const created = await roundTrip('login', '/account', 'staged-native-subject102', 'staged-native102@gmail.com'); assert.equal(created.recoveryCodes.length, 8); assert.equal(created.user.passwordEnabled, false); const ownerId = created.user.id;
  await roundTrip('reauth', 'recovery_codes', 'staged-native-subject102', created.user.email); assert.equal((await client.googleRecoveryCodes()).recoveryCodes.length, 8);
  await roundTrip('reauth', 'password_setup', 'staged-native-subject102', created.user.email); assert.equal((await client.setupPassword(fixturePassword)).passwordEnabled, true); await client.logout(); await client.login({ email: created.user.email, password: fixturePassword }); assert.equal(client.snapshot().user.id, ownerId);
  const record = createAccountRequest('contact', { name: 'Native stage', email: created.user.email, topic: 'testing', message: 'Actual staged runtime request' }, { id: 'AN-REQ-NATIVE-STAGE102', createdAt: '2026-11-08T00:00:00.000Z' }); const saved = await client.saveRequest(record, { ownerId, idempotencyKey: 'native-stage102-request-key' }); assert.equal(saved.record.id, record.id); await client.logout();
  const passwordAccount = await client.signup({ email: 'staged-link102@example.invalid', password: fixturePassword, name: 'Password account', company: 'Synthetic' }); const linked = await roundTrip('link', fixturePassword, 'staged-link-subject102', 'different-google102@gmail.com'); assert.equal(linked.user.id, passwordAccount.user.id); assert.equal(linked.user.email, passwordAccount.user.email); assert.equal(linked.user.emailVerified, false); assert.equal(linked.user.googleLinked, true); assert.equal(linked.recoveryCodes, undefined);
  assert.equal(await realpath(path.join(release, 'server.mjs')), path.join(await realpath(release), 'server.mjs')); assert.doesNotMatch(output + errors, /client_secret|SYNTHETICPRIVATE|id_token/);
});
