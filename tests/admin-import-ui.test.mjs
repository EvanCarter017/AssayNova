import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createImportUI } from '../conference/import-ui.mjs';
import { createAdminI18n } from '../conference/admin-i18n.mjs';

const jobId = 'a'.repeat(32), ok = value => ({ ok: true, status: 200, json: async () => value });
const inspection = { sheets: ['Table'], sheet: 'Table', headerRow: 3, columns: [{ id: 'A', label: 'ProductName' }, { id: 'B', label: 'Note' }, { id: 'C', label: 'ShortCode' }] };
const matching = { rows: [{ row: 4, sku: 'ADA10', product: 'Adamax 10mg', status: 'valid', reason: '' }], imageRows: [{ path: 'pictures/ADA10.png', status: 'valid', reason: '' }], counts: { valid: 1, unmatched: 0, conflict: 0, duplicate: 0, images: 1, unmatchedImages: 0 }, canConfirm: true };
function file(name, bytes, relative = '') {
  const blob = new Blob([bytes]); return { name, size: blob.size, webkitRelativePath: relative, slice: (start, end) => blob.slice(start, end) };
}
function fixture(request, extra = {}) {
  const nodes = new Map(), pending = [], confirmed = []; let current = { customerId: 'old-customer', token: 'fixture-token' };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id: 'import-' + id, value: '', files: [], disabled: false, hidden: false, innerHTML: '', textContent: '', events: new Map(), classList: { toggle() {} }, addEventListener(type, callback) { this.events.set(type, callback); }, focus() { this.focused = true; } });
    return nodes.get(id);
  };
  node('target').value = 'current';
  const language = createAdminI18n({ browserLanguage: 'en' });
  const ui = createImportUI({ document: { getElementById: id => node(id.slice(7)) }, request, context: () => current, setPending: value => pending.push(value), onConfirmed: value => confirmed.push(value), language, wait: async () => {}, ...extra });
  language.subscribe(() => ui.applyLanguage());
  return { ui, node, nodes, pending, confirmed, language, context: value => current = value };
}

test('actual importer chunks files, captures only two mapped columns, and preserves file/mapping/progress state across locale changes', async () => {
  const calls = [], chunks = []; let fileNumber = 0, previewResolve;
  const app = fixture(async (url, settings) => {
    calls.push([url, settings]);
    if (url === '/admin/api/imports') return ok({ id: jobId });
    if (url.endsWith('/files')) return ok({ id: (++fileNumber).toString(16).padStart(32, '0') });
    if (settings.method === 'PUT') { chunks.push({ url, bytes: Buffer.from(await settings.body.arrayBuffer()) }); return ok({}); }
    if (url.endsWith('/inspect')) return ok(inspection);
    if (url.endsWith('/preview')) return new Promise(resolve => previewResolve = resolve);
    if (url.endsWith('/confirm')) return ok({ customers: [{ id: 'new', name: 'Aster' }], customer: { id: 'new', name: 'Aster' }, products: [{ id: 'adamax' }] });
    throw new Error('Unexpected request');
  });
  const picture = Buffer.alloc(600000, 17), sheet = Buffer.from('ProductName,ShortCode\nAdamax 10mg,ADA10\n');
  app.node('target').value = 'new'; app.node('name').value = 'Aster'; app.node('folder').files = [file('ADA10.png', picture, 'pictures/ADA10.png')]; app.node('sheet').files = [file('reordered.csv', sheet)];
  app.node('folder').value = 'selected-folder'; app.node('sheet').value = 'selected-table';
  await app.ui.start({ preventDefault() {} });
  assert.deepEqual(JSON.parse(calls[0][1].body), { name: 'Aster' }); assert.equal(chunks.length, 4); assert.deepEqual(Buffer.concat(chunks.slice(0, 3).map(chunk => chunk.bytes)), picture);
  assert.ok(chunks.every(chunk => chunk.bytes.length <= 256 * 1024)); assert.match(chunks[1].url, /offset=262144$/); assert.equal(app.node('progress').value, picture.length + sheet.length);
  assert.equal(app.node('sku').value, 'C'); assert.equal(app.node('product').value, 'A'); assert.equal(app.node('header').value, '3');
  const callCount = calls.length, filesBefore = app.node('folder').files; app.language.setLocale('zh-CN');
  assert.equal(calls.length, callCount); assert.equal(app.node('folder').files, filesBefore); assert.equal(app.node('folder').value, 'selected-folder'); assert.equal(app.node('name').value, 'Aster'); assert.equal(app.node('sku').value, 'C'); assert.match(app.node('status').textContent, /上传完成/);
  const preview = app.ui.perform('preview'); assert.equal(app.node('confirm').disabled, true); assert.equal(app.node('cancel').disabled, false);
  const input = JSON.parse(calls.at(-1)[1].body); assert.deepEqual(input, { sheet: 'Table', headerRow: 3, columns: { sku: 'C', product: 'A' } });
  app.language.setLocale('en'); previewResolve(ok(matching)); await preview; assert.equal(app.node('confirm').disabled, false); assert.match(app.node('rows').innerHTML, /ADA10/);
  await app.ui.perform('confirm'); assert.equal(app.confirmed.length, 1); assert.deepEqual(app.pending, [true, false]); assert.equal(app.node('folder').value, ''); assert.equal(app.node('sheet').value, '');
});

