import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { CONTACT_DRAFT_KEY, CONTACT_TOPICS, normalizeContact, validateContact, parseContactDraft, formatContactMessage, createContactForm } from '../dist/contact.js';

const valid = { name: 'QA Person', email: 'qa@example.invalid', topic: 'website', message: 'A synthetic website question.' };
const serialized = value => JSON.stringify({ version: 1, ...value });
function fixture({ seed = [], flags = {}, clipboard, bind = true } = {}) {
  const data = new Map(seed), calls = [], copied = [], events = new Map(), nodes = new Map();
  let focused = '', selected = 0;
  const node = id => {
    const value = { id, value: '', textContent: '', hidden: false, disabled: true, dataset: {}, attributes: new Map(),
      setAttribute(name, text) { this.attributes.set(name, String(text)); },
      removeAttribute(name) { this.attributes.delete(name); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      focus() { focused = id; }, select() { selected++; },
      closest(selector) { return selector === '[data-contact-action]' && this.dataset.contactAction ? this : null; }
    };
    Object.defineProperty(value, 'innerHTML', { set() { throw new Error('User HTML must never be inserted'); } });
    nodes.set('#' + id, value); return value;
  };
  for (const key of ['name', 'email', 'topic', 'message']) { node('contact-' + key); node('contact-error-' + key); }
  for (const id of ['contact-error', 'contact-status', 'contact-copy-value', 'contact-copy-fallback']) node(id);
  nodes.get('#contact-copy-fallback').hidden = true;
  const buttons = ['save', 'copy', 'restore', 'clear', 'select'].map(action => {
    const button = node('button-' + action);
    if (action !== 'save') button.dataset.contactAction = action;
    return button;
  });
  const form = { isConnected: true, viewHidden: false, ownerDocument: { hidden: false },
    querySelector: selector => nodes.get(selector) || null,
    querySelectorAll: selector => selector === 'button' ? buttons : [],
    contains: element => buttons.includes(element),
    closest(selector) { return selector === '[hidden]' && this.viewHidden ? {} : null; },
    addEventListener(type, callback) { if (!events.has(type)) events.set(type, []); events.get(type).push(callback); }
  };
  const storage = {
    getItem(key) { calls.push(['get', key]); if (flags.read === 'throw') throw new Error('Synthetic blocked read'); return data.get(key) ?? null; },
    setItem(key, value) { calls.push(['set', key, value]); if (flags.write === 'throw') throw new Error('Synthetic blocked write'); if (flags.write !== 'silent') data.set(key, value); },
    removeItem(key) { calls.push(['remove', key]); if (flags.remove === 'throw') throw new Error('Synthetic blocked removal'); if (flags.remove !== 'silent') data.delete(key); }
  };
  const clip = clipboard || { writeText(value) { copied.push(value); return Promise.resolve(); } };
  const emit = (type, target) => {
    const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    const pending = Promise.all((events.get(type) || []).map(callback => callback(event)));
    return { event, pending };
  };
  const api = {
    form, nodes, buttons, events, data, calls, copied, flags, storage, clip,
    bind: options => createContactForm(form, options || { storage, clipboard: clip }),
    fill(value = valid) { for (const [key, text] of Object.entries(value)) nodes.get('#contact-' + key).value = text; },
    values: () => Object.fromEntries(['name', 'email', 'topic', 'message'].map(key => [key, nodes.get('#contact-' + key).value])),
    input(key, text) { nodes.get('#contact-' + key).value = text; return emit('input', nodes.get('#contact-' + key)); },
    save() { return emit('submit', form); },
    action(action) { return emit('click', buttons.find(button => button.dataset.contactAction === action)).pending; },
    focused: () => focused, selected: () => selected,
    status: () => nodes.get('#contact-status').textContent,
    error: () => nodes.get('#contact-error').textContent
  };
  if (bind) api.controller = api.bind();
  return api;
}

test('contact validation normalizes known fields and rejects raw types, blanks, topic choices and overlong values', () => {
  assert.deepEqual(normalizeContact({ ...valid, name: ' QA Person ', email: ' QA@example.invalid ', message: ' Question\n details ' }), { name: 'QA Person', email: 'QA@example.invalid', topic: 'website', message: 'Question\n details' });
  assert.deepEqual(validateContact(valid), {});
  for (const key of Object.keys(valid)) for (const value of [null, false, 12, {}, []]) assert.ok(validateContact({ ...valid, [key]: value })[key]);
  for (const [key, limit] of [['name', 120], ['email', 160], ['message', 4000]]) assert.ok(validateContact({ ...valid, [key]: ' ' + 'x'.repeat(limit) })[key]);
  for (const topic of ['', 'unknown', 'toString', ' website ']) assert.ok(validateContact({ ...valid, topic }).topic);
  assert.ok(validateContact({ ...valid, name: ' \n ' }).name);
  assert.ok(validateContact({ ...valid, message: '\t ' }).message);
  assert.ok(validateContact({ ...valid, email: 'missing@domain' }).email);
  assert.deepEqual(Object.keys(CONTACT_TOPICS), ['testing', 'report', 'website', 'other']);
});

test('strict contact draft parsing supports maximum escaped JSON and rejects corrupt schemas without partial values', () => {
  const maximum = { ...valid, name: 'N' + '\u0001'.repeat(119), message: 'M' + '\u0001'.repeat(3999) };
  assert.ok(serialized(maximum).length > 24000);
  assert.deepEqual(parseContactDraft(serialized(maximum)), maximum);
  for (const raw of [null, undefined, {}, '', '{broken', '[]', 'null', ' '.repeat(30000), JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, version: 1, extra: true }), serialized({ ...valid, message: 'x'.repeat(4001) }), serialized({ ...valid, email: 7 }), serialized({ ...valid, topic: '' })]) assert.equal(parseContactDraft(raw), null);
  assert.equal(formatContactMessage(valid), 'AssayNova / Contact enquiry\n\nName: QA Person\nEmail: qa@example.invalid\nTopic: Website issue\n\nMessage:\nA synthetic website question.');
});

