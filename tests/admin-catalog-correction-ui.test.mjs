import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCatalogCorrectionUI, catalogPickerState, filterCatalogEntries, boundedJSON } from '../conference/catalog-correction-ui.mjs';
import { createAdminI18n } from '../conference/admin-i18n.mjs';

const id = n => n.toString(16).padStart(20, '0'), rev = n => n.toString(16).padStart(32, '0');
const image = { id: rev(10), filename: 'ADA10.png', url: '/admin/catalog-assets/customer/' + rev(10) };
const entry = (n, extra = {}) => ({ id: id(n), source: { sheet: 'Products', row: n + 1 }, raw: { sku: 'ADA' + n, product: 'Adamax', dose: '10mg*10vials' }, values: { sku: 'ADA' + n, product: 'Adamax 10mg', dose: '10mg' }, hold: false, status: 'blocked', issues: [{ code: 'MISSING_IMAGE', message: 'static safe issue' }], image: null, ...extra });
const ok = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
const fail = (status, error) => ({ ok: false, status, json: async () => ({ error }) });
function fixture(request, entries = [entry(1)], extra = {}) {
  const nodes = new Map(); let context = { customerId: 'customer', customerName: 'Brand A', token: 'test-token', catalogRevision: rev(1), entries }, saved = [];
  const document = { activeElement: null, getElementById: value => node(value.replace(/^catalog-/, '')) };
  function node(name) {
    if (!nodes.has(name)) nodes.set(name, { id: 'catalog-' + name, value: '', hidden: false, disabled: false, files: [], checked: false, attrs: {}, events: new Map(), classList: { toggle() {} }, textContent: '', innerHTML: '', isConnected: true,
      addEventListener(type, fn) { this.events.set(type, fn); }, setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this[name]; }, focus() { document.activeElement = this; }, showModal() { this.open = true; }, close() { this.open = false; }, reset() {} });
    return nodes.get(name);
  }
  const language = createAdminI18n(), ui = createCatalogCorrectionUI({ document, request, context: () => context, onSaved(value) { saved.push(value); context = { ...context, entries: value.entries, catalogRevision: value.catalogRevision }; }, language, readFile: async () => 'data:image/png;base64,dGVzdA==', ...extra });
  language.subscribe(() => ui.applyLanguage());
  return { ui, node, nodes, document, saved, language, context: next => context = next, current: () => context };
}
function adapter(start = [entry(1)]) {
  let entries = structuredClone(start), revision = rev(1); const calls = [], uploads = [], jobs = new Map();
  async function request(url, options) {
    calls.push({ url, options, body: options.body && typeof options.body === 'string' ? JSON.parse(options.body) : undefined });
    const body = calls.at(-1).body;
    if (url === '/admin/api/imports') { const job = rev(jobs.size + 20); jobs.set(job, { body }); return ok({ id: job }); }
    if (url.endsWith('/files')) return ok({ id: rev(50) });
    if (options.method === 'PUT') { uploads.push(await options.body.arrayBuffer()); return ok({}); }
    const row = entries.find(row => url.endsWith('/' + row.id));
    if (!row) return fail(404, 'Catalog entry is unavailable.');
    if (options.method === 'GET') return ok({ catalogRevision: revision, entry: row, images: [image] });
    if (body.expectedRevision !== revision) return fail(409, 'Catalog changed. Reload products before saving corrections.');
    row.values = { ...body.changes }; delete row.values.hold; row.hold = body.changes.hold;
    if (Object.hasOwn(body, 'image')) row.image = body.image ? image : null;
    row.status = row.image && row.values.sku && !row.hold ? 'ready' : 'blocked'; row.issues = row.status === 'ready' ? [] : [{ code: row.hold ? 'HELD' : 'MISSING_IMAGE' }];
    revision = rev(Number.parseInt(revision, 16) + 1);
    return ok({ catalogRevision: revision, entries, entry: row, products: row.status === 'ready' ? [{ id: row.id, sku: row.values.sku, status: 'ready', name: row.values.product }] : [], counts: { total: entries.length, ready: entries.filter(row => row.status === 'ready').length, blocked: entries.filter(row => row.status !== 'ready').length } });
  }
  return { request, calls, uploads, changeRevision() { revision = rev(99); } };
}

