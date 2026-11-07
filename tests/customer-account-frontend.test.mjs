import { createAccountRequest } from '../dist/account-requests.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerAccountClient, safeAccountNext, validAccountPassword, accountDraft, AccountError, accountErrorMessage } from '../dist/customer-account.js';
import { createAccountPage } from '../dist/account-page.js';
import { newSubmission, createRequestRecord } from '../dist/submission.js';
import { sanitizeMarkup } from '../dev/prompt.js';
import { accountFixture, browser, draftRecord, fixturePassword } from './support/customer-account-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const user = { id: 'user-a', email: 'qa@example.invalid', emailVerified: false, name: 'Synthetic person', company: 'Synthetic lab' };
const codes = Array.from({ length: 8 }, (_, i) => 'SYNTHETICCODE0000' + i);
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const browserFetcher = (active, hook = () => {}) => async (url, options) => {
  const route = url.slice('/api/account'.length);
  await hook(route, 'before', options);
  const result = await active().call(route, options.method, undefined, { headers: options.headers, signal: options.signal, ...(options.body === undefined ? {} : { raw: options.body }) });
  await hook(route, 'after', options);
  return response(result.data, result.status);
};

test('account client is lazy, has strict safe returns and validates Unicode password limits without trimming', () => {
  let calls = 0; createCustomerAccountClient({ fetcher: () => { calls++; } }); assert.equal(calls, 0);
  for (const path of ['/account', '/submit-sample', '/contact', '/contact?request=report-recovery']) assert.equal(safeAccountNext(path), path);
  for (const path of ['https://outside.invalid', '//outside.invalid', '/account?x=1', '/account#main', '/%61ccount', '/login', '/account/../submit-sample', '/contact?request=%72eport-recovery', '/contact?request=report-recovery&email=private', '/contact%3frequest=report-recovery', '/contact#request=report-recovery', '\\account', null]) assert.equal(safeAccountNext(path), '/account');
  assert.equal(validAccountPassword(' '.repeat(15)), true); assert.equal(validAccountPassword('😀'.repeat(128)), true);
  assert.equal(validAccountPassword('short'), false); assert.equal(validAccountPassword('x'.repeat(129)), false); assert.equal(validAccountPassword('x'.repeat(15) + '\ud800'), false);
});

test('transport uses same-origin no-store fixed paths and session-bound CSRF; no client owner field is sent', async () => {
  const calls = [];
  const state = newSubmission('sample-a'); Object.assign(state, { name: 'A', email: 'a@example.invalid' }); state.samples[0].name = 'Sample A';
  const record = createRequestRecord(state, { id: 'AN-REQ-A', createdAt: '2026-11-07T00:00:00.000Z' });
  const document = { id: 'draft-a', revision: 1, record, createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z' };
  const client = createCustomerAccountClient({ fetcher: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/session')) return response({ authenticated: true, user, csrfToken: 'synthetic-csrf' });
    return response({ request: document }, 201);
  } });
  assert.equal(calls.length, 0); const saved = await client.saveDraft(record, { ownerId: user.id, idempotencyKey: 'intent-a' }); assert.deepEqual(saved, document);
  assert.deepEqual(calls.map(c => c.url), ['/api/account/session', '/api/account/requests', '/api/account/session']);
  for (const call of calls) { assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.redirect, 'error'); }
  assert.equal(calls[1].options.headers['X-Account-CSRF'], 'synthetic-csrf'); assert.deepEqual(JSON.parse(calls[1].options.body), { record, idempotencyKey: 'intent-a' });
  assert.throws(() => accountDraft({ ...document, record: { ...record, ownerId: 'foreign' } }));
});

test('a changed server session cannot receive a previous owner draft; stale profile cannot resurrect logout', async () => {
  let writes = 0;
  const other = { ...user, id: 'user-b' };
  const client = createCustomerAccountClient({ fetcher: async (url) => { if (url.endsWith('/session')) return response({ authenticated: true, user: other, csrfToken: 'synthetic-b' }); writes++; return response({}); } });
  await assert.rejects(client.saveDraft({}, { ownerId: user.id, idempotencyKey: 'intent-a' }), e => e.code === 'owner_changed'); assert.equal(writes, 0);
  let finishProfile;
  const c = createCustomerAccountClient({ fetcher: async url => {
    if (url.endsWith('/session')) return response({ authenticated: true, user, csrfToken: 'synthetic-a' });
    if (url.endsWith('/profile')) return new Promise(resolve => { finishProfile = () => resolve(response({ user: { ...user, name: 'Late private name' } })); });
    return response({ ok: true });
  } });
  await c.getSession(); const pending = c.profile({ name: 'Changed' }); await c.logout(); finishProfile(); await assert.rejects(pending, e => e.code === 'aborted'); assert.equal(c.snapshot().user, null);
});