test('cancel aborts in-flight chunks, retries a busy job, releases normal controls and prevents late preview application', async () => {
  let release, uploading; const entered = new Promise(resolve => uploading = resolve); let deletes = 0, writes = 0;
  const app = fixture(async (url, settings) => {
    if (url === '/admin/api/imports') return ok({ id: jobId });
    if (url.endsWith('/files')) return ok({ id: 'b'.repeat(32) });
    if (settings.method === 'PUT') {
      writes++; uploading(); return new Promise((resolve, reject) => { release = resolve; settings.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
    }
    if (settings.method === 'DELETE') { deletes++; return deletes === 1 ? { ok: false, status: 409, json: async () => ({ error: 'Import is busy. Wait for the current operation.' }) } : ok({ ok: true }); }
    throw new Error('Unexpected request');
  });
  app.node('folder').files = [file('ADA10.png', Buffer.alloc(500000))]; app.node('folder').value = 'selected-folder';
  const start = app.ui.start(); await entered; await app.ui.cancel(); release(ok({})); await start;
  assert.equal(deletes, 2); assert.equal(writes, 1); assert.deepEqual(app.pending, [true, false]); assert.equal(app.confirmed.length, 0); assert.equal(app.node('folder').value, 'selected-folder'); assert.equal(app.node('confirm').disabled, true); assert.match(app.node('status').textContent, /cancelled/);
});

test('context changes and backend failures cannot replace a newer customer or disclose raw paths', async () => {
  let finish;
  const app = fixture(async (url, settings) => {
    if (url === '/admin/api/imports') return ok({ id: jobId });
    if (url.endsWith('/files')) return ok({ id: 'b'.repeat(32) });
    if (settings.method === 'PUT') return ok({});
    if (url.endsWith('/inspect')) return ok(inspection);
    if (url.endsWith('/preview')) return new Promise(resolve => finish = resolve);
    if (settings.method === 'DELETE') return ok({});
    throw new Error('Unexpected request');
  });
  app.node('sheet').files = [file('mapping.csv', 'SKU,Product\nADA10,Adamax 10mg\n')]; await app.ui.start();
  const preview = app.ui.perform('preview'); app.context({ customerId: 'newer-customer', token: 'fixture-token' }); finish(ok(matching)); await preview;
  assert.equal(app.confirmed.length, 0); assert.equal(app.node('confirm').disabled, true); assert.match(app.node('status').textContent, /context changed/i); await app.ui.cancel();
  const failed = fixture(async () => ({ ok: false, status: 400, json: async () => ({ error: 'C:\\private\\credential.json at stack:14' }) })); failed.node('sheet').files = [file('mapping.csv', 'x')]; await failed.ui.start();
  assert.doesNotMatch(failed.node('status').textContent, /private|credential|stack/); assert.equal(failed.node('status').focused, true); assert.equal(failed.node('upload').disabled, false);
});

test('actual markup has sibling forms, shortcode filenames, exactly two required identity fields and no image mapping picker', async () => {
  const html = await readFile(new URL('../conference/operator.html', import.meta.url), 'utf8'); let depth = 0;
  for (const match of html.matchAll(/<\/?form\b[^>]*>/g)) { depth += match[0].startsWith('</') ? -1 : 1; assert.ok(depth >= 0 && depth <= 1); } assert.equal(depth, 0);
  assert.match(html, /webkitdirectory multiple/); assert.match(html, /ADA10\.png/); assert.match(html, /id="import-sku"/); assert.match(html, /id="import-product"/); assert.match(html, /id="import-dose"/);
  assert.doesNotMatch(html, /import-image-column|import-aliases-column|per-row|id="photo"/);
});