test('blocked exact SKU owns search instead of selecting a nearby ready unit-qualified SKU; held rows release ownership', () => {
  const product = { id: 'adamax', name: 'Adamax 10mg', components: [{ name: 'Adamax', nominal: 10, unit: 'mg' }], unit: 'mg', aliases: { skus: ['ADA10'], families: ['ADA'] }, status: 'ready' };
  const reserved = entry(1, { values: { sku: 'ADA10mg', product: 'Unknown', dose: '' } });
  assert.equal(catalogPickerState([product], [reserved], 'ADA10mg').chosen, '');
  assert.deepEqual(catalogPickerState([product], [reserved], 'ADA10mg').ready, []);
  assert.equal(catalogPickerState([product], [{ ...reserved, hold: true }], 'ADA10mg').ready.length, 1);
  assert.equal(catalogPickerState([], [reserved], 'ADA10mg').chosen, '');
  assert.equal(filterCatalogEntries([reserved], 'unknown')[0].id, reserved.id);
  for (const query of ['ADA-10mg', 'aDa 10 MG', 'ＡＤＡ１０ｍｇ', 'ADA—10mg', 'A D A 1 0 m g']) {
    const state = catalogPickerState([product], [reserved], query);
    assert.equal(state.ready.length, 0, query); assert.equal(state.chosen, '', query); assert.equal(state.blocked[0].id, reserved.id, query);
    const held = catalogPickerState([product], [{ ...reserved, hold: true }], query);
    assert.equal(held.ready.length, 1, query); assert.equal(held.chosen, product.id, query); assert.equal(held.blocked[0].id, reserved.id, query);
  }
});

test('real modal controller preserves raw fields, permits blocked partial save, then makes explicit image correction ready', async () => {
  const api = adapter(), app = fixture(api.request), trigger = app.node('trigger');
  await app.ui.open(id(1), trigger);
  assert.equal(app.node('raw-dose').textContent, '10mg*10vials');
  app.node('sku').value = '';
  await app.ui.save();
  assert.equal(app.saved.length, 1); assert.equal(app.saved[0].entry.status, 'blocked'); assert.match(app.node('message').textContent, /still needs correction/);
  const first = api.calls.find(row => row.options.method === 'PATCH');
  assert.deepEqual(first.body.changes, { sku: '', product: 'Adamax 10mg', dose: '10mg', hold: false }); assert.equal(Object.hasOwn(first.body, 'image'), false);
  app.node('sku').value = 'ADA10'; app.node('image').value = image.id; app.node('image').events.get('change')();
  await app.ui.save();
  assert.equal(app.saved.at(-1).entry.status, 'ready'); assert.equal(api.calls.at(-1).body.expectedRevision, rev(2)); assert.deepEqual(api.calls.at(-1).body.image, { assetId: image.id });
  assert.equal(app.node('raw-sku').textContent, 'ADA1'); app.ui.close(); assert.equal(app.document.activeElement, trigger); assert.equal(app.node('dialog').open, false);
});

test('locale switches and revision conflict preserve typed values and File; explicit reload offers deliberate restoration', async () => {
  const api = adapter(), app = fixture(api.request), picture = { name: 'ADA10.png', size: 600000, slice: (a, b) => new Blob([Buffer.alloc(Math.min(b, 600000) - a)]) };
  await app.ui.open(id(1)); app.node('sku').value = 'ADA10'; app.node('product').value = 'Reviewed Adamax 10mg'; app.node('image-upload').files = [picture]; await app.ui.chooseFile();
  app.node('product').focus(); app.language.setLocale('zh-CN');
  assert.match(app.node('dialog-title').textContent,/处理异常 · Brand A/);assert.equal(app.node('filter').value,'blocked');
  assert.equal(app.node('product').value, 'Reviewed Adamax 10mg'); assert.equal(app.node('image-upload').files[0], picture); assert.equal(app.document.activeElement, app.node('product')); assert.match(app.node('image-preview').src, /^data:/);
  api.changeRevision(); await app.ui.save();
  assert.equal(app.saved.length, 0); assert.equal(app.node('sku').value, 'ADA10'); assert.equal(app.node('image-upload').files[0], picture); assert.equal(app.node('reload').hidden, false); assert.equal(app.node('fields').disabled, false);
  assert.equal(api.uploads.length, 3); assert.ok(api.uploads.every(buffer => buffer.byteLength <= 256 * 1024));
  await app.ui.reload(); assert.equal(app.node('sku').value, 'ADA1'); assert.equal(app.node('unsaved').hidden, false);
  app.node('restore-edits').events.get('click')(); assert.equal(app.node('sku').value, 'ADA10'); assert.equal(app.node('product').value, 'Reviewed Adamax 10mg'); assert.match(app.node('image-preview').src, /^data:/);
  await app.ui.save(); assert.equal(app.saved.at(-1).entry.status, 'ready'); assert.equal(api.calls.at(-1).body.expectedRevision, rev(99));
});