test('real uppercase API errors keep specific static feedback ahead of status fallbacks', async t => {
  const fixture = await accountFixture(); t.after(() => fixture.close());
  const transport = browser(fixture.base);
  const client = createCustomerAccountClient({ fetcher: browserFetcher(() => transport) });
  const email = 'frontend-errors@example.invalid';
  const created = await client.signup({ email, password: fixturePassword });
  const expectError = (code, text) => error => {
    assert.equal(error.code, code.toLowerCase()); assert.match(accountErrorMessage(error), text);
    assert.doesNotMatch(accountErrorMessage(error), /Reopen it from My account|Please sign in again/);
    return true;
  };
  await assert.rejects(client.signup({ email, password: fixturePassword }), expectError('ACCOUNT_EXISTS', /Try signing in or use account recovery/));
  await assert.rejects(client.login({ email, password: 'A wrong synthetic password' }), expectError('INVALID_CREDENTIALS', /email and password could not be confirmed/));
  await assert.rejects(client.recover({ email, recoveryCode: '0'.repeat(32), newPassword: fixturePassword }), expectError('INVALID_RECOVERY', /recovery details could not be confirmed/));
  assert.equal(client.snapshot().user.id, created.user.id, 'credential rejection must not falsely expire the existing session');
  let first;
  for (let i = 0; i < 50; i++) {
    const saved = await transport.call('/requests', 'POST', { record: draftRecord('Synthetic draft ' + i, 'LIMIT' + i), idempotencyKey: 'frontend-limit-key-' + String(i).padStart(3, '0') });
    assert.equal(saved.status, 201); first ??= saved.data.request;
  }
  await assert.rejects(client.saveDraft(draftRecord('One too many', 'EXCESS'), { ownerId: created.user.id, idempotencyKey: 'frontend-over-limit-key' }), expectError('DRAFT_LIMIT', /Remove an existing request/));
  await assert.rejects(client.saveDraft(first.record, { ownerId: created.user.id, id: first.id, expectedRevision: 2 }), error => {
    assert.equal(error.code, 'revision_conflict'); assert.match(accountErrorMessage(error), /request has changed/); return true;
  });
  for (const [code, status] of [['ACCOUNT_EXISTS', 409], ['INVALID_CREDENTIALS', 401], ['INVALID_RECOVERY', 401], ['DRAFT_LIMIT', 409], ['REVISION_CONFLICT', 409]]) {
    assert.equal(new AccountError(code, status).code, code.toLowerCase());
    assert.equal(accountErrorMessage(new AccountError(code, status)), accountErrorMessage(new AccountError(code.toLowerCase(), status)));
  }
});

