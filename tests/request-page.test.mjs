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
  const config = { makeId: () => 'test-' + ++counter, now: () => '2026-11-05T00:00:00.000Z', openSavedDrafts: () => openedSaved++, objectURLs: { createObjectURL(file) { const url = 'blob:synthetic-' + (createdURLs.length + 1); createdURLs.push({ url, file }); return url; }, revokeObjectURL(url) { revokedURLs.push(url); } } };
  if (!options.lazyStorage) config.storage = storage;
  const api = createRequestPage(root, config);
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
  h.input(`sample:${id}:batch`, 'Edited batch'); assert.equal(h.query('#rq-notice').textContent, ''); assert.equal(h.root.querySelector('.rq-fresh'), null);
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

test('actual final Save persists only chosen options, reopens v2 and updates one ID while preserving legacy drafts', () => {
  const legacy = { id: 'AN-DEMO-LEGACY', sample: 'Legacy', service: 'purity', quantity: 1 };
  const h = harness({ initial: JSON.stringify([legacy]) }).start(); const id = h.sampleIds()[0]; h.input(`sample:${id}:name`, 'First'); h.submit(); h.contact(); h.input(`sample:${id}:image`, 'include', 'change'); h.file(id, { type: 'image/png', size: 100, name: 'NEVER-SAVE.png' }); h.submit(); h.submit();
  const raw = h.values.get(REQUEST_DRAFT_KEY); const records = JSON.parse(raw); assert.equal(records.length, 2); assert.deepEqual(records[1], legacy);
  assert.ok(!/NEVER-SAVE|blob:|filename|base64/.test(raw)); assert.equal(records[0].samples[0].image, 'include'); assert.match(h.root.innerHTML, /Draft · Not sent/);
  h.step(1); h.input(`sample:${id}:name`, 'Edited after saving');
  assert.equal(h.root.querySelector('#rq-saved-title'), null, 'Typing removes the previous Saved claim');
  assert.equal(h.values.get(REQUEST_DRAFT_KEY), raw, 'Editing never autosaves over the saved draft');
  const reloaded = harness({ initial: raw }); assert.equal(reloaded.api.resume(records[0]), true); const resumedId = reloaded.sampleIds()[0]; reloaded.input(`sample:${resumedId}:name`, 'Updated'); reloaded.submit(); assert.match(reloaded.root.innerHTML, /Reselect an optional reference image/); reloaded.submit(); reloaded.submit();
  const updated = JSON.parse(reloaded.values.get(REQUEST_DRAFT_KEY)); assert.equal(updated.length, 2); assert.equal(updated[0].id, records[0].id); assert.equal(updated[0].createdAt, records[0].createdAt); assert.equal(updated[0].sample, 'Updated');
  reloaded.action('saved'); assert.equal(reloaded.openedSaved(), 1);
});

test('save refuses read/write/silent failures and corrupt lists, preserves fields and makes no success claim', () => {
  for (const options of [{ readFailure: true }, { writeFailure: true }, { silentWrite: true }, { initial: '{}' }, { initial: '{' }]) {
    const h = harness(options).validReview(); h.submit(); assert.match(h.root.innerHTML, /could not save/); assert.equal(h.root.querySelector('#rq-saved-title'), null); assert.equal(h.focused(), 'rq-errors'); h.step(1); assert.equal(h.field(`sample:${h.sampleIds()[0]}:name`).value, 'Synthetic sample');
  }
});

test('a throwing localStorage getter is accessed lazily inside Save, not controller creation', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); let reads = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { reads++; throw Error('Synthetic SecurityError'); } });
  try { const h = harness({ lazyStorage: true }).validReview(); assert.equal(reads, 0); h.submit(); assert.equal(reads, 1); assert.match(h.root.innerHTML, /could not save/); }
  finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; }
});
