import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat, rename, cp, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../conference/studio.mjs';
import { createCustomerCatalog } from '../conference/customer-catalog.mjs';
import { createImports } from '../conference/imports.mjs';
import { IMPORT_LIMITS, importBodyLimit } from '../conference/import-limits.mjs';
import { previewIndex, productIdentity, productId, loadManagedCatalog, safeCode } from '../conference/import-match.mjs';
import { filterProducts } from '../conference/product-search.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const options = { sheet: 'Table', headerRow: 1, columns: { sku: 'A', product: 'B' } };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'assaynova-import-')); t.after(() => rm(root, { recursive: true, force: true }));
  const images = path.join(root, 'legacy'), store = path.join(root, 'reports'), authStore = path.join(root, 'auth'); await mkdir(images);
  const photo = await readFile(path.join(project, 'templates/coa/assets/sample-vial-product.png'));
  const other = await readFile(path.join(project, 'dist/assets/assaynova-about-sample-preparation.png'));
  await writeFile(path.join(images, 'BPC-157 10mg.png'), photo);
  return { root, images, store, authStore, photo, other };
}
async function server(t, files) {
  const result = await createStudio({ ...files, port: 0, publicOrigin: 'http://127.0.0.1:4318', render: async (request, output) => {
    const data = JSON.parse(await readFile(request)), code = data.lookupCode;
    await Promise.all([writeFile(path.join(output, 'bundle.json'), JSON.stringify({ label: data.product.name, report: { id: code, lookupCode: code, publication: 'published', issued: '2026-11-06' }, record: { client: data.fields.client, purity: [], composition: data.product.components, screenings: [], spectra: [], chromatogram: [] } })), writeFile(path.join(output, 'report.pdf'), '%PDF-import-preserved'), writeFile(path.join(output, 'report.svg'), '<svg/>')]);
  } });
  t.after(() => { result.server.closeAllConnections(); return new Promise(resolve => result.server.close(resolve)); });
  const html = await (await fetch(result.origin + '/admin')).text(), csrf = html.match(/name="admin-auth-csrf" content="([^"]+)"/)[1];
  const login = await fetch(result.origin + '/admin/auth/setup', { method: 'POST', headers: { Origin: result.origin, 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf }, body: JSON.stringify({ password: 'Synthetic import fixture 082' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (target, settings = {}) => fetch(result.origin + target, { ...settings, headers: { Cookie: cookie, ...settings.headers } });
  const session = await (await request('/admin/api/session')).json();
  const api = async (target, input = {}, method = 'POST', extra = {}) => {
    const response = await request(target, { method, headers: { Origin: result.origin, 'Content-Type': method === 'PUT' ? 'application/octet-stream' : 'application/json', 'X-Studio-Token': session.token, ...extra }, body: method === 'PUT' ? input : JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  };
  return { ...result, request, api, session, cookie };
}
async function upload(api, job, kind, name, bytes) {
  const registered = await api('/admin/api/imports/' + job + '/files', { kind, path: name, size: bytes.length }); assert.equal(registered.status, 200, registered.value.error);
  for (let offset = 0; offset < bytes.length; offset += IMPORT_LIMITS.chunk) {
    const sent = await api('/admin/api/imports/' + job + '/files/' + registered.value.id + '?offset=' + offset, bytes.subarray(offset, offset + IMPORT_LIMITS.chunk), 'PUT'); assert.equal(sent.status, 200, sent.value.error);
  }
  return registered.value;
}
function chunk(job, file, offset, bytes) {
  const request = Readable.from([bytes]); Object.assign(request, { method: 'PUT', url: '/admin/api/imports/' + job + '/files/' + file + '?offset=' + offset, headers: { 'content-type': 'application/octet-stream' }, complete: true }); return request;
}
async function directUpload(imports, job, kind, name, bytes) {
  const file = await imports.register(job, { kind, path: name, size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += IMPORT_LIMITS.chunk) await imports.put(chunk(job, file.id, offset, bytes.subarray(offset, offset + IMPORT_LIMITS.chunk)));
  return file;
}

test('short-code index is explicit, dose-exact, case-safe and preserves one concrete product/photo for multiple SKUs', () => {
  const rows = [{ row: 2, sku: 'ADA10', product: 'Adamax 10mg' }, { row: 3, sku: 'ADX10', product: 'Adamax 10mg' }], photo = { name: 'folder/ADA10.png', file: 'a'.repeat(32) + '.png', sha256: 'a'.repeat(64) };
  const value = previewIndex(rows, [photo], [], true); assert.equal(value.products.length, 1); assert.equal(value.aliases.length, 2); assert.equal(value.counts.valid, 2);
  const product = { ...value.products[0], aliases: { skus: value.aliases.map(row => row.sku), names: [], families: [] } };
  for (const query of ['ADA10', 'adx 10', 'Adamax 10mg']) assert.equal(filterProducts([product], query)[0], product);
  assert.equal(product.id, productId('Adamax 10mg')); assert.equal(filterProducts([product], 'ADA2').length, 0);
  assert.equal(productIdentity('BPC15710mg').name, 'BPC-157 10mg'); assert.throws(() => productIdentity('Unknown15710mg')); assert.throws(() => productIdentity('CU50+BPC10 10mg'));
  for (const name of ['KLOW 80mg', 'GLOW 70mg']) { const a = productIdentity(name), b = productIdentity(name.toLowerCase()); assert.deepEqual(a, b); assert.equal(a.components.length, name.startsWith('KLOW') ? 4 : 3); }
  assert.equal(productIdentity('NAD+', '10mg*10vials').name, 'NAD+ 10mg'); assert.equal(productIdentity('A 0.1mg + B 0.2mg', '0.3mg').components.length, 2);
  for (const identity of ['A 0.001mg', 'A 10mg + a 5mg', 'KLOW 70mg']) assert.throws(() => productIdentity(identity));
  const bad = previewIndex([{ row: 2, sku: 'ADA10', product: 'Adamax 2mg' }, { row: 3, sku: 'ada-10', product: 'Adamax 20mg' }], [photo], [], true); assert.equal(bad.aliases.length, 0); assert.equal(bad.counts.conflict, 2);
  const conflictingImages = previewIndex(rows, [photo, { ...photo, name: 'ADX10.png', sha256: 'b'.repeat(64) }], [], true); assert.equal(conflictingImages.blocking, true);
  const identical = previewIndex(rows, [photo, { ...photo, name: 'ADX10.png' }], [], true); assert.equal(identical.products.length, 1);
  assert.equal(previewIndex([{ row: 1, sku: 'ADA10 (02)', product: 'Adamax 10mg' }], [{ ...photo, name: 'ADA10 (02).png' }], [], true).counts.valid, 1);
  for (const code of ['CON', '../A', 'A/B', 'A\\B', 'A:1']) assert.throws(() => safeCode(code));
});

test('real HTTP import endpoints keep authentication, exact chunk bounds, offsets, safe paths and cancellation without partial appends', async t => {
  const files = await fixture(t), app = await server(t, files), staging = path.join(files.store, 'customer-imports/staging');
  for (const target of ['/admin/api/imports', '/admin/import-ui.mjs']) { assert.equal((await fetch(app.origin + target)).status, 401); }
  assert.deepEqual(await readdir(staging), []);
  assert.equal((await app.api('/admin/api/imports', { name: 'Aster' }, 'POST', { 'X-Studio-Token': '' })).status, 403);
  assert.equal((await app.api('/admin/api/imports', { name: 'Aster' }, 'POST', { Origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await app.api('/admin/api/imports', { name: 'Aster' }, 'POST', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await app.api('/admin/api/imports', { name: 'x'.repeat(9000) })).status, 413);
  assert.equal((await app.request('/admin/api/imports')).status, 405);
  const created = await app.api('/admin/api/imports', { customerId: app.session.defaultCustomerId }); assert.equal(created.status, 200); const job = created.value.id;
  for (const name of ['../escape.png', '/absolute.png', 'C:/absolute.png', 'folder\\A.png', 'folder/../A.png', 'folder//A.png', '／absolute.png']) assert.equal((await app.api('/admin/api/imports/' + job + '/files', { kind: 'image', path: name, size: 1 })).status, 400);
  const file = (await app.api('/admin/api/imports/' + job + '/files', { kind: 'image', path: 'folder/ADA10.png', size: 8 * 1024 * 1024 })).value;
  assert.equal((await app.api('/admin/api/imports/' + job + '/files', { kind: 'image', path: 'FOLDER/ada10.png', size: 1 })).status, 409);
  const target = '/admin/api/imports/' + job + '/files/' + file.id;
  assert.equal((await app.api(target + '?offset=1', Buffer.from('x'), 'PUT')).status, 409);
  assert.equal((await app.api(target + '?offset=0', Buffer.alloc(IMPORT_LIMITS.chunk + 1), 'PUT')).status, 413);
  assert.equal((await stat(path.join(staging, job, file.id + '.raw'))).size, 0);
  assert.equal((await app.api(target + '?offset=0', Buffer.alloc(IMPORT_LIMITS.chunk), 'PUT')).status, 200);
  assert.equal((await stat(path.join(staging, job, file.id + '.raw'))).size, IMPORT_LIMITS.chunk);
  assert.equal(importBodyLimit('PUT', target + '?offset=0'), IMPORT_LIMITS.chunk); assert.equal(importBodyLimit('POST', target + '?offset=0'), 8192); assert.equal(importBodyLimit('PUT', target + '?offset=00'), 8192);
  const interrupted = (await app.api('/admin/api/imports/' + job + '/files', { kind: 'image', path: 'interrupted.png', size: 100 })).value;
  await new Promise(resolve => { const request = http.request(app.origin + '/admin/api/imports/' + job + '/files/' + interrupted.id + '?offset=0', { method: 'PUT', headers: { Cookie: app.cookie, Origin: app.origin, 'Content-Type': 'application/octet-stream', 'X-Studio-Token': app.session.token, 'Content-Length': 100 } }); request.on('error', resolve); request.flushHeaders(); request.write('partial'); setTimeout(() => request.destroy(), 20); });
  assert.equal((await stat(path.join(staging, job, interrupted.id + '.raw'))).size, 0);
  assert.equal((await app.api('/admin/api/imports/' + job, {}, 'DELETE')).status, 200); assert.equal((await app.api('/admin/api/imports/' + job + '/confirm')).status, 404);
  assert.equal((await (await app.request('/admin/api/session')).json()).customers.length, 1);
});

test('new folder/table, SKU-only, folder-only and two customers activate atomically and preserve snapshots and migrated managed paths', async t => {
  const files = await fixture(t), app = await server(t, files);
  const old = await app.api('/admin/api/generate', { customerId: app.session.defaultCustomerId, productId: app.session.products[0].id, fields: {}, publish: true }); assert.equal(old.status, 201);
  const oldPDF = Buffer.from(await (await app.request(old.value.pdfURL)).arrayBuffer());
  const job = (await app.api('/admin/api/imports', { name: 'Aster' })).value.id;
  await upload(app.api, job, 'image', 'pictures/ADA10.png', files.photo);
  await upload(app.api, job, 'sheet', 'reordered.csv', Buffer.from('Title\n\nProductName,Note,ShortCode\nAdamax 10mg,ignored,ADA10\nAdamax 10mg,ignored,ADX10\n'));
  const inspected = await app.api('/admin/api/imports/' + job + '/inspect'); assert.equal(inspected.value.headerRow, 3);
  const mapped = { sheet: 'Table', headerRow: 3, columns: { sku: 'C', product: 'A' } };
  const preview = await app.api('/admin/api/imports/' + job + '/preview', mapped); assert.equal(preview.value.canConfirm, true); assert.equal(preview.value.counts.valid, 2);
  assert.equal((await (await app.request('/admin/api/session')).json()).customers.length, 1);
  const confirmed = await app.api('/admin/api/imports/' + job + '/confirm'); assert.equal(confirmed.status, 200, confirmed.value.error); const a = confirmed.value.customer, product = confirmed.value.products[0];
  for (const query of ['ADA10', 'ADX10', 'Adamax10mg']) assert.equal(filterProducts(confirmed.value.products, query)[0].id, product.id);
  assert.equal((await app.api('/admin/api/imports/' + job + '/confirm')).value.customer.id, a.id);
  assert.equal((await app.api('/admin/api/imports/' + job, {}, 'DELETE')).status, 409);
  assert.deepEqual(await readdir(path.join(files.store, 'customer-imports/staging')), []);
  const firstPhoto = Buffer.from(await (await app.request(product.imageURL)).arrayBuffer());
  const skuJob = (await app.api('/admin/api/imports', { customerId: a.id })).value.id;
  await upload(app.api, skuJob, 'sheet', 'codes.csv', Buffer.from('SKU,Product\nZED10,Adamax 10mg\n'));
  assert.equal((await app.api('/admin/api/imports/' + skuJob + '/preview', options)).value.canConfirm, true);
  const sku = (await app.api('/admin/api/imports/' + skuJob + '/confirm')).value;
  assert.equal(sku.customer.imageRevision, a.imageRevision); assert.notEqual(sku.customer.aliasRevision, a.aliasRevision); assert.equal(filterProducts(sku.products, 'ADA10').length, 0); assert.equal(filterProducts(sku.products, 'ZED10').length, 1);
  const renamed = await app.api('/admin/api/customers', { customerId: a.id, name: 'Aster renamed', directory: sku.customer.directory }); assert.equal(renamed.value.customer.imageRevision, a.imageRevision); assert.equal(renamed.value.customer.aliasRevision, sku.customer.aliasRevision);
  const folderJob = (await app.api('/admin/api/imports', { customerId: a.id })).value.id; await upload(app.api, folderJob, 'image', 'ZED10.png', files.photo);
  assert.equal((await app.api('/admin/api/imports/' + folderJob + '/preview')).value.canConfirm, true); assert.equal((await app.api('/admin/api/imports/' + folderJob + '/confirm')).status, 200);
  const cedarJob = (await app.api('/admin/api/imports', { name: 'Cedar' })).value.id; await upload(app.api, cedarJob, 'image', 'ADA10.png', files.other); await upload(app.api, cedarJob, 'sheet', 'codes.csv', Buffer.from('SKU,Product\nADA10,Adamax 10mg\n'));
  await app.api('/admin/api/imports/' + cedarJob + '/preview', options); const cedar = (await app.api('/admin/api/imports/' + cedarJob + '/confirm')).value;
  assert.equal(cedar.products[0].id, product.id); assert.notEqual(cedar.products[0].imageURL, product.imageURL); assert.notDeepEqual(Buffer.from(await (await app.request(cedar.products[0].imageURL)).arrayBuffer()), firstPhoto);
  const staleJob = (await app.api('/admin/api/imports', { customerId: a.id })).value.id; await upload(app.api, staleJob, 'sheet', 'codes.csv', Buffer.from('SKU,Product\nALT10,Adamax 10mg\n')); await app.api('/admin/api/imports/' + staleJob + '/preview', options);
  const current = (await (await app.request('/admin/api/catalog?customerId=' + a.id)).json()).customer;
  await app.api('/admin/api/customers', { customerId: a.id, name: 'Aster changed again', directory: current.directory }); assert.equal((await app.api('/admin/api/imports/' + staleJob + '/confirm')).status, 409);
  const moved = path.join(files.root, 'moved-store'); await cp(files.store, moved, { recursive: true }); const restarted = await createCustomerCatalog({ store: moved, images: files.images });
  const catalog = await restarted.scan(a.id); assert.equal(catalog.products[0].id, product.id); assert.ok(catalog.products[0].imagePath.startsWith(await realpath(moved)));
  assert.deepEqual(Buffer.from(await (await app.request(old.value.pdfURL)).arrayBuffer()), oldPDF);
  assert.equal((await fetch(app.origin + '/admin/import-ui.mjs')).status, 401); assert.equal((await app.request('/admin/customer-imports/revisions/' + a.imageRevision + '/catalog.json')).status, 404);
});

test('one guarded job phase protects uploads/commits from cancel and TTL, and changed preview cannot activate a stale prepared revision', async t => {
  const files = await fixture(t); let now = 0, fail = true;
  const registry = await createCustomerCatalog({ store: files.store, images: files.images, replaceFile: (...args) => fail ? Promise.reject(new Error('simulated atomic failure')) : rename(...args) });
  const imports = await createImports({ store: files.store, customers: registry, clock: () => now });
  const job = await imports.create({ name: 'Aster' }), file = await imports.register(job.id, { kind: 'image', path: 'ADA10.png', size: files.photo.length });
  let release, entered; const held = new Promise(resolve => release = resolve), started = new Promise(resolve => entered = resolve);
  const firstSize = Math.min(IMPORT_LIMITS.chunk, files.photo.length);
  const stream = Readable.from((async function* () { entered(); yield files.photo.subarray(0, 1); await held; yield files.photo.subarray(1, firstSize); })());
  Object.assign(stream, { method: 'PUT', url: '/admin/api/imports/' + job.id + '/files/' + file.id + '?offset=0', headers: { 'content-type': 'application/octet-stream' }, complete: true });
  const uploading = imports.put(stream); await started; now = IMPORT_LIMITS.idleMs + 1; await imports.cleanup(); await assert.rejects(imports.cancel(job.id), error => error.status === 409); release(); await uploading;
  for (let offset = firstSize; offset < files.photo.length; offset += IMPORT_LIMITS.chunk) await imports.put(chunk(job.id, file.id, offset, files.photo.subarray(offset, offset + IMPORT_LIMITS.chunk)));
  await directUpload(imports, job.id, 'sheet', 'mapping.csv', Buffer.from('SKU,Product,Alternative\nADA10,Adamax 10mg,Other 10mg\n'));
  await imports.preview(job.id, options); const before = await readFile(path.join(files.store, 'customers/profiles.json'));
  await assert.rejects(imports.confirm(job.id)); assert.deepEqual(await readFile(path.join(files.store, 'customers/profiles.json')), before);
  await imports.preview(job.id, { ...options, columns: { sku: 'A', product: 'C' } }); fail = false;
  const activate = registry.activate; let commitEntered, finishCommit;
  const committing = new Promise(resolve => commitEntered = resolve), commitHold = new Promise(resolve => finishCommit = resolve);
  registry.activate = async value => { commitEntered(); await commitHold; return activate(value); };
  const confirm = imports.confirm(job.id); await committing; now += IMPORT_LIMITS.idleMs + 1; await imports.cleanup(); await assert.rejects(imports.cancel(job.id), error => error.status === 409); finishCommit();
  const result = await confirm; assert.equal(result.products[0].name, 'Other 10mg'); assert.equal((await imports.confirm(job.id)).customer.id, result.customer.id);
  const cancelled = await imports.create({ name: 'Cancelled' }); await imports.cancel(cancelled.id); await assert.rejects(imports.confirm(cancelled.id), error => error.status === 404);
  const revision = result.customer.imageRevision, revisionFolder = path.join(files.store, 'customer-imports/revisions', revision), external = path.join(files.root, 'outside-images');
  await cp(path.join(revisionFolder, 'images'), external, { recursive: true }); await rename(path.join(revisionFolder, 'images'), path.join(revisionFolder, 'original-images'));
  try { await symlink(external, path.join(revisionFolder, 'images'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; t.diagnostic('Symlink privilege unavailable; managed relative migration and file hashes remain covered.'); return; }
  await assert.rejects(loadManagedCatalog(files.store, revision), /unavailable/);
});