test('actual HTTP draft list/detail reads discard another account before and during GET; deletes precheck owner', async t => {
  const fixture = await accountFixture(); t.after(() => fixture.close());
  const a = browser(fixture.base), b = browser(fixture.base);
  const accountA = await a.signup('frontend-owner-a@example.invalid'), accountB = await b.signup('frontend-owner-b@example.invalid');
  const savedA = (await a.call('/requests', 'POST', { record: draftRecord('Only A private draft', 'AONLY'), idempotencyKey: 'frontend-a-only-draft-key' })).data.request;
  const savedB = (await b.call('/requests', 'POST', { record: draftRecord('Only B private draft', 'BONLY'), idempotencyKey: 'frontend-b-only-draft-key' })).data.request;
  let active = a, hook = () => {}; const calls = [];
  const client = createCustomerAccountClient({ fetcher: browserFetcher(() => active, async (route, stage, options) => { if (stage === 'before') calls.push([route, options.method]); await hook(route, stage, options); }) });
  const notices = []; client.subscribe(value => notices.push(value?.id));
  const reset = async () => { active = a; hook = () => {}; await client.getSession(); calls.length = 0; };
  for (const kind of ['list', 'detail']) {
    const read = id => kind === 'list' ? client.listDrafts() : client.getDraft(id);
    await reset(); active = b;
    await assert.rejects(read(savedB.id), error => error.code === 'owner_changed');
    assert.deepEqual(calls, [['/session', 'GET']], 'a pre-existing owner change must prevent the private read entirely');
    assert.equal(client.snapshot().user.id, accountB.data.user.id);
    for (const switchAt of ['before', 'after']) {
      await reset(); hook = (route, stage) => { if (route.startsWith('/requests') && stage === switchAt) active = b; };
      // Read B's ID when switching before the GET; read A's ID when switching
      // after it, so both cases reach the mandatory post-read session check.
      await assert.rejects(read(switchAt === 'after' ? savedA.id : savedB.id), error => error.code === 'owner_changed');
      assert.equal(calls.at(-1)[0], '/session');
      assert.equal(client.snapshot().user.id, accountB.data.user.id);
    }
  }
  await reset(); active = b;
  await assert.rejects(client.deleteDraft(savedB.id, 1), error => error.code === 'owner_changed');
  assert.ok(!calls.some(([, method]) => method === 'DELETE'));
  assert.equal((await b.call('/requests/' + savedB.id)).status, 200, 'B draft remains intact');
  await reset(); hook = (route, stage, options) => { if (route.startsWith('/requests/') && options.method === 'DELETE' && stage === 'before') active = b; };
  await assert.rejects(client.deleteDraft(savedB.id, 1), error => error.code === 'csrf_rejected');
  assert.equal((await b.call('/requests/' + savedB.id)).status, 200, 'a later cookie switch is rejected by session-bound CSRF');
  await reset(); hook = (route, stage) => { if (route === '/requests' && stage === 'before') active = b; };
  const root = domRoot(), navigations = [];
  const page = createAccountPage({ roots: { '/account': root }, client, navigate: path => navigations.push(path), onResume() {}, onNewRequest() {}, onDeviceDrafts() {} });
  await page.activate('/account');
  assert.equal(root.innerHTML, '', 'the old account view is cleared before a changed owner can paint private data');
  assert.ok(!root.innerHTML.includes('Only B private draft'));
  assert.deepEqual(navigations, ['/account']); page.destroy();
  assert.ok(notices.includes(accountA.data.user.id) && notices.includes(accountB.data.user.id));
});

// Minimal DOM adapter executes the actual page controller; native layout is QA'd separately.
function domRoot() {
  let nodes = [], html = ''; const events = new Map(); let focus = '';
  const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[c]);
  const descendant = (node, parent) => { for (let p = node; p; p = p.parentElement) if (p === parent) return true; return false; };
  const matches = (node, selector) => selector.split(',').some(raw => {
    const s = raw.trim(); if (s.startsWith('#')) return node.id === s.slice(1);
    if (s.startsWith('.')) return (node.attrs.get('class') || '').split(/\s+/).includes(s.slice(1));
    if (/^[a-z]+$/.test(s)) return node.tagName.toLowerCase() === s;
    const attributes = [...s.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)]; return attributes.length > 0 && attributes.every(([, key, value]) => value === undefined ? node.attrs.has(key) : node.attrs.get(key) === value);
  });
  const root = {
    get innerHTML() { return html; }, set innerHTML(value) {
      for (const node of nodes) node.isConnected = false; nodes = []; html = value; const stack = [root];
      for (const m of value.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
        if (m[1]) { const at = stack.findLastIndex(n => n.tagName?.toLowerCase() === m[2]); if (at >= 1) stack.length = at; continue; }
        const attrs = new Map([...m[3].matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)].map(([, key, val]) => [key, decode(val || '')]));
        const node = { tagName: m[2].toUpperCase(), attrs, id: attrs.get('id') || '', name: attrs.get('name') || '', value: attrs.get('value') || '', textContent: '', disabled: attrs.has('disabled'), hidden: attrs.has('hidden'), checked: false, isConnected: true, parentElement: stack.at(-1), dataset: Object.fromEntries([...attrs].filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v])),
          setAttribute(k, v) { attrs.set(k, String(v)); }, removeAttribute(k) { attrs.delete(k); }, getAttribute: k => attrs.get(k) ?? null,
          matches(s) { return matches(this, s); }, closest(s) { for (let n = this; n?.matches; n = n.parentElement) if (n.matches(s)) return n; return null; }, focus() { focus = this.id; }, select() {},
          querySelector(s) { return nodes.find(n => n.isConnected && descendant(n, this) && matches(n, s)) || null; },
          querySelectorAll(s) { return nodes.filter(n => n.isConnected && descendant(n, this) && matches(n, s)); },
          get elements() { const result = nodes.filter(n => n.isConnected && descendant(n, this) && ['INPUT', 'BUTTON', 'TEXTAREA', 'SELECT'].includes(n.tagName)); result.namedItem = name => result.find(n => n.name === name); return result; }
        };
        nodes.push(node); if (!['input', 'br', 'img', 'hr'].includes(m[2])) stack.push(node);
      }
    },
    contains: node => node?.isConnected && descendant(node, root), querySelector: s => nodes.find(n => n.isConnected && matches(n, s)) || null, querySelectorAll: s => nodes.filter(n => n.isConnected && matches(n, s)),
    addEventListener(type, callback) { events.set(type, callback); }, removeEventListener(type) { events.delete(type); },
    emit(type, target) { let prevented = false; events.get(type)?.({ target, preventDefault() { prevented = true; } }); return prevented; },
    click(selector) { const node = root.querySelector(selector); assert.ok(node, selector); root.emit('click', node); }, focused: () => focus
  }; return root;
}
function pageHarness({ initialUser = null, overrides = {}, clipboard } = {}) {
  const root = domRoot(), navigations = []; let currentUser = initialUser, deviceReads = 0; const listeners = new Set();
  const emit = (value, reason) => { currentUser = value; for (const fn of listeners) fn(value, reason); };
  const client = { getSession: async () => currentUser, snapshot: () => ({ user: currentUser }), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, listRequests: async () => [],
    signup: async () => { emit(user, 'login'); return { user, recoveryCodes: codes }; }, recover: async () => { emit(null, 'recovered'); return { ok: true, recoveryCodes: codes }; }, ...overrides };
  const page = createAccountPage({ roots: Object.fromEntries(['/account', '/login', '/register', '/recover-account'].map(path => [path, root])), client, navigate: (...args) => navigations.push(args), onResume() {}, onNewRequest() {}, onDeviceDrafts: () => deviceReads++, clipboard });
  return { root, page, client, emit, navigations, deviceReads: () => deviceReads };
}