test('brand-scoped modal defaults to blocked entries, retains all/ready tools and shows a clear zero-issue state', async () => {
  const rows=[entry(1),entry(2,{status:'ready',issues:[]})],app=fixture(async()=>ok({}),rows);
  await app.ui.open();assert.equal(app.node('filter').value,'blocked');assert.equal(app.node('dialog-title').textContent,'Resolve issues · Brand A');assert.match(app.node('dialog-intro').textContent,/Brand A: 1/);assert.match(app.node('record-list').innerHTML,/ADA1/);assert.doesNotMatch(app.node('record-list').innerHTML,/ADA2/);
  app.node('filter').value='all';app.node('filter').events.get('change')();assert.match(app.node('record-list').innerHTML,/ADA1/);assert.match(app.node('record-list').innerHTML,/ADA2/);
  app.node('filter').value='ready';app.node('filter').events.get('change')();assert.doesNotMatch(app.node('record-list').innerHTML,/ADA1/);assert.match(app.node('record-list').innerHTML,/ADA2/);
  app.context({customerId:'brand-b',customerName:'Brand B <scope>',token:'test-token',catalogRevision:rev(2),entries:[rows[1]]});app.ui.refresh();assert.equal(app.node('dialog').open,false);
  await app.ui.open();assert.equal(app.node('filter').value,'blocked');assert.equal(app.node('dialog-title').textContent,'Resolve issues · Brand B <scope>');assert.match(app.node('dialog-intro').textContent,/no entries need correction/);assert.match(app.node('record-list').innerHTML,/No entries need correction/);assert.doesNotMatch(app.node('record-list').innerHTML,/data-entry-id=/);
  app.language.setLocale('zh-CN');assert.equal(app.node('dialog-title').textContent,'处理异常 · Brand B <scope>');assert.match(app.node('record-list').innerHTML,/没有待处理异常/);
});

test('late detail/save responses cannot update a closed modal, switched customer or superseded selection', async () => {
  let detail, patch; const rows = [entry(1), entry(2)];
  const app = fixture(async (url, options) => options.method === 'PATCH' ? new Promise(resolve => patch = resolve) : url.endsWith(id(1)) ? new Promise(resolve => detail = resolve) : ok({ catalogRevision: rev(1), entry: rows[1], images: [] }), rows);
  const old = app.ui.open(id(1)); app.ui.close(); await app.ui.open(id(2)); detail(ok({ catalogRevision: rev(1), entry: rows[0], images: [] })); await old;
  assert.equal(app.node('sku').value, 'ADA2');
  const save = app.ui.save(); app.context({ customerId: 'new-customer', token: 'test-token', entries: [] }); app.ui.refresh();
  patch(ok({ catalogRevision: rev(2), entry: rows[1], entries: rows, products: [] })); await save;
  assert.equal(app.saved.length, 0); assert.equal(app.node('dialog').open, false);
});

test('bounded requests clear busy state despite fetch ignoring abort; uncertain PATCH retries the exact payload', async () => {
  await assert.rejects(boundedJSON(() => new Promise(() => {}), '/synthetic', {}, 5), /timed out/);
  const calls = []; let patches = 0;
  const app = fixture(async (_url, options) => { if (options.method === 'GET') return ok({ catalogRevision: rev(1), entry: entry(1), images: [] }); calls.push(options.body); if (++patches === 1) return new Promise(() => {}); return ok({ catalogRevision: rev(2), entry: entry(1), entries: [entry(1)], products: [] }); }, [entry(1)], { timeout: 5 });
  await app.ui.open(id(1)); app.node('sku').value = 'TRY1'; await app.ui.save();
  assert.equal(app.node('dialog').attrs['aria-busy'], 'false'); assert.equal(app.node('save').disabled, false); assert.equal(app.node('fields').disabled, true);
  await app.ui.save(); assert.equal(calls[0], calls[1]); assert.equal(app.saved.length, 1); assert.equal(app.node('fields').disabled, false);
});

