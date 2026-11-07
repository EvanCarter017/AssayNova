import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestPage } from '../dist/request-page.js';
import { REQUEST_DRAFT_KEY, createRequestRecord, newSubmission } from '../dist/submission.js';

const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[key]);

// A small event/DOM adapter executes the real controller. Native layout, file
// rendering and focus visibility are independently checked in the browser.
function harness(options = {}) {
  let elements = [];
  let markup = '';
  let counter = 0;
  let focused;
  const scrolls = [];
  const events = new Map();
  const writes = [];
  const values = new Map(options.initial ? [[REQUEST_DRAFT_KEY, options.initial]] : []);
  const createdURLs = [];
  const revokedURLs = [];
  let htmlWrites = 0;
  let openedSaved = 0;
  const element = (tag, attributes, text = '') => {
    const attrs = new Map(attributes);
    const node = { tagName: tag.toUpperCase(), dataset: Object.fromEntries([...attrs].filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value])), id: attrs.get('id') || '', value: '', textContent: decode(text), innerHTML: '', files: [], disabled: attrs.has('disabled'), isConnected: true, children: [], parentElement: null,
      getAttribute: key => attrs.get(key) ?? null, hasAttribute: key => attrs.has(key), setAttribute: (key, value) => attrs.set(key, String(value)), removeAttribute: key => attrs.delete(key),
      focus() { focused = this.id; }, scrollIntoView(value) { scrolls.push({ id: this.id, ...value }); }, remove() { const disconnect = node => { node.isConnected = false; node.children.forEach(disconnect); }; disconnect(this); },
      matches(selector) { return selector.split(',').some(part => { part = part.trim(); if (part.startsWith('#')) return this.id === part.slice(1); if (part.startsWith('.')) return (attrs.get('class') || '').split(/\s+/).includes(part.slice(1)); const tests = [...part.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)]; return tests.length > 0 && tests.every(([, key, value]) => value === undefined ? attrs.has(key) : attrs.get(key) === value); }); },
      closest(selector) { for (let value = this; value; value = value.parentElement) if (value.matches(selector)) return value; return null; }
    };
    return node;
  };
  const root = {
    get innerHTML() { return markup; }, set innerHTML(value) {
      for (const node of elements) node.isConnected = false;
      elements = []; markup = value; htmlWrites++;
      const parents = [];
      for (const match of value.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
        if (match[1]) { const index = parents.findLastIndex(node => node.tagName.toLowerCase() === match[2]); if (index >= 0) parents.length = index; continue; }
        const attrs = [...match[3].matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)].map(([, key, value]) => [key, decode(value || '')]);
        const text = value.slice(match.index + match[0].length).split('<')[0];
        const node = element(match[2], attrs, text);
        if (parents.length) { node.parentElement = parents.at(-1); parents.at(-1).children.push(node); }
        elements.push(node);
        if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(match[2])) parents.push(node);
      }
      const summary = root.querySelector('#rq-summary-content');
      if (summary) summary.innerHTML = value.slice(value.indexOf('id="rq-summary-content"')).split('</aside>')[0];
    },
    querySelector: selector => elements.find(node => node.isConnected && node.matches(selector)) || null,
    querySelectorAll: selector => elements.filter(node => node.isConnected && node.matches(selector)),
    addEventListener(type, callback) { events.set(type, [...events.get(type) || [], callback]); },
    removeEventListener(type, callback) { events.set(type, (events.get(type) || []).filter(value => value !== callback)); }
  };
  const storage = { getItem(key) { if (options.readFailure) throw Error('Synthetic read restriction'); return values.get(key) ?? null; }, setItem(key, value) { if (options.writeFailure) throw Error('Synthetic write restriction'); writes.push([key, value]); if (!options.silentWrite) values.set(key, value); } };
  const config = { makeId: () => 'test-' + ++counter, now: options.now || (() => '2026-11-05T00:00:00.000Z'), openMyRequests: () => openedSaved++, accountEnabled: options.accountEnabled !== false, saveAccountRequest: options.saveAccountDraft || (async record => documentFor(record)), objectURLs: { createObjectURL(file) { const url = 'blob:synthetic-' + (createdURLs.length + 1); createdURLs.push({ url, file }); return url; }, revokeObjectURL(url) { revokedURLs.push(url); } } };
  if (!options.lazyStorage) config.storage = storage;
  const api = createRequestPage(root, config);
  if (options.accountUser !== null) api.setAccountSession(options.accountUser || userA);
  const emit = (type, target) => { for (const fn of events.get(type) || []) fn({ type, target, preventDefault() {} }); };
  const query = selector => { const node = root.querySelector(selector); assert.ok(node, 'Expected DOM control ' + selector); return node; };
  const click = selector => { const node = query(selector); if (!node.disabled) emit('click', node); };
  const field = key => query(`[data-rq-field="${key}"]`);
  return {
    api, root, events, values, writes, createdURLs, revokedURLs, scrolls,
    focused: () => focused, htmlWrites: () => htmlWrites, openedSaved: () => openedSaved,
    field, query, click,
    sampleIds: () => root.querySelectorAll('[data-rq-field]').map(node => node.dataset.rqField).filter(key => key.startsWith('sample:') && key.endsWith(':name')).map(key => key.split(':')[1]),
    input(key, value, type = 'input') { const node = field(key); node.value = value; emit(type, node); },
    submit() { emit('submit', query('#request-step-form')); },
    action(name, id) { click(`[data-rq-action="${name}"]${id ? `[data-rq-id="${id}"]` : ''}`); },
    step(number) { click(`[data-rq-step="${number}"]`); },
    file(id, file) { const node = query('#rq-file-' + id); node.files = [file]; emit('change', node); },
    destination(value) { const node = query('[data-rq-destination]'); node.value = value; emit('change', node); },
    start(service) { api.activate({ service }); return this; },
    contact() { this.input('name', 'Synthetic contact'); this.input('email', 'qa@example.invalid'); return this; },
    validReview() { this.start(); const id = this.sampleIds()[0]; this.input(`sample:${id}:name`, 'Synthetic sample'); this.submit(); this.contact(); this.submit(); return this; }
  };
}