test('auth UI has no implicit device reads; submit validates, awaits signup and clears one-time codes on navigation', async () => {
  const h = pageHarness({ clipboard: async () => { throw Error('Synthetic denied clipboard'); } });
  assert.equal(h.deviceReads(), 0); await h.page.activate('/register', '/account'); assert.equal(h.deviceReads(), 0);
  const form = h.root.querySelector('[data-account-form="register"]');
  assert.equal(h.root.emit('submit', form), true); assert.equal(h.root.focused(), 'ac-register-email');
  for (const [name, value] of Object.entries({ email: 'qa@example.invalid', name: '<private-name>', company: '', password: 'synthetic password', confirmPassword: 'synthetic password' })) form.elements.namedItem(name).value = value;
  h.root.emit('submit', form); await tick(); assert.ok(h.root.innerHTML.includes(codes[0]));
  assert.ok(!sanitizeMarkup(h.root.innerHTML).includes(codes[0]));
  h.root.click('[data-account-action="copy-codes"]'); await tick(); assert.equal(h.root.querySelector('[data-account-copy-fallback]').hidden, false); assert.equal(h.root.querySelector('textarea').value, codes.join('\n'));
  h.page.leave(); assert.equal(h.root.innerHTML, ''); assert.equal(h.deviceReads(), 0);
});

test('account security forms have unique labels/IDs and recovery does not auto-login', async () => {
  const h = pageHarness({ initialUser: user }); await h.page.activate('/account'); h.root.click('[data-account-tab="security"]');
  const ids = [...h.root.innerHTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); assert.equal(ids.length, new Set(ids).size);
  await h.page.activate('/recover-account'); const form = h.root.querySelector('[data-account-form="recover"]');
  for (const [name, value] of Object.entries({ email: user.email, recoveryCode: codes[0], newPassword: 'new synthetic password', confirmPassword: 'new synthetic password' })) form.elements.namedItem(name).value = value;
  h.root.emit('submit', form); await tick(); assert.equal(h.client.snapshot().user, null); assert.ok(h.root.innerHTML.includes(codes[0]));
  const check = h.root.querySelector('[data-account-confirm-codes]'); check.checked = true; h.root.emit('change', check); h.root.click('[data-account-action="ack-codes"]'); assert.equal(h.navigations.at(-1)[0], '/login?next=%2Faccount');
});

