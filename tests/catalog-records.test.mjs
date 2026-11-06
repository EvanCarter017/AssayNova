import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { makeEntries, evaluateRecords, applyCorrection, recordsDTO, writeCatalogRecords, readCatalogRecords } from '../conference/catalog-records.mjs';

const nonce = () => randomBytes(16).toString('hex');
const origin = () => ({ importId: nonce(), previewId: nonce(), customerId: randomBytes(10).toString('hex') });
const image = (filename, marker = 'a') => ({ id: nonce(), filename, sha256: marker.repeat(64), bytes: 1 });
function records(rows, images = [], extra = {}) { return { version: 2, entries: makeEntries(rows, images, { jobId: nonce(), sheet: 'Products' }), images, origin: origin(), ...extra }; }

test('retains each raw source row with opaque stable row IDs, independent pictures and slash short codes', () => {
  const images = [image('ADA10.png'), image('ADX10.png', 'b'), image('unused.png')], raw = [{ row: 2, sku: 'ADA10', product: 'Adamax', dose: '10mg * 10vials' }, { row: 3, sku: 'ADX10', product: 'Adamax', dose: '10mg' }, { row: 4, sku: 'TR20/RT40', product: 'TR20+RT40', dose: '60mg*10vials' }];
  const value = records(raw, images), evaluated = evaluateRecords(value);
  assert.deepEqual(evaluated.counts, { total: 3, ready: 2, blocked: 1 });
  assert.notEqual(evaluated.products[0].id, evaluated.products[1].id); assert.notEqual(evaluated.products[0].imageId, evaluated.products[1].imageId);
  assert.equal(value.entries[2].raw.sku, 'TR20/RT40'); assert.equal(value.images.length, 3);
  const edited = applyCorrection(value, value.entries[2].id, { expectedRevision: nonce(), changes: { product: 'Adamax', dose: '10mg' } });
  assert.deepEqual(edited.entries[2].raw, value.entries[2].raw); assert.equal(edited.entries[2].id, value.entries[2].id);
  const dto = recordsDTO({ ...evaluated, records: value, customer: { id: value.origin.customerId, catalogRevision: nonce() } });
  assert.deepEqual(Object.keys(dto.entries[2]).sort(), ['hold','id','image','issues','raw','source','status','values']);
  assert.equal(dto.products.some(product => product.id === value.entries[2].id), false);
});

test('duplicates and blocked literal unit aliases reserve identity until an explicit hold', () => {
  const images = [image('ADA10.png'), image('ADA10mg.png')];
  const value = records([{ sku: 'ADA10', product: 'Adamax 10mg' }, { sku: 'ADA10mg', product: 'Unresolved mixture' }], images);
  assert.equal(evaluateRecords(value).products.length, 0);
  assert.ok(evaluateRecords(value).entries.every(entry => entry.issues.some(issue => issue.code === 'SEARCH_COLLISION')));
  const held = applyCorrection(value, value.entries[1].id, { expectedRevision: nonce(), changes: { hold: true } });
  assert.equal(evaluateRecords(held).products.length, 1);
  const duplicate = records([{ sku: 'H15', product: 'Adamax 10mg' }, { sku: 'h-15', product: 'Adamax 10mg' }], [image('H15.png')]);
  assert.ok(evaluateRecords(duplicate).entries.every(entry => entry.issues.some(issue => issue.code === 'DUPLICATE_SKU')));
});

test('formula/merge provenance survives partial or image-only saves and resolves only full identity review', () => {
  for (const error of ['Formula in a selected identity column.', 'Ambiguous merged identity cells.', 'Missing SKU or Product.']) {
    const picture = image('ADA10.png'), value = records([{ sku: 'ADA10', product: 'Adamax 10mg', error }], [picture]), id = value.entries[0].id;
    for (const patch of [{ changes: { sku: 'ADA10' } }, { changes: { hold: false } }, { changes: {}, image: { assetId: picture.id } }]) {
      const result = applyCorrection(value, id, { expectedRevision: nonce(), ...patch });
      assert.equal(evaluateRecords(result).products.length, 0); assert.equal(result.entries[0].reviewed, false);
    }
    const reviewed = applyCorrection(value, id, { expectedRevision: nonce(), changes: { ...value.entries[0].values } });
    assert.equal(evaluateRecords(reviewed).products.length, 1); assert.deepEqual(reviewed.entries[0].raw, value.entries[0].raw);
  }
});

test('invalid/incomplete corrections persist blocked, image choice is explicit and unknown flags are rejected', () => {
  const images = [image('folder/ADA10.png'), image('other/ADA10.png', 'b')], value = records([{ sku: 'ADA10', product: 'Adamax 10mg' }], images), id = value.entries[0].id;
  assert.equal(evaluateRecords(value).entries[0].issues[0].code, 'IMAGE_CONFLICT');
  const chosen = applyCorrection(value, id, { expectedRevision: nonce(), changes: {}, image: { assetId: images[1].id } });
  assert.equal(evaluateRecords(chosen).products.length, 1);
  const invalid = applyCorrection(chosen, id, { expectedRevision: nonce(), changes: { sku: '', product: 'Unknown' }, image: null });
  assert.equal(evaluateRecords(invalid).entries[0].status, 'blocked'); assert.equal(invalid.entries[0].imageId, null);
  for (const input of [{ changes: { ready: true } }, { changes: {}, image: { path: '../picture.png' } }, { changes: {}, image: { assetId: nonce() } }]) assert.throws(() => applyCorrection(value, id, { expectedRevision: nonce(), ...input }), error => error.status === 400);
});