test('request controller gates steps, validates focus and updates summary without rebuilding typed fields', () => {
  const h = harness().start('purity'); const id = h.sampleIds()[0];
  assert.equal(h.field(`sample:${id}:service`).value, 'purity');
  assert.equal(h.query('[data-rq-step="2"]').disabled, true);
  h.submit(); assert.equal(h.focused(), 'rq-sample-' + id + '-name');
  const field = h.field(`sample:${id}:name`); const count = h.htmlWrites();
  h.input(`sample:${id}:name`, '<Synthetic sample>'); h.input(`sample:${id}:quantity`, '3');
  assert.equal(h.htmlWrites(), count); assert.equal(h.field(`sample:${id}:name`), field);
  assert.match(h.query('#rq-summary-content').innerHTML, /&lt;Synthetic sample&gt;/);
  assert.match(h.query('#rq-summary-content').innerHTML, /3 planned units/);
  h.submit(); assert.equal(h.focused(), 'request-step-heading');
  assert.deepEqual(h.scrolls.at(-1), { id: 'request-step-heading', block: 'start', behavior: 'instant' });
  h.submit(); assert.equal(h.focused(), 'rq-name'); h.input('name', 'Contact'); h.input('email', 'invalid'); h.submit(); assert.equal(h.focused(), 'rq-email');
  h.input('email', 'qa@example.invalid'); h.submit(); assert.match(h.root.innerHTML, /Review your request/);
  h.step(1); assert.equal(h.field(`sample:${id}:name`).value, '<Synthetic sample>');
  assert.equal(h.writes.length, 0);
});

test('request controller adds/duplicates/removes entries with stable IDs, state and deliberate focus', () => {
  const h = harness().start(); const first = h.sampleIds()[0]; h.input(`sample:${first}:name`, 'Alpha'); h.input(`sample:${first}:quantity`, '2');
  h.action('duplicate', first); const second = h.sampleIds()[1]; assert.notEqual(first, second); assert.equal(h.field(`sample:${second}:name`).value, 'Alpha');
  h.input(`sample:${second}:name`, 'Beta'); h.action('add'); const third = h.sampleIds()[2]; h.action('remove', first);
  assert.equal(h.focused(), 'rq-heading-' + second); assert.equal(h.field(`sample:${second}:name`).value, 'Beta');
  h.action('remove', third); assert.equal(h.query(`[data-rq-action="remove"][data-rq-id="${second}"]`).disabled, true);
  for (let i = 1; i < 10; i++) h.action('add');
  assert.equal(h.sampleIds().length, 10); assert.equal(h.query('#rq-add-sample').disabled, true); assert.equal(h.writes.length, 0);
});

