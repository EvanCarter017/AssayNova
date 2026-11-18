import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rmdir, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../conference/store.mjs';
import { createAdmin } from '../conference/admin.mjs';
import { readPublished, handlePublicReport, validCode } from '../conference/reader.mjs';
import { SAMPLE_REPORT_DATA } from '../conference/sample-reports/sample-data.js';

const code = 'AN-QA92-0001', product = { id: 'synthetic', name: 'Synthetic removal fixture', unit: 'mg' };
async function render(requestPath, output) {
  const input = JSON.parse(await readFile(requestPath, 'utf8'));
  const record = structuredClone(SAMPLE_REPORT_DATA['AN-7K9Q-2M4X']);
  const report = { lookupCode: input.lookupCode, publication: 'published', issued: '2026-11-07', sample: product.name };
  await Promise.all([writeFile(path.join(output, 'bundle.json'), JSON.stringify({ report, record, label: product.name })), writeFile(path.join(output, 'report.pdf'), '%PDF-synthetic-092\0'), writeFile(path.join(output, 'report.svg'), '<svg>synthetic-092</svg>')]);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'assaynova-removal-092-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeRoot = path.join(root, 'reports'), store = await createStore(storeRoot, { render, codeFactory: () => code });
  await store.generate(product, {}, true);
  // Only this disposable fixture's private bytes are inspected.
  await mkdir(path.join(storeRoot, 'published', code, 'extra'));
  await writeFile(path.join(storeRoot, 'published', code, 'extra', 'opaque.bin'), Buffer.from([0, 255, 41, 92]));
  return { root, storeRoot, store };
}
async function bytes(folder, prefix = '') {
  const result = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const key = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await bytes(path.join(folder, entry.name), key + '/'));
    else result[key] = (await readFile(path.join(folder, entry.name))).toString('base64');
  }
  return result;
}
const hasStatus = status => error => error.status === status;

test('remove/restart/restore retains every synthetic byte and code, filters history and reserves removed codes', async t => {
  const { storeRoot, store } = await fixture(t), before = await bytes(path.join(storeRoot, 'published', code));
  assert.deepEqual(await store.history(), [{ lookupCode: code, label: product.name, reported: '2026-11-07', adminOnly: true }]);
  assert.deepEqual(await store.remove(code), { lookupCode: code, state: 'removed', label: product.name, adminOnly: true });
  assert.equal(await readPublished(storeRoot, code), null); assert.deepEqual(await store.history(), []);
  assert.deepEqual(await bytes(path.join(storeRoot, 'removed', code)), before);
  const restarted = await createStore(storeRoot, { render, codeFactory: () => code });
  assert.equal((await restarted.history('removed'))[0].lookupCode, code);
  assert.equal((await restarted.remove(code)).state, 'removed');
  await assert.rejects(restarted.generate(product, {}, true), /unique Lookup Code/);
  assert.equal(restarted.busy, false);
  assert.equal((await restarted.restore(code)).state, 'published');
  assert.equal((await restarted.restore(code)).state, 'published');
  assert.deepEqual(await bytes(path.join(storeRoot, 'published', code)), before);
  assert.deepEqual(await restarted.history('removed'), []); assert.equal(await readPublished(storeRoot, code),null);
});