test('10000 retained rows use bounded collision probes', () => {
  const value = records(Array.from({ length: 10000 }, (_, index) => ({ row: index + 1, sku: 'X' + index, product: 'Adamax 10mg' })));
  const started = performance.now(), result = evaluateRecords(value);
  assert.equal(result.entries.length, 10000); assert.ok(performance.now() - started < 5000, 'bounded linear validation should finish within five seconds');
});

test('immutable ledger round trips, cache isolates caller/revisions and detects same-length asset tampering', async t => {
  const store = await mkdtemp(path.join(tmpdir(), 'catalog-records-')); t.after(() => rm(store, { recursive: true, force: true }));
  const bytes = await readFile(new URL('../templates/coa/assets/sample-vial-product.png', import.meta.url)), source = path.join(store, 'source.png'); await writeFile(source, bytes);
  const picture = { id: nonce(), filename: 'ADA10.png', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, value = records([{ sku: 'ADA10', product: 'Adamax 10mg' }], [picture]), first = nonce();
  const saved = await writeCatalogRecords(store, first, value, [{ ...picture, path: source }]); assert.equal(saved.products.length, 1);
  saved.records.entries[0].values.sku = 'MUTATED'; assert.equal((await readCatalogRecords(store, first)).records.entries[0].values.sku, 'ADA10');
  const changed = applyCorrection(value, value.entries[0].id, { expectedRevision: first, changes: { hold: true } }), second = nonce();
  await writeCatalogRecords(store, second, changed, [{ ...picture, path: source }]);
  assert.equal((await readCatalogRecords(store, first)).products.length, 1); assert.equal((await readCatalogRecords(store, second)).products.length, 0);
  const target = path.join(store, 'customer-imports/revisions', first, 'images', picture.id + '.png'), corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1; await writeFile(target, corrupt);
  await assert.rejects(readCatalogRecords(store, first), /unavailable/); assert.equal((await readCatalogRecords(store, second)).entries.length, 1);
});

test('symlink/reparse image sources are rejected before a revision can be activated', async t => {
  const store = await mkdtemp(path.join(tmpdir(), 'catalog-links-')); t.after(() => rm(store, { recursive: true, force: true }));
  const outside = path.join(store, 'outside.png'), redirected = path.join(store, 'redirect.png'); await writeFile(outside, 'x');
  try { await symlink(outside, redirected); } catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error; t.diagnostic('File symlink privilege unavailable'); return; }
  const picture = { id: nonce(), filename: 'ADA10.png', sha256: createHash('sha256').update('x').digest('hex'), bytes: 1 }, value = records([{ sku: 'ADA10', product: 'Adamax 10mg' }], [picture]);
  await assert.rejects(writeCatalogRecords(store, nonce(), value, [{ ...picture, path: redirected }]), /unavailable/);
});

test('persisted parser provenance remains blocked after reload and unchanged full-field manual review is explicit', async t => {
  const store = await mkdtemp(path.join(tmpdir(), 'catalog-provenance-')); t.after(() => rm(store, { recursive: true, force: true }));
  const value = records([{ sku: 'ADA10', product: 'Adamax 10mg', error: 'Formula in a selected identity column.' }]), revision = nonce();
  await writeCatalogRecords(store, revision, value, []);
  const loaded = await readCatalogRecords(store, revision), selected = loaded.entries[0];
  assert.ok(selected.issues.some(issue => issue.code === 'SOURCE_FORMULA')); assert.equal(selected.reviewed, false);
  const reviewed = applyCorrection(loaded.records, selected.id, { expectedRevision: revision, changes: { ...selected.values } }), second = nonce();
  await writeCatalogRecords(store, second, reviewed, []);
  const saved = await readCatalogRecords(store, second); assert.equal(saved.entries[0].reviewed, true); assert.deepEqual(saved.entries[0].raw, selected.raw);
  assert.equal(saved.entries[0].issues.some(issue => issue.code === 'SOURCE_FORMULA'), false); assert.equal(saved.entries[0].issues.some(issue => issue.code === 'MISSING_IMAGE'), true);
});

test('same-parent images directory junction is rejected even when all redirected bytes and hashes are valid', async t => {
  const store = await mkdtemp(path.join(tmpdir(), 'catalog-internal-junction-')); t.after(() => rm(store, { recursive: true, force: true }));
  const bytes = await readFile(new URL('../templates/coa/assets/sample-vial-product.png', import.meta.url)), source = path.join(store, 'source.png'); await writeFile(source, bytes);
  const picture = { id: nonce(), filename: 'ADA10.png', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, value = records([{ sku: 'ADA10', product: 'Adamax 10mg' }], [picture]), revision = nonce();
  await writeCatalogRecords(store, revision, value, [{ ...picture, path: source }]);
  const folder = path.join(store, 'customer-imports/revisions', revision), images = path.join(folder, 'images'), sibling = path.join(folder, 'original-images'); await rename(images, sibling);
  await symlink(sibling, images, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readCatalogRecords(store, revision), /unavailable/);
});