test('request presets respect edited state while explicit fresh and generic re-entry have distinct behavior', () => {
  const h = harness().start('purity'); const id = h.sampleIds()[0]; h.input(`sample:${id}:name`, 'Keep me');
  h.api.activate(); assert.equal(h.field(`sample:${id}:service`).value, 'purity'); assert.equal(h.query('#rq-notice').textContent, '');
  h.api.activate({ service: 'identity' }); assert.equal(h.field(`sample:${id}:service`).value, 'purity'); assert.match(h.query('#rq-notice').textContent, /not applied/);
  h.input(`sample:${id}:quantity`, '2'); assert.equal(h.query('#rq-notice').textContent, ''); assert.equal(h.root.querySelector('.rq-fresh'), null);
  h.api.activate({ service: 'identity' }); h.action('fresh'); const fresh = h.sampleIds()[0]; assert.equal(h.field(`sample:${fresh}:service`).value, 'identity'); assert.equal(h.field(`sample:${fresh}:name`).value, '');
  h.api.activate({ reset: true, service: 'custom' }); assert.equal(h.field(`sample:${h.sampleIds()[0]}:service`).value, 'custom');
  for (const handlers of h.events.values()) assert.equal(handlers.length, 1);
});

test('local image previews preserve valid files on rejection and revoke on replace/remove/reset/destroy', () => {
  const h = harness().start(); const id = h.sampleIds()[0]; h.input(`sample:${id}:name`, 'Image sample'); h.submit(); h.contact(); h.input(`sample:${id}:image`, 'include', 'change');
  h.file(id, { type: 'image/png', size: 500, name: 'PRIVATE-REFERENCE.png' }); assert.match(h.root.innerHTML, /blob:synthetic-1/);
  for (const file of [{ type: 'image/svg+xml', size: 20 }, { type: 'image/png', size: 5 * 1024 * 1024 + 1 }]) { h.file(id, file); assert.match(h.root.innerHTML, /blob:synthetic-1/); assert.equal(h.query('#rq-file-' + id).getAttribute('aria-invalid'), 'true'); }
  assert.deepEqual(h.revokedURLs, []);
  h.file(id, { type: 'image/webp', size: 200 }); assert.deepEqual(h.revokedURLs, ['blob:synthetic-1']); assert.equal(h.query('#rq-file-' + id).hasAttribute('aria-invalid'), false);
  h.step(1); h.action('duplicate', id); const copy = h.sampleIds()[1]; h.submit(); assert.equal(h.createdURLs.length, 2);
  assert.equal((h.root.innerHTML.match(/class="rq-preview"/g) || []).length, 1);
  h.step(1); h.action('remove', id); assert.deepEqual(h.revokedURLs, ['blob:synthetic-1', 'blob:synthetic-2']);
  h.submit(); h.file(copy, { type: 'image/jpeg', size: 300 }); h.action('remove-image', copy); assert.ok(h.revokedURLs.includes('blob:synthetic-3'));
  h.file(copy, { type: 'image/png', size: 300 }); h.api.activate({ reset: true }); assert.ok(h.revokedURLs.includes('blob:synthetic-4'));
  h.input(`sample:${h.sampleIds()[0]}:name`, 'New'); h.submit(); const last = h.query('[data-rq-field]').dataset.rqField; assert.ok(last);
  const remainingId = copy; // Removed IDs must never receive a later preview.
  assert.equal(h.root.querySelector('#rq-file-' + remainingId), null);
  assert.equal(h.createdURLs.length, 4);
  h.step(1); const freshId = h.sampleIds()[0]; h.submit(); h.input(`sample:${freshId}:image`, 'include', 'change'); h.file(freshId, { type: 'image/png', size: 100 });
  h.api.destroy(); assert.ok(h.revokedURLs.includes('blob:synthetic-5')); assert.ok([...h.events.values()].every(handlers => handlers.length === 0)); assert.equal(h.writes.length, 0);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
const userA = { id: 'user-a' }, userB = { id: 'user-b' };
const documentFor = (record, revision = 1) => ({ id: 'doc-a', revision, record, createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z' });

test('account save waits for durable acknowledgement, blocks duplicates and never writes local drafts', async () => {
  const calls = []; let acknowledge;
  const h = harness({ accountEnabled: true, accountUser: userA, saveAccountDraft(record, metadata) { calls.push({ record: structuredClone(record), metadata }); return new Promise(resolve => { acknowledge = resolve; }); } }).validReview();
  h.submit(); assert.equal(calls.length, 1); assert.match(h.root.innerHTML, /Submitting…/); assert.equal(h.query('#request-step-form').getAttribute('aria-busy'), 'true');
  h.submit(); assert.equal(calls.length, 1); assert.equal(h.writes.length, 0); assert.equal(h.root.querySelector('#rq-saved-title'), null);
  acknowledge(documentFor(calls[0].record)); await settle();
  assert.match(h.root.innerHTML, /Request submitted/); assert.equal(h.writes.length, 0); assert.equal(calls[0].metadata.ownerId, userA.id);
});

test('lost create acknowledgement replays identical frozen POST then updates latest edits in the same document', async () => {
  const calls = []; let serverDocument; let clock = 0;
  const h = harness({ accountEnabled: true, accountUser: userA, now: () => `2026-11-07T00:00:0${clock++}.000Z`, saveAccountDraft: async (record, metadata) => {
    calls.push({ record: structuredClone(record), metadata: { ...metadata, signal: undefined } });
    if (!metadata.id) {
      if (!serverDocument) { serverDocument = documentFor(record); throw Object.assign(new Error('Synthetic lost response after commit'), { code: 'network' }); }
      assert.equal(JSON.stringify(record), JSON.stringify(serverDocument.record)); return serverDocument;
    }
    assert.equal(metadata.id, serverDocument.id); assert.equal(metadata.expectedRevision, 1); serverDocument = documentFor(record, 2); return serverDocument;
  } }).validReview();
  h.submit(); await settle(); assert.equal(h.root.querySelector('#rq-saved-title'), null);
  h.step(1); h.input(`sample:${h.sampleIds()[0]}:name`, 'Latest edited sample'); h.step(3); h.submit(); await settle();
  assert.equal(calls.length, 3); assert.deepEqual(calls[0].record, calls[1].record); assert.equal(calls[0].metadata.idempotencyKey, calls[1].metadata.idempotencyKey);
  assert.equal(calls[2].record.id, calls[0].record.id); assert.equal(calls[2].record.createdAt, calls[0].record.createdAt); assert.equal(clock, 1);
  assert.equal(serverDocument.record.details.samples[0].name, 'Latest edited sample'); assert.equal(serverDocument.revision, 2); assert.match(h.root.innerHTML, /Request submitted/); assert.equal(h.writes.length, 0);
});

test('cloud failures preserve entered values and destination without silent device fallback', async () => {
  for (const status of [0, 401, 409]) {
    const h = harness({ accountEnabled: true, accountUser: userA, saveAccountDraft: async () => { throw Object.assign(new Error('Synthetic error'), { status, code: status ? 'request_failed' : 'network' }); } }).validReview();
    h.submit(); await settle(); assert.equal(h.writes.length, 0); assert.equal(h.root.querySelector('#rq-saved-title'), null);
    assert.match(h.root.innerHTML, /still here/); h.step(1); assert.equal(h.field(`sample:${h.sampleIds()[0]}:name`).value, 'Synthetic sample');
  }
});

test('same-user relogin retains pending intent, while owner switch and logout withhold old account data', async () => {
  const calls = []; let resolve;
  const h = harness({ accountEnabled: true, accountUser: userA, saveAccountDraft: (record, metadata) => { calls.push({ record: structuredClone(record), metadata }); return new Promise(r => { resolve = r; }); } }).validReview();
  h.submit(); h.api.setAccountSession(null, 'expired'); h.api.setAccountSession(null, 'recovered'); h.api.setAccountSession(userA, 'login');
  h.submit(); assert.equal(calls.length, 2); assert.deepEqual(calls[0].record, calls[1].record); assert.equal(calls[0].metadata.idempotencyKey, calls[1].metadata.idempotencyKey);
  const oldRecord = calls[1].record; h.api.setAccountSession(userB, 'login'); resolve(documentFor(oldRecord)); await settle();
  assert.ok(!h.root.innerHTML.includes('Synthetic sample')); assert.equal(h.root.querySelector('#rq-saved-title'), null); assert.equal(h.writes.length, 0);
  h.api.setAccountSession(null, 'logout'); assert.equal(h.writes.length, 0);
});

test('navigation aborts UI acknowledgement while retaining the frozen intent for safe retry', async () => {
  const calls = []; let acknowledge;
  const h = harness({ accountEnabled: true, accountUser: userA, saveAccountDraft: (record, metadata) => { calls.push({ record: structuredClone(record), metadata }); return new Promise(resolve => { acknowledge = resolve; }); } }).validReview();
  h.submit(); h.api.suspend(); assert.equal(h.root.innerHTML, ''); assert.equal(calls[0].metadata.signal.aborted, true);
  acknowledge(documentFor(calls[0].record)); await settle(); assert.equal(h.root.innerHTML, '');
  h.api.activate(); h.submit(); assert.equal(calls.length, 2); assert.deepEqual(calls[0].record, calls[1].record); assert.equal(calls[0].metadata.idempotencyKey, calls[1].metadata.idempotencyKey);
});

test('testing guests and disabled mode cannot submit or access any legacy browser storage', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); let reads = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { reads++; throw Error('Legacy keys must remain untouched'); } });
  try {
    const guest = harness({ accountUser: null }).start('identity'); assert.match(guest.root.innerHTML, /Checking your account/); guest.api.setAccountSession(null); assert.match(guest.root.innerHTML, /Sign in to submit/);
    guest.api.setAccountSession(userA); assert.equal(guest.field('sample:' + guest.sampleIds()[0] + ':service').value, 'identity');
    const disabled = harness({ accountEnabled: false }).start(); assert.match(disabled.root.innerHTML, /unavailable/); assert.equal(disabled.root.querySelector('#request-step-form'), null);
    const ready = harness().validReview(); ready.submit(); await settle(); assert.match(ready.root.innerHTML, /Request submitted/); assert.equal(reads, 0);
    assert.doesNotMatch(ready.root.innerHTML, /Save draft|This device|data-rq-destination/);
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; }
});