test('invalid/reserved/missing/conflicting/symlink snapshots fail closed and release the single writer', async t => {
  const { root, storeRoot, store } = await fixture(t), published = path.join(storeRoot, 'published', code), removed = path.join(storeRoot, 'removed', code), before = await bytes(published);
  for (const invalid of ['AN-7K9Q-2M4X', 'AN-8P6R-3N5Y', code + '\n', code.toLowerCase(), '../' + code, 'AN-NONE-0000/extra', null]) {
    assert.equal(validCode(invalid), invalid === 'AN-7K9Q-2M4X' || invalid === 'AN-8P6R-3N5Y');
    await assert.rejects(store.remove(invalid), hasStatus(400));
  }
  await assert.rejects(store.remove('AN-NONE-0000'), hasStatus(404));
  await cp(published, removed, { recursive: true });
  await assert.rejects(store.remove(code), hasStatus(409)); await assert.rejects(store.restore(code), hasStatus(409));
  assert.deepEqual(await bytes(published), before); assert.deepEqual(await bytes(removed), before);
  await rm(removed, { recursive: true });
  const outside = path.join(root, 'synthetic-outside'); await mkdir(outside); await writeFile(path.join(outside, 'sentinel'), 'unchanged');
  await symlink(outside, path.join(published, 'linked'), 'junction');
  await assert.rejects(store.remove(code), hasStatus(409)); assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
  await rm(path.join(published, 'linked')); assert.equal(store.busy, false);
  const bundleFile = path.join(published, 'bundle.json'), bundle = await readFile(bundleFile);
  await writeFile(bundleFile, '{}'); await assert.rejects(store.remove(code), hasStatus(409)); await writeFile(bundleFile, bundle);
  const moving = store.remove(code); assert.equal(store.busy, true);
  await assert.rejects(store.generate(product, {}, true), hasStatus(409)); await moving;
  assert.equal(store.busy, false); await store.restore(code); assert.deepEqual(await bytes(published), before);
});

test('filesystem failure leaves visibility and bytes intact, and generation blocks visibility changes', async t => {
  const { storeRoot, store } = await fixture(t), before = await bytes(path.join(storeRoot, 'published', code));
  await rmdir(path.join(storeRoot, 'removed')); await writeFile(path.join(storeRoot, 'removed'), 'synthetic filesystem failure');
  await assert.rejects(store.remove(code)); assert.equal(store.busy, false);
  assert.deepEqual(await bytes(path.join(storeRoot, 'published', code)), before); assert.equal(await readPublished(storeRoot, code),null);
  await rm(path.join(storeRoot, 'removed')); await mkdir(path.join(storeRoot, 'removed'));
  let release, entered; const started = new Promise(resolve => entered = resolve);
  const held = await createStore(storeRoot, { codeFactory: () => 'AN-QA92-0002', render: async (...args) => { entered(); await new Promise(resolve => release = resolve); await render(...args); } });
  const generating = held.generate(product, {}, false); await started;
  await assert.rejects(held.remove(code), hasStatus(409)); await assert.rejects(held.restore(code), hasStatus(409)); release(); await generating;
  assert.equal((await store.remove(code)).state, 'removed');
});

function raw(origin, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin), request = http.request({ hostname: url.hostname, port: url.port, path: route, method, headers }, response => { const chunks = []; response.on('data', value => chunks.push(value)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) })); });
    request.on('error', reject); request.end(body);
  });
}
async function server(t, files) {
  const images = path.join(files.root, 'images'); await mkdir(images, { recursive: true });
  let origin;
  const admin = await createAdmin({ origin: () => origin, images, store: files.storeRoot, authStore: path.join(files.root, 'synthetic-auth'), publicOrigin: 'https://fixture.invalid' });
  const server = http.createServer(async (request, response) => { if (await admin.handle(request, response)) return; if (await handlePublicReport(request, response, request.url.split('?')[0], files.storeRoot)) return; response.writeHead(404); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  let stopped = false; const stop = async () => { if (stopped) return; stopped = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }; t.after(stop);
  const page = (await raw(origin, '/admin')).bytes.toString(), mode = page.match(/name="admin-auth-mode" content="([^"]+)"/)[1], csrf = page.match(/name="admin-auth-csrf" content="([^"]+)"/)[1];
  const auth = await raw(origin, '/admin/auth/' + mode, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf }, body: JSON.stringify({ password: 'Synthetic removal password 092' }) }); assert.equal(auth.status, 200);
  const cookie = auth.headers['set-cookie'][0].split(';')[0], session = JSON.parse((await raw(origin, '/admin/api/session', { headers: { Cookie: cookie } })).bytes);
  const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-Studio-Token': session.token };
  return { origin, stop, headers, get: route => raw(origin, route, { headers: { Cookie: cookie } }), post: (route, options = {}) => raw(origin, route, { method: 'POST', headers, body: '{}', ...options }) };
}