test('all retained entries remain reachable through pagination and text search, with native dialog outside existing forms', async () => {
  const rows = Array.from({ length: 601 }, (_, n) => entry(n + 1)); const app = fixture(async () => ok({}), rows);
  await app.ui.open(); assert.match(app.node('record-count').textContent, /601/); assert.doesNotMatch(app.node('record-list').innerHTML, /ADA601/);
  app.node('search').value = 'ADA601'; app.node('search').events.get('input')(); assert.match(app.node('record-list').innerHTML, /ADA601/);
  app.node('search').value = ''; app.node('search').events.get('input')(); for (let n = 0; n < 30; n++) app.node('next').events.get('click')(); assert.match(app.node('record-list').innerHTML, /ADA601/); assert.equal(app.node('next').disabled, true);
  const html = await readFile(new URL('../conference/operator.html', import.meta.url), 'utf8'), css = await readFile(new URL('../conference/operator.css', import.meta.url), 'utf8');
  assert.ok(html.indexOf('<dialog') > html.indexOf('</main>')); assert.match(html, /<dialog[^>]+aria-labelledby="catalog-dialog-title"/); assert.doesNotMatch(css, /button:disabled\{[^}]*cursor:wait/); assert.match(css, /max-width:700px/);
});

function uploadAdapter({ failPut = false, commitLostPut = false, uncertainPatch = false, quota = false, lostCreates = 0, missedCreates = 0 } = {}) {
  const calls = [], jobs = new Map(), intents = new Map(), row = entry(1); let created = 0, patches = 0, deletes = 0, puts = 0, createCalls = 0;
  const request = async (url, options) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null; calls.push({ url, options, body });
    if (url === '/admin/api/imports') {
      createCalls++; if (createCalls <= missedCreates) throw new Error('Failed to fetch');
      let jobId = intents.get(body.uploadIntent);
      if (jobId && !jobs.has(jobId)) return fail(409, 'Correction upload is unavailable. Choose the image again.');
      if (!jobId) { if (quota || jobs.size >= 4) return fail(409, 'Four imports are already pending. Cancel one or wait for expiry.'); jobId = rev(++created + 50); jobs.set(jobId, { id: jobId, files: [] }); intents.set(body.uploadIntent, jobId); }
      if (createCalls <= lostCreates) throw new Error('Failed to fetch'); return ok({ id: jobId });
    }
    const match = /^\/admin\/api\/imports\/([a-f0-9]{32})(.*)$/.exec(url);
    if (match) {
      const job = jobs.get(match[1]); if (!job) return fail(404, 'Import job is unavailable or expired.');
      if (options.method === 'DELETE') { deletes++; jobs.delete(job.id); return ok({ ok: true }); }
      if (options.method === 'GET') return ok(job);
      if (options.method === 'POST') { const registered = { id: rev(91), kind: 'image', path: body.path, size: body.size, offset: 0 }; job.files.push(registered); return ok(registered); }
      if (options.method === 'PUT') { puts++; if (commitLostPut && puts === 1) { job.files[0].offset += options.body.size; throw new Error('Failed to fetch'); } if (failPut) throw new Error('Failed to fetch'); job.files[0].offset += options.body.size; return ok({}); }
    }
    if (options.method === 'GET') return ok({ entry: row, catalogRevision: rev(1), images: [] });
    patches++; if (uncertainPatch && patches === 1) return new Promise(() => {});
    return ok({ entry: { ...row, values: body.changes, image, status: 'ready', issues: [] }, catalogRevision: rev(2), entries: [row], products: [] });
  };
  return { request, jobs, calls, get created() { return created; }, get deletes() { return deletes; }, get puts() { return puts; } };
}
async function attachImage(app, name = 'ADA10.png') {
  const picture = { name, size: 20, slice: (a, b) => new Blob([Buffer.alloc(Math.min(b, 20) - a)]) }; app.node('image-upload').files = [picture]; await app.ui.chooseFile(); return picture;
}

