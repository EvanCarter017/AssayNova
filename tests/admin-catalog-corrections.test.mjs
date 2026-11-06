import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createStudio } from '../conference/studio.mjs';
import { createCustomerCatalog } from '../conference/customer-catalog.mjs';
import { createImports } from '../conference/imports.mjs';
import { IMPORT_LIMITS } from '../conference/import-limits.mjs';

const mapping = { sheet: 'Table', headerRow: 1, columns: { sku: 'A', product: 'B', dose: 'C' } };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'catalog-corrections-')); t.after(() => rm(root, { recursive: true, force: true }));
  const images = path.join(root, 'legacy'), store = path.join(root, 'reports'); await mkdir(images);
  const photo = await readFile(new URL('../templates/coa/assets/sample-vial-product.png', import.meta.url));
  const other = await readFile(new URL('../dist/assets/assaynova-about-sample-preparation.png', import.meta.url));
  await writeFile(path.join(images, 'BPC-157 10mg.png'), photo);
  const customers = await createCustomerCatalog({ store, images });
  return { root, images, store, authStore: path.join(root, 'synthetic-auth'), customers, photo, other };
}
async function upload(imports, job, kind, filename, bytes) {
  const file = await imports.register(job, { kind, path: filename, size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += IMPORT_LIMITS.chunk) {
    const request = Readable.from([bytes.subarray(offset, offset + IMPORT_LIMITS.chunk)]);
    Object.assign(request, { method: 'PUT', url: '/admin/api/imports/' + job + '/files/' + file.id + '?offset=' + offset, headers: { 'content-type': 'application/octet-stream' }, complete: true });
    await imports.put(request);
  }
  return file;
}
async function seed(imports, name = 'Aster') {
  const job = await imports.create({ name });
  await upload(imports, job.id, 'sheet', 'codes.csv', Buffer.from('SKU,Product,Dose\nADA10,Adamax,10mg\nBROKEN,Unresolved mixture,\n,Missing code,\n'));
  const preview = await imports.preview(job.id, mapping);
  return { job, preview, catalog: await imports.confirm(job.id, { previewId: preview.previewId }) };
}
async function app(t, files) {
  let renders = 0;
  const studio = await createStudio({ ...files, port: 0, render: async () => { renders++; throw new Error('Synthetic render boundary'); } });
  t.after(() => { if (!studio.server.listening) return; studio.server.closeAllConnections(); return new Promise(resolve => studio.server.close(resolve)); });
  const html = await (await fetch(studio.origin + '/admin')).text(), csrf = html.match(/name="admin-auth-csrf" content="([^"]+)"/)[1];
  const logged = await fetch(studio.origin + '/admin/auth/setup', { method: 'POST', headers: { Origin: studio.origin, 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf }, body: JSON.stringify({ password: 'Synthetic correction fixture 089' }) });
  const cookie = logged.headers.get('set-cookie').split(';')[0];
  const request = (url, input = {}) => fetch(studio.origin + url, { ...input, headers: { Cookie: cookie, ...input.headers } });
  const session = await (await request('/admin/api/session')).json();
  const api = async (url, body, method = 'POST', extra = {}) => {
    const response = await request(url, { method, headers: { Origin: studio.origin, 'Content-Type': method === 'PUT' ? 'application/octet-stream' : 'application/json', 'X-Studio-Token': session.token, ...extra }, ...(body !== undefined ? { body: method === 'PUT' ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  const send = async (job, kind, filename, bytes) => {
    const file = await api('/admin/api/imports/' + job + '/files', { kind, path: filename, size: bytes.length }); assert.equal(file.status, 200);
    for (let offset = 0; offset < bytes.length; offset += IMPORT_LIMITS.chunk) assert.equal((await api('/admin/api/imports/' + job + '/files/' + file.value.id + '?offset=' + offset, bytes.subarray(offset, offset + IMPORT_LIMITS.chunk), 'PUT')).status, 200);
    return file.value;
  };
  return { ...studio, request, api, send, rendered: () => renders };
}

test('all-blocked table-only import persists raw keys, pending preview/mapping and leases through restart and exact confirmation', async t => {
  const files = await fixture(t); let now = Date.now();
  let imports = await createImports({ store: files.store, customers: files.customers, clock: () => now }); t.after(() => imports.close());
  const job = await imports.create({ name: 'Pending' }); await upload(imports, job.id, 'sheet', 'codes.csv', Buffer.from('SKU,Product,Dose\nTR20/RT40,TR20+RT40,60mg*10vials\n,Missing,\nH15,Adamax,10mg\nH15,Adamax,10mg\n'));
  const preview = await imports.preview(job.id, mapping); assert.equal(preview.canConfirm, true); assert.deepEqual(preview.counts, { total: 4, ready: 0, blocked: 4 });
  assert.equal((await imports.list()).imports[0].previewId, preview.previewId);
  imports.close(); now += 2 * 24 * 60 * 60 * 1000; imports = await createImports({ store: files.store, customers: files.customers, clock: () => now });
  const detail = await imports.detail(job.id); assert.deepEqual(detail.mapping, mapping); assert.equal(detail.preview.previewId, preview.previewId); assert.equal(detail.files[0].offset, detail.files[0].size);
  await assert.rejects(imports.confirm(job.id, { previewId: 'f'.repeat(32) }), error => error.status === 400);
  const saved = await imports.confirm(job.id, { previewId: preview.previewId }); assert.equal(saved.entries.length, 4); assert.deepEqual(saved.products, []);
  assert.equal(saved.entries[0].raw.sku, 'TR20/RT40'); assert.ok(saved.entries.slice(2).every(entry => entry.issues.some(issue => issue.code === 'DUPLICATE_SKU')));
  imports.close(); imports = await createImports({ store: files.store, customers: files.customers, clock: () => now });
  assert.equal((await imports.confirm(job.id, { previewId: preview.previewId })).customer.id, saved.customer.id);
  assert.equal((await files.customers.list()).length, 2); assert.deepEqual(await readdir(path.join(files.store, 'customer-imports/staging')), []);
});

test('manual corrections save incomplete values, choose/upload pictures, hold duplicates and keep old receipts from rolling back', async t => {
  const files = await fixture(t), imports = await createImports({ store: files.store, customers: files.customers }); t.after(() => imports.close());
  const seeded = await seed(imports), customerId = seeded.catalog.customer.id, first = seeded.catalog.entries[0], second = seeded.catalog.entries[1];
  const uploadJob = await imports.create({ purpose: 'correction', customerId, entryId: first.id, expectedRevision: seeded.catalog.customer.catalogRevision });
  const image = await upload(imports, uploadJob.id, 'image', 'ADA10.png', files.photo);
  const patch = { expectedRevision: seeded.catalog.customer.catalogRevision, changes: { ...first.values, hold: false }, image: { jobId: uploadJob.id, fileId: image.id } };
  const ready = await imports.correct(customerId, first.id, patch); assert.equal(ready.entry.status, 'ready'); assert.equal(ready.products.length, 1);
  assert.equal((await imports.entry(customerId, first.id)).images.length, 1);
  const incomplete = await imports.correct(customerId, second.id, { expectedRevision: ready.customer.catalogRevision, changes: { sku: 'ADA10', product: '', dose: '' }, image: { assetId: ready.entry.imageId } });
  assert.equal(incomplete.products.length, 0); assert.ok(incomplete.entries[0].issues.some(issue => issue.code === 'DUPLICATE_SKU'));
  const held = await imports.correct(customerId, second.id, { expectedRevision: incomplete.customer.catalogRevision, changes: { hold: true } }); assert.equal(held.products.length, 1);
  const replay = await imports.correct(customerId, first.id, patch); assert.equal(replay.customer.catalogRevision, held.customer.catalogRevision);
  const confirmReplay = await imports.confirm(seeded.job.id, { previewId: seeded.preview.previewId }); assert.equal(confirmReplay.customer.catalogRevision, held.customer.catalogRevision);
  const removed = await imports.correct(customerId, first.id, { expectedRevision: held.customer.catalogRevision, changes: {}, image: null }); assert.equal(removed.entry.status, 'blocked');
  assert.deepEqual(removed.entry.raw, first.raw); assert.equal(removed.records.images.length, 1);
  await assert.rejects(imports.correct(customerId, first.id, { expectedRevision: held.customer.catalogRevision, changes: { hold: false } }), error => error.status === 409);
});

test('prepared confirm and correction reconcile crashes after pointer activation without duplicate customers or rollback', async t => {
  const files = await fixture(t); let imports = await createImports({ store: files.store, customers: files.customers }); t.after(() => imports.close());
  const job = await imports.create({ name: 'Crash safe' }); await upload(imports, job.id, 'sheet', 'codes.csv', Buffer.from('SKU,Product,Dose\nADA10,Adamax,10mg\n'));
  const preview = await imports.preview(job.id, mapping), activate = files.customers.activateRecords;
  files.customers.activateRecords = async input => { await activate(input); throw new Error('Synthetic post-swap crash'); };
  await assert.rejects(imports.confirm(job.id, { previewId: preview.previewId }), /post-swap/);
  files.customers.activateRecords = activate; imports.close(); imports = await createImports({ store: files.store, customers: files.customers });
  const saved = await imports.confirm(job.id, { previewId: preview.previewId }); assert.equal((await files.customers.list()).length, 2);
  const id = saved.entries[0].id, patch = { expectedRevision: saved.customer.catalogRevision, changes: { sku: 'CHANGED' } };
  files.customers.activateRecords = async input => { await activate(input); throw new Error('Synthetic correction post-swap crash'); };
  await assert.rejects(imports.correct(saved.customer.id, id, patch), /post-swap/);
  files.customers.activateRecords = activate; imports.close(); imports = await createImports({ store: files.store, customers: files.customers });
  const fixed = await imports.correct(saved.customer.id, id, patch); assert.equal(fixed.entry.values.sku, 'CHANGED');
  assert.equal((await imports.confirm(job.id, { previewId: preview.previewId })).customer.catalogRevision, fixed.customer.catalogRevision);
});

test('reimport replaces claimed ready rows, retains old blocked/held rows and all assets, and repeated identical uploads reuse assets', async t => {
  const files = await fixture(t), imports = await createImports({ store: files.store, customers: files.customers }); t.after(() => imports.close());
  const job = await imports.create({ name: 'Merge' }); await upload(imports, job.id, 'image', 'ADA10.png', files.photo); await upload(imports, job.id, 'image', 'unused.png', files.other);
  await upload(imports, job.id, 'sheet', 'codes.csv', Buffer.from('SKU,Product,Dose\nADA10,Adamax,10mg\nH15,Bad,\n'));
  let preview = await imports.preview(job.id, mapping), old = await imports.confirm(job.id, { previewId: preview.previewId });
  const held = await imports.correct(old.customer.id, old.entries[1].id, { expectedRevision: old.customer.catalogRevision, changes: { hold: true } });
  const second = await imports.create({ customerId: old.customer.id }); await upload(imports, second.id, 'image', 'ADA10.png', files.photo); await upload(imports, second.id, 'sheet', 'codes.csv', Buffer.from('SKU,Product,Dose\nADA10,Adamax,10mg\nH15,Adamax,10mg\n'));
  preview = await imports.preview(second.id, mapping); const merged = await imports.confirm(second.id, { previewId: preview.previewId });
  assert.equal(merged.records.images.length, 2); assert.equal(merged.entries.length, 3); assert.ok(merged.entries.some(entry => entry.id === held.entries[1].id && entry.hold));
  assert.equal(merged.entries.some(entry => entry.id === old.entries[0].id), false); assert.equal(merged.entries.filter(entry => entry.values.sku === 'H15').length, 2);
  const stale = await imports.create({ customerId: old.customer.id }); await upload(imports, stale.id, 'sheet', 'codes.csv', Buffer.from('SKU,Product,Dose\nOTHER,Adamax,10mg\n')); const stalePreview = await imports.preview(stale.id, mapping);
  await imports.correct(old.customer.id, merged.entries[0].id, { expectedRevision: merged.customer.catalogRevision, changes: { hold: false } });
  await assert.rejects(imports.confirm(stale.id, { previewId: stalePreview.previewId }), error => error.status === 409);
});

test('actual HTTP correction endpoints enforce auth/CSRF/asset ownership and generation rejects blocked/stale before render', async t => {
  const files = await fixture(t), direct = await createImports({ store: files.store, customers: files.customers });
  const seeded = await seed(direct), customerId = seeded.catalog.customer.id, selected = seeded.catalog.entries[0], url = '/admin/api/catalog/' + customerId + '/entries/' + selected.id;
  direct.close(); const studio = await app(t, files);
  assert.equal((await fetch(studio.origin + url)).status, 401); assert.equal((await fetch(studio.origin + '/admin/catalog-correction-ui.mjs')).status, 401);
  const detail = await (await studio.request(url)).json(); assert.equal(detail.catalogRevision, seeded.catalog.customer.catalogRevision); assert.equal(detail.entry.id, selected.id);
  const valid = { expectedRevision: detail.catalogRevision, changes: { ...selected.values, hold: false } };
  for (const headers of [{ 'X-Studio-Token': '' }, { Origin: 'http://evil.invalid' }]) assert.equal((await studio.api(url, valid, 'PATCH', headers)).status, 403);
  for (const patch of [{ ...valid, ready: true }, { ...valid, changes: { status: 'ready' } }, { ...valid, image: { path: '../secret.png' } }]) assert.equal((await studio.api(url, patch, 'PATCH')).status, 400);
  const blocked = await studio.api('/admin/api/generate', { customerId, productId: selected.id, catalogRevision: detail.catalogRevision, fields: {}, publish: false }); assert.equal(blocked.status, 400); assert.equal(studio.rendered(), 0);
  const job = await studio.api('/admin/api/imports', { purpose: 'correction', customerId, entryId: selected.id, expectedRevision: detail.catalogRevision }); assert.equal(job.status, 200);
  const file = await studio.send(job.value.id, 'image', 'ADA10.png', files.photo);
  const wrong = await studio.api('/admin/api/catalog/' + customerId + '/entries/' + seeded.catalog.entries[1].id, { ...valid, image: { jobId: job.value.id, fileId: file.id } }, 'PATCH'); assert.equal(wrong.status, 400);
  const fixed = await studio.api(url, { ...valid, image: { jobId: job.value.id, fileId: file.id } }, 'PATCH'); assert.equal(fixed.status, 200, fixed.value.error); assert.equal(fixed.value.entry.status, 'ready');
  const assetURL = fixed.value.entry.image.url; assert.equal((await fetch(studio.origin + assetURL)).status, 401); assert.equal((await studio.request(assetURL)).status, 200);
  assert.equal((await studio.request(assetURL + '?path=elsewhere')).status, 404);
  const otherJob = await studio.api('/admin/api/imports', { name: 'Other' }); await studio.send(otherJob.value.id, 'sheet', 'codes.csv', Buffer.from('SKU,Product,Dose\nADA10,Adamax,10mg\n'));
  const otherPreview = await studio.api('/admin/api/imports/' + otherJob.value.id + '/preview', mapping); const other = await studio.api('/admin/api/imports/' + otherJob.value.id + '/confirm', { previewId: otherPreview.value.previewId });
  const otherURL = '/admin/api/catalog/' + other.value.customer.id + '/entries/' + other.value.entries[0].id;
  assert.equal((await studio.api(otherURL, { expectedRevision: other.value.catalogRevision, changes: {}, image: { assetId: fixed.value.entry.image.id } }, 'PATCH')).status, 400);
  const stale = await studio.api('/admin/api/generate', { customerId, productId: selected.id, catalogRevision: detail.catalogRevision, fields: {}, publish: false }); assert.equal(stale.status, 409); assert.equal(studio.rendered(), 0);
  const ready = await studio.api('/admin/api/generate', { customerId, productId: selected.id, catalogRevision: fixed.value.catalogRevision, fields: {}, publish: false }); assert.equal(ready.status, 400); assert.equal(studio.rendered(), 1);
});

test('failed correction images preserve active revision and can be cancelled without exhausting pending quota', async t => {
  const files = await fixture(t), imports = await createImports({ store: files.store, customers: files.customers }); t.after(() => imports.close());
  const seeded = await seed(imports), customerId = seeded.catalog.customer.id, selected = seeded.catalog.entries[0], expectedRevision = seeded.catalog.customer.catalogRevision;
  for (let index = 0; index < 5; index++) {
    const job = await imports.create({ purpose: 'correction', customerId, entryId: selected.id, expectedRevision });
    const file = await upload(imports, job.id, 'image', 'ADA10.png', Buffer.from('invalid image'));
    await assert.rejects(imports.correct(customerId, selected.id, { expectedRevision, changes: {}, image: { jobId: job.id, fileId: file.id } }), error => error.status === 400);
    assert.equal((await files.customers.scan(customerId)).customer.catalogRevision, expectedRevision);
    assert.deepEqual(await imports.cancel(job.id), { ok: true });
  }
  assert.deepEqual(await readdir(path.join(files.store, 'customer-imports/staging')), []);
});

test('concurrent corrections serialize their revision guard and keep the winning catalog intact', async t => {
  const files = await fixture(t), imports = await createImports({ store: files.store, customers: files.customers }); t.after(() => imports.close());
  const seeded = await seed(imports), customerId = seeded.catalog.customer.id, selected = seeded.catalog.entries[0], expectedRevision = seeded.catalog.customer.catalogRevision;
  const results = await Promise.allSettled(['FIRST', 'SECOND'].map(sku => imports.correct(customerId, selected.id, { expectedRevision, changes: { sku } })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const winner = results.find(result => result.status === 'fulfilled').value, current = await files.customers.scan(customerId);
  assert.equal(current.customer.catalogRevision, winner.customer.catalogRevision); assert.deepEqual(current.entries[0].raw, selected.raw);
});

test('repeated identical correction uploads reuse the owned asset and preserve unused pictures', async t => {
  const files = await fixture(t), imports = await createImports({ store: files.store, customers: files.customers }); t.after(() => imports.close());
  const job = await imports.create({ name: 'Reusable assets' }); await upload(imports, job.id, 'image', 'ADA10.png', files.photo); await upload(imports, job.id, 'image', 'unused.png', files.other);
  await upload(imports, job.id, 'sheet', 'codes.csv', Buffer.from('SKU,Product,Dose\nADA10,Adamax,10mg\n'));
  const preview = await imports.preview(job.id, mapping); let current = await imports.confirm(job.id, { previewId: preview.previewId });
  const selectedId = current.entries[0].id, asset = current.entries[0].imageId, assetHash = current.records.images.find(image => image.id === asset).sha256;
  for (let index = 0; index < 3; index++) {
    const imageJob = await imports.create({ purpose: 'correction', customerId: current.customer.id, entryId: selectedId, expectedRevision: current.customer.catalogRevision });
    const file = await upload(imports, imageJob.id, 'image', 'ADA10.png', files.photo);
    current = await imports.correct(current.customer.id, selectedId, { expectedRevision: current.customer.catalogRevision, changes: {}, image: { jobId: imageJob.id, fileId: file.id } });
    assert.equal(current.records.images.length, 2); assert.equal(current.entry.imageId, asset); assert.equal(current.records.images.find(image => image.id === asset).sha256, assetHash);
    assert.ok(current.records.images.some(image => image.filename === 'unused.png'));
  }
  assert.deepEqual(await readdir(path.join(files.store, 'customer-imports/staging')), []);
});

test('actual lost correction-create ACK replays one persisted intent before quota/revision checks and survives restart', async t => {
  const files = await fixture(t), direct = await createImports({ store: files.store, customers: files.customers });
  const seeded = await seed(direct); direct.close(); const studio = await app(t, files);
  const selected = seeded.catalog.entries[0], customerId = seeded.catalog.customer.id, expectedRevision = seeded.catalog.customer.catalogRevision;
  const create = { purpose: 'correction', customerId, entryId: selected.id, expectedRevision, uploadIntent: randomBytes(16).toString('hex') };
  studio.server.prependListener('request', (request, response) => {
    if (request.url === '/admin/api/imports' && request.method === 'POST' && request.headers['x-synthetic-drop-ack'] === '1') response.end = () => { response.destroy(); return response; };
  });
  // The handler has committed its job and intent before its response is destroyed.
  // No JSON/body/late onValue acknowledgement reaches the client.
  for (let index = 0; index < 4; index++) await assert.rejects(studio.api('/admin/api/imports', create, 'POST', { 'X-Synthetic-Drop-ACK': '1' }), /fetch failed/);
  const replay = await studio.api('/admin/api/imports', create); assert.equal(replay.status, 200); const jobId = replay.value.id;
  assert.equal((await readdir(path.join(files.store, 'customer-imports/staging'))).length, 1);
  const extras = [];
  for (let index = 0; index < 3; index++) { const extra = await studio.api('/admin/api/imports', { ...create, uploadIntent: randomBytes(16).toString('hex') }); assert.equal(extra.status, 200); extras.push(extra.value.id); }
  assert.equal((await studio.api('/admin/api/imports', { ...create, uploadIntent: randomBytes(16).toString('hex') })).status, 409);
  assert.equal((await studio.api('/admin/api/imports', create)).value.id, jobId);
  assert.equal((await studio.api('/admin/api/imports', { ...create, entryId: seeded.catalog.entries[1].id })).status, 409);
  assert.equal((await studio.api('/admin/api/imports', { ...create, uploadIntent: '../invalid' })).status, 400);
  studio.server.closeAllConnections(); await new Promise(resolve => studio.server.close(resolve));
  let restarted = await createImports({ store: files.store, customers: files.customers }); t.after(() => restarted.close());
  assert.equal((await restarted.create(create)).id, jobId);
  await restarted.correct(customerId, selected.id, { expectedRevision, changes: { sku: 'UPDATED' } });
  assert.equal((await restarted.create(create)).id, jobId, 'old intent is recoverable for cleanup after current revision changes');
  await assert.rejects(restarted.create({ ...create, customerId: (await files.customers.list())[0].id }), error => error.status === 409);
  for (const id of [jobId, ...extras]) await restarted.cancel(id);
  await assert.rejects(restarted.create(create), error => error.status === 409);
  const current = await files.customers.scan(customerId), finalInput = { ...create, expectedRevision: current.customer.catalogRevision, uploadIntent: randomBytes(16).toString('hex') }, finalJob = await restarted.create(finalInput);
  const picture = await upload(restarted, finalJob.id, 'image', 'UPDATED.png', files.photo);
  await restarted.correct(customerId, selected.id, { expectedRevision: current.customer.catalogRevision, changes: {}, image: { jobId: finalJob.id, fileId: picture.id } });
  restarted.close(); restarted = await createImports({ store: files.store, customers: files.customers });
  await assert.rejects(restarted.create(finalInput), error => error.status === 409);
  assert.deepEqual(await readdir(path.join(files.store, 'customer-imports/staging')), []);
});

test('pre-upgrade pending job without a version resumes through detail, inspect, preview and partial confirmation', async t => {
  const files = await fixture(t); let imports = await createImports({ store: files.store, customers: files.customers }); t.after(() => imports.close());
  const job = await imports.create({ name: 'Legacy pending upload' });
  await upload(imports, job.id, 'sheet', 'codes.csv', Buffer.from('SKU,Product,Dose\nADA10,Adamax,10mg\nTR20/RT40,TR20+RT40,60mg*10vials\n'));
  const filename = path.join(files.store, 'customer-imports/staging', job.id, 'job.json'), modern = JSON.parse(await readFile(filename, 'utf8'));
  await writeFile(filename, JSON.stringify({ id: modern.id, target: modern.target, touched: modern.touched, files: modern.files }));
  imports.close(); imports = await createImports({ store: files.store, customers: files.customers });
  const detail = await imports.detail(job.id); assert.equal(detail.id, job.id); assert.equal(detail.purpose, 'import'); assert.equal(detail.preview, null); assert.equal(detail.files[0].offset, detail.files[0].size);
  const inspected = await imports.inspect(job.id, {}); assert.equal(inspected.headerRow, 1);
  const preview = await imports.preview(job.id, mapping); assert.equal(preview.canConfirm, true); assert.deepEqual(preview.counts, { total: 2, ready: 0, blocked: 2 });
  const confirmed = await imports.confirm(job.id, { previewId: preview.previewId }); assert.equal(confirmed.customer.name, 'Legacy pending upload'); assert.equal(confirmed.entries[1].raw.sku, 'TR20/RT40');
});