test('HTTP routes enforce auth/token/origin/method/exact JSON paths and deny every removed public alias GET/HEAD across restart', async t => {
  const files = await fixture(t), before = await bytes(path.join(files.storeRoot, 'published', code)); let app = await server(t, files);
  const route = '/admin/api/reports/' + code + '/remove';
  assert.equal((await raw(app.origin, route, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await raw(app.origin, '/admin/report-removal-ui.mjs')).status, 401); assert.equal((await app.get('/admin/report-removal-ui.mjs')).status, 200);
  for (const headers of [{ ...app.headers, Origin: 'https://evil.invalid' }, { ...app.headers, Origin: '' }, { ...app.headers, 'X-Studio-Token': '' }]) assert.equal((await app.post(route, { headers })).status, 403);
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) assert.equal((await raw(app.origin, route, { method, headers: app.headers })).status, 405);
  for (const body of ['null', '[]', '1', '{"code":"extra"}', '{', JSON.stringify({ oversized: 'x'.repeat(8200) })]) assert.equal((await app.post(route, { body })).status, body.length > 8192 ? 413 : 400);
  assert.equal((await app.post(route, { headers: { ...app.headers, 'Content-Type': 'text/plain' } })).status, 415);
  for (const bad of [route + '?x=1', route + '/', route.replace(code, code.toLowerCase()), route.replace('remove', 'Remove'), route.replace(code, '%41N-QA92-0001'), route + '/extra']) assert.ok([400, 404].includes((await app.post(bad)).status), bad);
  for (const query of ['?state=published', '?state=removed&state=removed', '?x=1', '?state=%72emoved', '?state=removed&x=1', '?']) assert.equal((await app.get('/admin/api/history' + query)).status, 400);
  assert.equal((await app.post('/admin/api/reports/AN-7K9Q-2M4X/remove')).status, 400);
  assert.equal((await app.post(route)).status, 200); assert.equal((await app.post(route)).status, 200);
  assert.deepEqual(JSON.parse((await app.get('/admin/api/history')).bytes), []);
  assert.equal(JSON.parse((await app.get('/admin/api/history?state=removed')).bytes)[0].lookupCode, code);
  const aliases = ['/coa/' + code, '/__reports/' + code, '/__reports/' + code + '/report.pdf', '/__reports/' + code + '/report.svg', '/coa/' + code + '/report.pdf', '/__reports/' + code.toLowerCase() + '/report.pdf', '/bundles/removed/' + code + '/report.pdf', '/removed/' + code + '/report.pdf'];
  async function denied() { for (const alias of aliases) for (const method of ['GET', 'HEAD']) assert.equal((await raw(app.origin, alias, { method })).status, 404, method + ' ' + alias); }
  await denied();
  for (const asset of ['report.pdf', 'report.svg']) {
    const preview = '/admin/bundles/removed/' + code + '/' + asset;
    assert.equal((await raw(app.origin, preview)).status, 401); assert.equal((await app.get(preview)).bytes.toString('base64'), before[asset]);
  }
  assert.equal((await app.get('/admin/bundles/removed/' + code + '/private.json')).status, 404);
  await app.stop(); app = await server(t, files); await denied();
  const restored = await app.post('/admin/api/reports/' + code + '/restore'); assert.equal(restored.status, 200); assert.deepEqual(Object.keys(JSON.parse(restored.bytes)).sort(), ['adminOnly', 'label', 'lookupCode', 'state']);
  await denied();
  for (const asset of ['report.pdf', 'report.svg']) assert.equal((await app.get('/admin/bundles/published/' + code + '/' + asset)).bytes.toString('base64'), before[asset]);
  assert.deepEqual(await bytes(path.join(files.storeRoot, 'published', code)), before);
});