test('five interrupted PUT retries reconcile and reuse one upload job instead of consuming the four-job quota', async () => {
  const api = uploadAdapter({ failPut: true }), app = fixture(api.request, [entry(1)], { wait: async () => {} });
  await app.ui.open(id(1)); app.node('sku').value = 'REVIEWED1'; const picture = await attachImage(app);
  for (let n = 0; n < 5; n++) await app.ui.save();
  assert.equal(api.created, 1); assert.equal(api.jobs.size, 1); assert.equal(api.puts, 5); assert.equal(api.calls.filter(call => call.options.method === 'GET' && call.url.includes('/imports/')).length, 4);
  assert.equal(app.node('sku').value, 'REVIEWED1'); assert.equal(app.node('image-upload').files[0], picture); assert.doesNotMatch(app.node('message').textContent, /catalog changed/i);
  app.ui.close(); await app.ui.cleanup(); assert.equal(api.deletes, 1); assert.equal(api.jobs.size, 0);
});

test('lost chunk acknowledgement reads the server offset and never appends the same bytes twice', async () => {
  const api = uploadAdapter({ commitLostPut: true }), app = fixture(api.request); await app.ui.open(id(1)); await attachImage(app);
  await app.ui.save(); await app.ui.save(); assert.equal(api.created, 1); assert.equal(api.puts, 1); assert.equal(app.saved.length, 1); assert.equal(api.calls.at(-1).body.image.fileId, rev(91));
});

test('clear, remove, replace and close release only their known pre-PATCH image upload', async () => {
  for (const action of ['clear-upload', 'remove-image', 'replace', 'close']) {
    const api = uploadAdapter({ failPut: true }), app = fixture(api.request); await app.ui.open(id(1)); await attachImage(app); await app.ui.save();
    if (action === 'replace') await attachImage(app, 'NEW.png'); else if (action === 'close') app.ui.close(); else app.node(action).events.get('click')();
    await app.ui.cleanup(); assert.equal(api.jobs.size, 0, action); assert.equal(api.deletes, 1, action);
  }
});

test('closing during create or registration cleans its late known job without applying a closed response', async () => {
  for (const phase of ['creating', 'registering']) {
    let release, entered; const started = new Promise(resolve => entered = resolve), calls = []; let busy = false;
    const app = fixture(async (url, options) => {
      calls.push([url, options.method]);
      if (url === '/admin/api/imports') { if (phase === 'creating') { entered(); return new Promise(resolve => release = resolve); } return ok({ id: rev(60) }); }
      if (url.endsWith('/files')) { entered(); busy = true; return new Promise(resolve => release = value => { busy = false; resolve(value); }); }
      if (options.method === 'DELETE') return busy ? fail(409, 'Import is busy. Wait for the current operation.') : ok({ ok: true });
      return ok({ entry: entry(1), catalogRevision: rev(1), images: [] });
    }, [entry(1)], { wait: async () => {} });
    await app.ui.open(id(1)); await attachImage(app); const save = app.ui.save(); await started; app.ui.close(); release(ok(phase === 'creating' ? { id: rev(60) } : { id: rev(91), offset: 0 })); await save; await app.ui.cleanup();
    assert.ok(calls.some(([url, method]) => url.endsWith(rev(60)) && method === 'DELETE'), phase); assert.equal(calls.some(([, method]) => method === 'PATCH' || method === 'PUT'), false, phase); assert.equal(app.saved.length, 0); assert.equal(app.node('dialog').open, false);
  }
});

test('cleanup busy retries are bounded, retain targeted recovery and never reopen a closed dialog', async () => {
  const api = uploadAdapter({ failPut: true }); let blocked = true, deletes = 0;
  const app = fixture(async (url, options) => { if (options.method === 'DELETE') { deletes++; if (blocked) return fail(409, 'Import is busy. Wait for the current operation.'); } return api.request(url, options); }, [entry(1)], { cleanupAttempts: 2, wait: async () => {} });
  await app.ui.open(id(1)); await attachImage(app); await app.ui.save(); app.ui.close();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(deletes, 2); assert.equal(app.node('dialog').open, false); assert.equal(api.jobs.size, 1);
  blocked = false; assert.equal(await app.ui.cleanup(), true); assert.equal(api.jobs.size, 0); assert.equal(app.node('dialog').open, false);
});

test('an uncertain PATCH keeps its exact image reference across close/reopen and is never cleaned as an unused upload', async () => {
  const api = uploadAdapter({ uncertainPatch: true }), app = fixture(api.request, [entry(1)], { timeout: 5 }); await app.ui.open(id(1)); app.node('sku').value = 'UNCHANGED-RETRY'; await attachImage(app); await app.ui.save();
  const first = api.calls.find(call => call.options.method === 'PATCH').options.body; app.ui.close(); await app.ui.cleanup(); assert.equal(api.deletes, 0);
  await app.ui.open(id(1)); assert.equal(app.node('sku').value, 'UNCHANGED-RETRY'); assert.equal(app.node('fields').disabled, true); await app.ui.save();
  const patches = api.calls.filter(call => call.options.method === 'PATCH'); assert.equal(patches[1].options.body, first); assert.equal(api.created, 1); assert.equal(api.deletes, 0); assert.equal(app.saved.length, 1);
});

