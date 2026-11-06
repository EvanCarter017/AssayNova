import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCustomerCatalog } from '../conference/customer-catalog.mjs';
import { createStudio } from '../conference/studio.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'assaynova-customers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = path.join(root, 'a'), b = path.join(root, 'b'), store = path.join(root, 'store'), authStore = path.join(root, 'auth');
  await Promise.all([a, b].map(folder => mkdir(folder)));
  await writeFile(path.join(a, 'BPC-157 10mg.png'), 'fixture-a-original-bytes');
  await writeFile(path.join(b, 'BPC-157 10mg.png'), 'fixture-b-distinct-bytes');
  await writeFile(path.join(a, 'Semaglutide 5mg.png'), 'fixture-a-semaglutide');
  return { root, a, b, store, authStore };
}
const configFile = files => path.join(files.store, 'customers', 'profiles.json');
const syntheticPassword = 'Synthetic customer fixture 081';
async function studio(t, files, render) {
  const value = await createStudio({ images: files.a, store: files.store, authStore: files.authStore, port: 0, publicOrigin: 'http://127.0.0.1:4318', render });
  let stopped;
  value.stop = () => stopped ??= new Promise(resolve => { value.server.closeAllConnections(); value.server.close(resolve); });
  t.after(value.stop); return value;
}
async function unlock(origin) {
  const html = await (await fetch(origin + '/admin')).text(), mode = html.match(/name="admin-auth-mode" content="([^"]+)"/)[1], csrf = html.match(/name="admin-auth-csrf" content="([^"]+)"/)[1];
  const response = await fetch(origin + '/admin/auth/' + mode, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf }, body: JSON.stringify({ password: syntheticPassword }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return (target, options = {}) => fetch(origin + target, { ...options, headers: { Cookie: cookie, ...options.headers } });
}
async function stubRenderer(requestFile, output) {
  const request = JSON.parse(await readFile(requestFile)), code = request.lookupCode;
  await Promise.all([
    writeFile(path.join(output, 'bundle.json'), JSON.stringify({ label: request.product.name, report: { id: code, lookupCode: code, publication: 'published', issued: '2026-11-06' }, record: { client: request.fields.client, purity: [], composition: request.product.components, screenings: [], spectra: [], chromatogram: [] } })),
    writeFile(path.join(output, 'report.pdf'), '%PDF-customer-fixture'),
    writeFile(path.join(output, 'report.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>' + request.fields.client + '</text></svg>')
  ]);
}

test('customer registry persists stable profiles, serializes writes, validates names/directories and never overwrites failed/corrupt saves', async t => {
  const files = await fixture(t), registry = await createCustomerCatalog({ store: files.store, images: files.a });
  const initial = (await registry.list())[0]; assert.equal(initial.name, 'Research Client'); assert.match(initial.id, /^[a-f0-9]{20}$/);
  const renamed = await registry.save({ customerId: initial.id, name: ' Aster ', directory: files.a }); assert.equal(renamed.customer.id, initial.id); assert.equal(renamed.customer.name, 'Aster');
  const concurrent = await Promise.all([registry.save({ name: 'Cedar', directory: files.b }), registry.save({ name: 'Maple', directory: files.a })]);
  assert.equal((await registry.list()).length, 3); assert.notEqual(concurrent[0].customer.id, concurrent[1].customer.id);
  const before = await readFile(configFile(files));
  for (const input of [
    { name: 'aster', directory: files.a }, { name: '', directory: files.a }, { name: '中文', directory: files.a }, { name: 'x'.repeat(65), directory: files.a },
    { name: 'Other', directory: 'relative' }, { name: 'Other', directory: '\\\\server\\share' }, { name: 'Other', directory: '\\\\?\\C:\\products' },
    { name: 'Other', directory: 'https://example.invalid/images' }, { name: 'Other', directory: path.join(files.root, 'CON') }, { name: 'Other', directory: path.join(files.root, 'missing') },
    { customerId: 'f'.repeat(20), name: 'Other', directory: files.a }, { name: 'Other', directory: files.a, extra: true }
  ]) await assert.rejects(registry.save(input));
  assert.deepEqual(await readFile(configFile(files)), before);
  const failing = await createCustomerCatalog({ store: files.store, images: files.a, replaceFile: async () => { throw new Error('private filesystem detail'); } });
  await assert.rejects(failing.save({ name: 'Failed', directory: files.a }), error => error.status === 503 && !error.message.includes('private filesystem'));
  assert.deepEqual(await readFile(configFile(files)), before); assert.deepEqual((await readdir(path.dirname(configFile(files)))).sort(), ['profiles.json']);
  const restarted = await createCustomerCatalog({ store: files.store, images: files.b }); assert.deepEqual(await restarted.list(), await registry.list());
  await writeFile(configFile(files), '{corrupt');
  await assert.rejects(createCustomerCatalog({ store: files.store, images: files.a }), /configuration is unavailable/); assert.equal(await readFile(configFile(files), 'utf8'), '{corrupt');
});

test('registry rescans exact customer roots on every read, accepts shared folders, and rejects empty/escaping catalogs', async t => {
  const files = await fixture(t), registry = await createCustomerCatalog({ store: files.store, images: files.a }), a = (await registry.list())[0];
  const b = (await registry.save({ name: 'Cedar', directory: files.b })).customer;
  assert.equal((await registry.scan(a.id)).products.length, 2); assert.equal((await registry.scan(b.id)).products.length, 1);
  await writeFile(path.join(files.b, 'Tirzepatide 5mg.png'), 'new-live-file'); assert.equal((await registry.scan(b.id)).products.length, 2);
  await rm(path.join(files.b, 'BPC-157 10mg.png')); assert.equal((await registry.scan(b.id)).products[0].name, 'Tirzepatide 5mg');
  await registry.save({ name: 'Same folder', directory: files.a });
  const invalid = path.join(files.root, 'invalid'); await mkdir(invalid); await writeFile(path.join(invalid, 'unknown.png'), 'not-a-dose');
  await assert.rejects(registry.save({ name: 'Invalid', directory: invalid }), /directory could not be read/);
  const empty = path.join(files.root, 'empty'); await mkdir(empty); await assert.rejects(registry.save({ name: 'Empty', directory: empty }), /directory could not be read/);
  const links = path.join(files.root, 'links'); await mkdir(links);
  try { await symlink(path.join(files.a, 'BPC-157 10mg.png'), path.join(links, 'BPC-157 10mg.png'), 'file'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; t.diagnostic('Windows file-symlink privilege unavailable; empty/containment catalog cases remain covered.'); return; }
  await assert.rejects(registry.save({ name: 'Escaping image', directory: links }), /directory could not be read/);
});

test('bounded registry schema fails closed, concurrent seed is exclusive and absent default directories remain repairable', async t => {
  const files = await fixture(t), seeded = await Promise.all([createCustomerCatalog({ store: files.store, images: files.a }), createCustomerCatalog({ store: files.store, images: files.b })]);
  assert.deepEqual(await seeded[0].list(), await seeded[1].list()); assert.equal((await seeded[0].list()).length, 1);
  const good = await readFile(configFile(files), 'utf8');
  for (const data of ['x'.repeat(65537), JSON.stringify({ version: 2, customers: [] }), JSON.stringify({ ...JSON.parse(good), extra: true }), JSON.stringify({ version: 1, customers: Array(33).fill(JSON.parse(good).customers[0]) })]) {
    await writeFile(configFile(files), data); await assert.rejects(createCustomerCatalog({ store: files.store, images: files.a }), /configuration is unavailable/); assert.equal(await readFile(configFile(files), 'utf8'), data);
  }
  const missingStore = path.join(files.root, 'missing-store'), missing = await createCustomerCatalog({ store: missingStore, images: path.join(files.root, 'absent') });
  const profile = (await missing.list())[0]; await assert.rejects(missing.scan(profile.id), /directory could not be read/);
  await missing.save({ customerId: profile.id, name: 'Repaired', directory: files.a }); assert.equal((await missing.scan(profile.id)).products.length, 2);
});

test('authenticated customer API scopes same-name images and generation, rejects tampering, preserves snapshots and survives repair/restart', async t => {
  const files = await fixture(t), captured = [];
  let primary = await studio(t, files, async (...args) => { captured.push(JSON.parse(await readFile(args[0]))); await stubRenderer(...args); });
  let request = await unlock(primary.origin), session = await (await request('/admin/api/session')).json();
  const post = (target, input, headers = {}) => request(target, { method: 'POST', headers: { Origin: primary.origin, 'Content-Type': 'application/json', 'X-Studio-Token': session.token, ...headers }, body: JSON.stringify(input) });
  for (const target of ['/admin/api/catalog?customerId=' + session.defaultCustomerId, '/admin/api/customers', '/admin/images/' + session.defaultCustomerId + '/' + session.products[0].id]) assert.equal((await fetch(primary.origin + target)).status, 401);
  assert.equal((await post('/admin/api/customers', { name: 'Cedar', directory: files.b }, { 'X-Studio-Token': '' })).status, 403);
  assert.equal((await post('/admin/api/customers', { name: 'Cedar', directory: files.b }, { Origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await post('/admin/api/customers', { name: 'x'.repeat(9000), directory: files.b })).status, 413);
  const a = (await (await post('/admin/api/customers', { customerId: session.defaultCustomerId, name: 'Aster', directory: files.a })).json()).customer;
  const saved = await post('/admin/api/customers', { name: 'Cedar', directory: files.b }); assert.equal(saved.status, 200); const b = (await saved.json()).customer;
  const catalog = async id => (await request('/admin/api/catalog?customerId=' + id)).json();
  const aProducts = (await catalog(a.id)).products, bProducts = (await catalog(b.id)).products;
  const ap = aProducts.find(row => row.name === 'BPC-157 10mg'), bp = bProducts[0]; assert.equal(ap.id, bp.id); assert.notEqual(ap.imageURL, bp.imageURL);
  assert.equal(await (await request(ap.imageURL)).text(), 'fixture-a-original-bytes'); assert.equal(await (await request(bp.imageURL)).text(), 'fixture-b-distinct-bytes');
  assert.equal((await request('/admin/images/' + a.id + '/' + ap.id, { method: 'HEAD' })).status, 200);
  assert.equal((await request('/admin/images/' + ap.id)).status, 404);
  for (const target of ['/admin/api/catalog', '/admin/api/catalog?customerId=' + a.id + '&customerId=' + b.id, '/admin/api/catalog?customerId=' + a.id + '&directory=' + files.b, '/admin/api/catalog?customerId=' + 'f'.repeat(20)]) assert.equal((await request(target)).status, 400);
  const generate = input => post('/admin/api/generate', input), input = { customerId: b.id, productId: bp.id, fields: {}, publish: true };
  assert.equal((await generate({ ...input, customerId: undefined })).status, 400);
  assert.equal((await generate({ ...input, fields: { client: 'Spoofed' } })).status, 400);
  assert.equal((await generate({ ...input, productId: aProducts.find(row => row.name === 'Semaglutide 5mg').id })).status, 400);
  const generatedResponse = await generate(input); assert.equal(generatedResponse.status, 201); const generated = await generatedResponse.json();
  assert.equal(generated.record.client, 'Cedar'); assert.equal(captured[0].fields.client, 'Cedar'); assert.equal(captured[0].product.imagePath, await realpath(path.join(files.b, 'BPC-157 10mg.png')));
  const oldPDF = Buffer.from(await (await request(generated.pdfURL)).arrayBuffer()), oldBundle = await readFile(path.join(files.store, 'published', generated.report.lookupCode, 'bundle.json'));
  assert.equal((await request('/admin/customers/profiles.json')).status, 404);
  await rm(path.join(files.b, 'BPC-157 10mg.png')); assert.equal((await generate(input)).status, 400);
  await post('/admin/api/customers', { customerId: b.id, name: 'Renamed Cedar', directory: files.a });
  assert.deepEqual(Buffer.from(await (await request(generated.pdfURL)).arrayBuffer()), oldPDF); assert.deepEqual(await readFile(path.join(files.store, 'published', generated.report.lookupCode, 'bundle.json')), oldBundle);
  await rm(files.a, { recursive: true }); await primary.stop();
  primary = await studio(t, files, stubRenderer); request = await unlock(primary.origin); session = await (await request('/admin/api/session')).json();
  assert.equal(session.defaultCustomerId, a.id); assert.deepEqual(session.products, []); assert.match(session.catalogError, /directory could not be read/); assert.equal(session.customers.length, 2);
  const repaired = await post('/admin/api/customers', { customerId: a.id, name: 'Aster repaired', directory: files.b }); assert.equal(repaired.status, 400, 'empty repair directory must not be accepted');
  await writeFile(path.join(files.b, 'KPV 10mg.png'), 'repair-photo');
  assert.equal((await post('/admin/api/customers', { customerId: a.id, name: 'Aster repaired', directory: files.b })).status, 200);
  assert.equal((await catalog(a.id)).products[0].name, 'KPV 10mg');
  assert.deepEqual(Buffer.from(await (await request(generated.pdfURL)).arrayBuffer()), oldPDF);
  assert.deepEqual(await readFile(path.join(files.store, 'published', generated.report.lookupCode, 'bundle.json')), oldBundle);
  assert.equal((await (await request('/admin/api/history')).json())[0].lookupCode, generated.report.lookupCode);
});