test('legacy account review explicitly converts to v3 with original identity, revision and hidden historical fields', async () => {
  const state = newSubmission('historical'); Object.assign(state, {name:'Original',email:'fixture@example.invalid',company:'Retained company'}); Object.assign(state.samples[0],{name:'Historical',batch:'LOT-42',amount:'80 mg'});
  const record=createRequestRecord(state,{id:'AN-REQ-HISTORICAL',createdAt:'2026-11-05T00:00:00.000Z'}); const before=JSON.stringify(record); const calls=[];
  const h=harness({saveAccountDraft:async (value,metadata)=>{calls.push({value,metadata});return documentFor(value,2);}});
  assert.equal(h.api.resume(record),false);
  assert.equal(h.api.resume(record,{id:'doc-a',revision:1,ownerId:userA.id}),true); h.submit();h.submit();h.submit();await settle();
  assert.equal(calls.length,1);assert.equal(calls[0].metadata.expectedRevision,1);assert.equal(calls[0].value.version,3);assert.equal(calls[0].value.id,record.id);assert.equal(calls[0].value.details.company,'Retained company');assert.equal(calls[0].value.details.samples[0].batch,'LOT-42');assert.equal(JSON.stringify(record),before);
});

test('testing rejects altered acknowledgement identity, revision and payload before success', async () => {
  for (const alter of [doc=>({...doc,revision:2}),doc=>({...doc,record:{...doc.record,status:'Accepted'}}),doc=>({...doc,record:{...doc.record,id:'AN-REQ-OTHER'}})]) {
    const h=harness({saveAccountDraft:async record=>alter(documentFor(record))}).validReview(); h.submit(); await settle(); assert.equal(h.root.querySelector('#rq-saved-title'),null); assert.match(h.root.innerHTML,/could not confirm/);
  }
});

test('testing session refresh withholds a prior private editor until owner confirmation',()=>{
 const h=harness().validReview();h.api.checkAccountSession();assert.match(h.root.innerHTML,/Checking your account/);assert.doesNotMatch(h.root.innerHTML,/Synthetic sample/);h.api.setAccountSession(userB);assert.equal(h.field('sample:'+h.sampleIds()[0]+':name').value,'');
});