test('upload quota 409 has an upload-specific recovery message, not a stale-catalog message', async () => {
  const api = uploadAdapter({ quota: true }), app = fixture(api.request); await app.ui.open(id(1)); await attachImage(app); await app.ui.save();
  assert.match(app.node('message').textContent, /Four uploads/); assert.doesNotMatch(app.node('message').textContent, /catalog changed/i); assert.equal(app.node('reload').hidden, true); assert.equal(app.node('fields').disabled, false);
});

test('modal locale updates derived source and empty-image labels without changing selection, edits, files or focus', async () => {
  const api = adapter(), app = fixture(api.request); await app.ui.open(id(1)); app.node('sku').value = 'MY-EDIT'; const picture = await attachImage(app), empty = { textContent: '' }; app.node('image').options = [empty]; app.node('image').value = image.id; app.node('sku').focus();
  app.language.setLocale('zh-CN'); assert.match(app.node('source-line').textContent, /第 2 行/); assert.equal(empty.textContent, '未选择图片');
  app.language.setLocale('en'); assert.equal(app.node('source-line').textContent, 'Products · row 2'); assert.equal(empty.textContent, 'No image'); assert.equal(app.node('image').value, image.id); assert.equal(app.node('image-upload').files[0], picture); assert.equal(app.node('sku').value, 'MY-EDIT'); assert.equal(app.document.activeElement, app.node('sku'));
});

test('true lost create ACK retries one cryptographic intent five times and close reconciles then cancels only that job', async () => {
  const api = uploadAdapter({ lostCreates: 5 }), app = fixture(api.request, [entry(1)], { wait: async () => {} }); await app.ui.open(id(1)); app.node('sku').value = 'PRESERVED'; const picture = await attachImage(app);
  for (let n = 0; n < 5; n++) await app.ui.save();
  const bodies = api.calls.filter(call => call.url === '/admin/api/imports').map(call => call.body);
  assert.equal(bodies.length, 5); assert.match(bodies[0].uploadIntent, /^[a-f0-9]{32}$/); assert.ok(bodies.every(body => JSON.stringify(body) === JSON.stringify(bodies[0]))); assert.equal(api.created, 1); assert.equal(api.jobs.size, 1);
  assert.equal(app.node('sku').value, 'PRESERVED'); assert.equal(app.node('image-upload').files[0], picture); assert.equal(app.node('dialog').attrs['aria-busy'], 'false'); assert.equal(app.node('save').disabled, false);
  app.ui.close(); await app.ui.cleanup(); assert.equal(api.created, 1); assert.equal(api.deletes, 1); assert.equal(api.jobs.size, 0); assert.deepEqual(api.calls.filter(call => call.url === '/admin/api/imports').at(-1).body, bodies[0]);
});

test('replacement reconciles a lost creation before using a fresh intent, and close cancels a never-reached creation safely', async () => {
  const api = uploadAdapter({ lostCreates: 1 }), app = fixture(api.request, [entry(1)], { wait: async () => {} }); await app.ui.open(id(1)); await attachImage(app); await app.ui.save(); const oldIntent = api.calls.find(call => call.url === '/admin/api/imports').body.uploadIntent;
  await attachImage(app, 'REPLACEMENT.png'); await app.ui.save();
  const creates = api.calls.filter(call => call.url === '/admin/api/imports'); assert.equal(api.deletes, 1); assert.equal(api.created, 2); assert.equal(creates[1].body.uploadIntent, oldIntent); assert.notEqual(creates.at(-1).body.uploadIntent, oldIntent); assert.equal(app.saved.length, 1);
  const missed = uploadAdapter({ missedCreates: 1 }), closed = fixture(missed.request, [entry(1)], { wait: async () => {} }); await closed.ui.open(id(1)); await attachImage(closed); await closed.ui.save(); assert.equal(missed.created, 0); closed.ui.close(); await closed.ui.cleanup(); assert.equal(missed.created, 1); assert.equal(missed.deletes, 1); assert.equal(missed.jobs.size, 0);
});