test('module import has no DOM/storage/network I/O and static markup cannot submit private named values before boot', async () => {
  const source = await readFile(new URL('../dist/contact.js', import.meta.url), 'utf8');
  let calls = 0;
  const context = { fetch() { calls++; throw new Error('No network'); } };
  for (const key of ['document', 'localStorage', 'navigator']) Object.defineProperty(context, key, { get() { calls++; throw new Error('No import I/O'); } });
  runInNewContext(source.replace(/^export /gm, ''), context);
  assert.equal(calls, 0);
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const form = html.match(/<form id="contact-form"[\s\S]*?<\/form>/)[0];
  for (const control of form.match(/<(?:input|select|textarea)\b[^>]*>/g)) assert.ok(!/\bname\s*=/.test(control), control);
  for (const button of form.match(/<button\b[^>]*>/g)) assert.match(button, /\bdisabled(?:\s|>)/);
  assert.ok(!/onsubmit\s*=/.test(form));
  assert.equal((html.match(/src="\/contact-form\.js"/g) || []).length, 1);
});

test('binding is idempotent, enables controls only after complete handlers and cancels native submission', async () => {
  const f = fixture();
  assert.equal(f.bind(), f.controller);
  assert.ok(f.buttons.every(button => !button.disabled));
  assert.ok([...f.events.values()].every(list => list.length === 1));
  assert.deepEqual(f.calls, []);
  f.input('name', 'QA'); assert.deepEqual(f.calls, []);
  const attempt = f.save(); await attempt.pending;
  assert.equal(attempt.event.defaultPrevented, true);
  assert.equal(f.focused(), 'contact-email');
  assert.equal(f.nodes.get('#contact-email').getAttribute('aria-invalid'), 'true');
  f.input('email', valid.email);
  assert.equal(f.nodes.get('#contact-email').getAttribute('aria-invalid'), null);
  const broken = fixture({ bind: false }); broken.nodes.delete('#contact-error');
  assert.throws(() => broken.bind(), TypeError);
  assert.ok(broken.buttons.every(button => button.disabled));
});

test('Save writes only the versioned contact key with exact read-back and retains user inputs', () => {
  const f = fixture({ seed: [['unrelated', 'keep']] }); f.fill({ ...valid, name: ' QA Person ' });
  f.save();
  assert.deepEqual(JSON.parse(f.data.get(CONTACT_DRAFT_KEY)), { version: 1, ...valid });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['set', CONTACT_DRAFT_KEY], ['get', CONTACT_DRAFT_KEY]]);
  assert.equal(f.data.get('unrelated'), 'keep'); assert.match(f.status(), /saved on this device/);
  assert.equal(f.values().name, ' QA Person ');
  f.input('message', 'Edited'); assert.equal(f.status(), ''); assert.equal(f.calls.length, 2);
});

test('throwing, silently refused and unreadable Save operations cannot claim persistence or erase input', () => {
  for (const flags of [{ write: 'throw' }, { write: 'silent' }, { read: 'throw' }]) {
    const f = fixture({ flags }); f.fill(); f.save();
    assert.deepEqual(f.values(), valid); assert.equal(f.status(), ''); assert.match(f.error(), /could not be saved/);
  }
});

test('actual bootstrap defers a throwing localStorage accessor until the explicit action', async () => {
  const f = fixture({ bind: false }); f.fill(); let accesses = 0;
  const window = {}; Object.defineProperty(window, 'localStorage', { get() { accesses++; throw new Error('Synthetic SecurityError'); } });
  const source = await readFile(new URL('../dist/contact-form.js', import.meta.url), 'utf8');
  runInNewContext(source.replace(/^import[^\n]+\n/, ''), { createContactForm, document: { querySelector: () => f.form }, window, navigator: {} });
  assert.equal(accesses, 0); assert.ok(f.buttons.every(button => !button.disabled));
  f.save(); assert.equal(accesses, 1); assert.match(f.error(), /could not be saved/); assert.deepEqual(f.values(), valid);
});