test('leaving or switching account suppresses pending private page and late clipboard results', async () => {
  let resolveSession; const h = pageHarness({ overrides: { getSession: () => new Promise(resolve => { resolveSession = resolve; }) } });
  const pending = h.page.activate('/account'); h.page.leave(); resolveSession(user); await pending; assert.equal(h.root.innerHTML, ''); assert.equal(h.navigations.length, 0);
  let rejectCopy; const k = pageHarness({ clipboard: () => new Promise((_, reject) => { rejectCopy = reject; }) }); await k.page.activate('/register');
  const form = k.root.querySelector('[data-account-form="register"]'); for (const [name, value] of Object.entries({ email: user.email, name: '', company: '', password: 'synthetic password', confirmPassword: 'synthetic password' })) form.elements.namedItem(name).value = value;
  k.root.emit('submit', form); await tick(); k.root.click('[data-account-action="copy-codes"]'); await tick(); k.emit(null, 'logout'); rejectCopy(Error('Synthetic late rejection')); await tick(); assert.equal(k.root.innerHTML, '');
});

test('account request tab renders all kinds and legacy truth with escaped details and context-preserving edits',async()=>{
 const old=draftRecord('<img src=x onerror=alert(1)>','OLD099');
 const records=[old,createAccountRequest('testing',(({name,email,company,notes,reportRecipient,samples})=>({name,email,company,notes,reportRecipient,samples}))(old),{...old,id:'AN-REQ-TEST099'}),createAccountRequest('contact',{name:'Contact person',email:'fixture@example.invalid',topic:'website',message:'<script>hostile text</script>'},{...old,id:'AN-REQ-CONTACT099'}),createAccountRequest('report-recovery',{email:'fixture@example.invalid',reference:'Recovery project',notes:'Recovery context'},{...old,id:'AN-REQ-RECOVERY099'})];
 const documents=records.map((record,index)=>({id:'doc-'+index,revision:1,record,createdAt:old.createdAt,updatedAt:old.createdAt}));const root=domRoot(),resumed=[];const client={getSession:async()=>user,snapshot:()=>({user}),subscribe:()=>()=>{},listRequests:async()=>documents};
 const page=createAccountPage({roots:{'/account':root},client,navigate(){},onResume:(doc,owner)=>resumed.push({doc,owner}),onNewRequest(){}});await page.activate('/account');assert.match(root.innerHTML,/My requests/);assert.match(root.innerHTML,/Saved · Not submitted/);assert.match(root.innerHTML,/Report recovery/);assert.match(root.innerHTML,/Contact/);assert.doesNotMatch(root.innerHTML,/<img src=x|device-drafts/);
 for(const document of documents){root.click('[data-account-action="details"][data-id="'+document.id+'"]');assert.match(root.innerHTML,/Delete request/);if(document.record.kind==='contact')assert.match(root.innerHTML,/&lt;script&gt;hostile text/);if(document.record.kind==='testing'){assert.match(root.innerHTML,/Purity|Comprehensive/);assert.doesNotMatch(root.innerHTML,/Batch: Not provided|none · branded/);}root.click('[data-account-action="resume"]');assert.equal(resumed.at(-1).doc.id,document.id);assert.equal(resumed.at(-1).owner,user.id);root.click('[data-account-action="back"]');}
 page.destroy();
});

test('real API acknowledgement is withheld if the cookie owner changes immediately after a successful write',async t=>{
 const fixture=await accountFixture();t.after(()=>fixture.close());const a=browser(fixture.base),b=browser(fixture.base);const accountA=await a.signup('write099-a@example.invalid');await b.signup('write099-b@example.invalid');let active=a;
 const client=createCustomerAccountClient({fetcher:browserFetcher(()=>active,async(route,stage,options)=>{if(route==='/requests'&&options.method==='POST'&&stage==='after')active=b;})});await client.getSession();
 const record=createAccountRequest('contact',{name:'Only A',email:'a@example.invalid',topic:'other',message:'Private A write'},{id:'AN-REQ-WRITE099',createdAt:'2026-11-07T00:00:00.000Z'});
 await assert.rejects(client.saveRequest(record,{ownerId:accountA.data.user.id,idempotencyKey:'post-write-owner-099-key'}),error=>error.code==='owner_changed');assert.equal((await a.call('/requests')).data.requests.length,1);assert.equal((await b.call('/requests')).data.requests.length,0);assert.equal(client.snapshot().user.id,(await b.call('/session')).data.user.id);
});
