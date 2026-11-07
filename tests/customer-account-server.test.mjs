import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { accountFixture, browser, fixtureBase } from './support/customer-account-fixture.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
async function freePort() { const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port; }
async function fixtureSource() {
  const root = path.join(fixtureBase, randomUUID()); await mkdir(root, { recursive: true });
  for (const file of ['server.mjs', 'report-pdf.mjs', 'package.json', 'accounts', 'dist/data.js', 'dist/routes.js', 'dist/index.html', 'dist/submission.js', 'conference/reader.mjs', 'conference/admin-proxy.mjs', 'conference/import-limits.mjs']) {
    const destination = path.join(root, file); await mkdir(path.dirname(destination), { recursive: true }); await cp(path.join(project, file), destination, { recursive: true });
  }
  return root;
}
async function start(root, args = [], environment = {}) {
  const port = await freePort(), child = spawn(process.execPath, [path.join(root, 'server.mjs'), '--port=' + port, ...args], { cwd: root, env: { NODE_ENV: 'test', ...environment }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-8192); }); child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-8192); });
  const ready = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Synthetic server startup timed out.')), 10000); const check = () => { if (output.includes('AssayNova ready')) { clearTimeout(timer); resolve(); } }; child.stdout.on('data', check); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', () => { clearTimeout(timer); if (!output.includes('AssayNova ready')) reject(new Error(errors || 'Synthetic server exited before readiness.')); }); });
  const stop = async () => { if (child.exitCode !== null || child.signalCode !== null) return; const closed = once(child, 'close'); child.kill(); await closed; };
  try { await ready; } catch (error) { await stop(); throw error; }
  return { port, base: 'http://127.0.0.1:' + port, child, stop };
}

test('actual default server dispatches customer mutations before GET-only guard and keeps account files private', async t => {
  const root = await fixtureSource(), server = await start(root); t.after(() => server.stop());
  const html = await (await fetch(server.base)).text(); assert.match(html, /name="assaynova-accounts" content="enabled"/);
  const user = browser(server.base); assert.equal((await user.signup()).status, 201); assert.equal((await user.call('/session')).data.authenticated, true);
  for (const route of ['/work/customer-accounts/accounts.sqlite', '/accounts/auth.mjs', '/accounts/schema.sql']) assert.equal((await fetch(server.base + route)).status, 404);
  assert.equal((await fetch(server.base + '/api/%61ccount/session')).status, 400);
  for (const route of ['/api/%61ccount/%2e%2e/verify', '/api/%61ccount/../verify']) assert.equal((await raw(server.base, route, {})).status, 400);
  assert.ok((await stat(path.join(root, 'work/customer-accounts/accounts.sqlite'))).isFile());
  assert.equal((await fetch(server.base + '/verify')).status, 200);
});

test('actual explicit static opt-out closes all account methods and production does not assume an insecure origin', async t => {
  const root = await fixtureSource(), server = await start(root, ['--no-accounts'], { NODE_ENV: 'production' }); t.after(() => server.stop());
  assert.doesNotMatch(await (await fetch(server.base)).text(), /name="assaynova-accounts" content="enabled"/);
  for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS']) assert.equal((await fetch(server.base + '/api/account/session', { method })).status, 404);
  await assert.rejects(start(await fixtureSource(), [], { NODE_ENV: 'production' }), /HTTPS/);
  const secure = await start(await fixtureSource(), ['--account-origin=https://accounts.example.invalid'], { NODE_ENV: 'production' }); t.after(() => secure.stop());
  const session = await raw(secure.base, '/api/account/session', { Host: 'accounts.example.invalid' }); assert.equal(session.status, 200); for (const cookie of session.headers['set-cookie']) assert.match(cookie, /; Secure/);
});

test('actual LAN server derives a separate account proxy and never opens an account database', async t => {
  const primary = await accountFixture(); t.after(() => primary.close()); const root = await fixtureSource(), port = await freePort();
  // start() adds its own port first; reserve the final value explicitly so the
  // external origin is exactly the selected listener and never an arbitrary URL.
  const child = spawn(process.execPath, [path.join(root, 'server.mjs'), '--host=0.0.0.0', '--port=' + port, '--conference-reports', '--admin-proxy=' + primary.base, '--admin-proxy-origin=http://192.168.0.60:' + port], { cwd: root, env: { NODE_ENV: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', error = ''; child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { error += value; });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Synthetic proxy startup timed out.')), 10000); child.stdout.on('data', () => { if (log.includes('AssayNova ready')) { clearTimeout(timer); resolve(); } }); child.once('close', () => { clearTimeout(timer); if (!log.includes('AssayNova ready')) reject(new Error(error)); }); });
  t.after(async () => { if (child.exitCode !== null || child.signalCode !== null) return; const closed = once(child, 'close'); child.kill(); await closed; });
  const a = browser('http://127.0.0.1:' + port); assert.equal((await a.signup()).status, 201); assert.equal((await browser(primary.base).call('/session')).data.authenticated, false);
  await assert.rejects(stat(path.join(root, 'work/customer-accounts')), { code: 'ENOENT' });
  assert.match(await (await fetch('http://127.0.0.1:' + port)).text(), /name="assaynova-accounts" content="enabled"/);
});

function raw(base, route, headers) { const url = new URL(base); return new Promise((resolve, reject) => { const request = http.request({ hostname: url.hostname, port: url.port, path: route, headers }, response => { response.resume(); response.once('end', () => resolve({ status: response.statusCode, headers: response.headers })); }); request.once('error', reject); request.end(); }); }