test('Restore is explicit, handles valid hostile strings as values, and preserves current fields on absent/corrupt/blocked reads', async () => {
  const hostile = { ...valid, name: '<img src=x onerror=alert(1)>', message: '<script>not HTML</script>\nFull text' };
  const f = fixture({ seed: [[CONTACT_DRAFT_KEY, serialized(hostile)]] }); f.fill();
  assert.deepEqual(f.calls, []); await f.action('restore');
  assert.deepEqual(f.values(), hostile); assert.match(f.status(), /restored/);
  assert.deepEqual(f.calls, [['get', CONTACT_DRAFT_KEY]]);
  for (const config of [{}, { seed: [[CONTACT_DRAFT_KEY, '{bad']] }, { flags: { read: 'throw' } }]) {
    const sample = fixture(config); sample.fill(); await sample.action('restore');
    assert.deepEqual(sample.values(), valid);
    assert.ok(sample.status().includes('No saved') || sample.error().includes('could not'));
  }
});

test('Clear removes and verifies only the contact key while preserving visible fields and other necessary drafts', async () => {
  const f = fixture({ seed: [[CONTACT_DRAFT_KEY, serialized(valid)], ['assaynova.prototype.requests.v1', 'request'], ['assaynova.support.recovery.v1', 'recovery']] }); f.fill(); await f.action('clear');
  assert.deepEqual(f.calls, [['remove', CONTACT_DRAFT_KEY], ['get', CONTACT_DRAFT_KEY]]);
  assert.deepEqual(f.values(), valid); assert.equal(f.data.size, 2); assert.match(f.status(), /cleared.*still here/);
  for (const flags of [{ remove: 'throw' }, { remove: 'silent' }, { read: 'throw' }]) {
    const sample = fixture({ seed: [[CONTACT_DRAFT_KEY, serialized(valid)]], flags }); sample.fill(); await sample.action('clear');
    assert.deepEqual(sample.values(), valid); assert.equal(sample.status(), ''); assert.match(sample.error(), /could not be cleared/);
  }
});

test('Copy uses complete current text without storage and denial/unavailability exposes selectable full plaintext', async () => {
  const f = fixture(); f.fill({ ...valid, message: 'Current unsaved text' }); await f.action('copy');
  assert.equal(f.copied[0], formatContactMessage(f.values())); assert.deepEqual(f.calls, []); assert.match(f.status(), /Message copied.*No message/);
  for (const clipboard of [{ writeText: () => Promise.reject(new Error('Denied')) }, {}]) {
    const sample = fixture({ clipboard }); sample.fill(); await sample.action('copy');
    assert.equal(sample.nodes.get('#contact-copy-fallback').hidden, false);
    assert.equal(sample.nodes.get('#contact-copy-value').value, formatContactMessage(valid));
    assert.equal(sample.status(), ''); assert.deepEqual(sample.calls, []);
    await sample.action('select'); assert.equal(sample.focused(), 'contact-copy-value'); assert.equal(sample.selected(), 2);
    sample.input('message', 'Changed'); assert.equal(sample.nodes.get('#contact-copy-fallback').hidden, true); assert.equal(sample.nodes.get('#contact-copy-value').value, '');
  }
});

test('late copy results are invalidated by inputs, Save, Restore, Clear and newer copy attempts', async () => {
  for (const operation of ['input', 'save', 'restore', 'clear', 'copy']) {
    let resolve, reject; const pending = new Promise((a, b) => { resolve = a; reject = b; }); let attempts = 0;
    const f = fixture({ seed: [[CONTACT_DRAFT_KEY, serialized(valid)]], clipboard: { writeText() { return attempts++ ? Promise.resolve() : pending; } } }); f.fill();
    const old = f.action('copy');
    if (operation === 'input') { f.input('message', 'Changed'); f.input('message', valid.message); }
    else if (operation === 'save') f.save();
    else await f.action(operation);
    const feedback = f.status();
    reject(new Error('Late denial')); await old;
    assert.equal(f.status(), feedback, operation); assert.equal(f.nodes.get('#contact-copy-fallback').hidden, true, operation);
    assert.equal(typeof resolve, 'function');
  }
});

test('copy completion cannot mutate a hidden/detached page or programmatically changed snapshot', async () => {
  for (const state of ['viewHidden', 'documentHidden', 'detached', 'snapshot']) {
    let resolve; const pending = new Promise(done => { resolve = done; });
    const f = fixture({ clipboard: { writeText: () => pending } }); f.fill(); const old = f.action('copy');
    if (state === 'viewHidden') f.form.viewHidden = true;
    if (state === 'documentHidden') f.form.ownerDocument.hidden = true;
    if (state === 'detached') f.form.isConnected = false;
    if (state === 'snapshot') f.nodes.get('#contact-message').value = 'Changed without an input event';
    resolve(); await old; assert.equal(f.status(), ''); assert.equal(f.nodes.get('#contact-copy-fallback').hidden, true);
  }
});
