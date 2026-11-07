import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGoogleAccountController, googleNavigation } from '../dist/account-google.js';
import { createCustomerAccountClient, accountUser, AccountError } from '../dist/customer-account.js';
const user = { id: 'synthetic-owner-102', email: 'ui102@example.invalid', emailVerified: false, name: 'Synthetic', company: '', passwordEnabled: false, googleLinked: true };
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
function harness({ ready = true, owner = null, ...overrides } = {}) {
  let currentOwner = owner, completions = 0, starts = 0; const completed = [], states = [], navigations = [];
  const client = { snapshot: () => ({ user: currentOwner }), getSession: async () => currentOwner, googleStatus: async () => ({ ready, intent: ready ? 'login' : null }), googleComplete: async () => { completions++; return { intent: 'login', next: '/account', user }; }, googleStart: async () => { starts++; return { url: 'https://accounts.google.com/o/oauth2/v2/auth?synthetic=1' }; }, ...overrides };
  const controller = createGoogleAccountController({ client, navigateExternal: url => navigations.push(url), onComplete: result => completed.push(result), onState: (...args) => states.push(args) });
  return { controller, client, states, completed, navigations, setOwner(value) { currentOwner = value; }, get completions() { return completions; }, get starts() { return starts; } };
}
test('ready explicit Google intent auto-completes once with no second confirmation or automatic new start', async () => {
  const f = harness(); assert.equal(f.completions, 0); await f.controller.enter(); assert.equal(f.completions, 1); assert.equal(f.completed.length, 1); assert.equal(f.starts, 0);
  await f.controller.enter(); assert.equal(f.completions, 1); assert.equal(f.starts, 0); f.controller.leave(); await f.controller.enter(); assert.equal(f.completions, 1);
});
test('status-only/failed flows do not complete; stale status and completion never paint another owner or page', async () => {
  const off = harness({ ready: false }); await off.controller.enter(); assert.equal(off.completions, 0); assert.equal(off.starts, 0);
  let release; const pending = harness({ googleStatus: () => new Promise(resolve => { release = resolve; }) }); const entering = pending.controller.enter(); await Promise.resolve(); pending.setOwner(user); release({ ready: true, intent: 'login' }); await entering; assert.equal(pending.completions, 0);
  let finish; const stale = harness({ googleComplete: () => new Promise(resolve => { finish = resolve; }) }); const entering2 = stale.controller.enter(); await Promise.resolve(); await Promise.resolve(); stale.controller.leave(); finish({ intent: 'login', user }); await entering2; assert.equal(stale.completed.length, 0);
});
test('uncertain completion confirms session and only same ready context permits bounded manual retry', async () => {
  let calls = 0, sessions = 0;
  const f = harness({ getSession: async () => { sessions++; return null; }, googleComplete: async () => { if (++calls === 1) throw new AccountError('network'); return { intent: 'login', next: '/account', user }; } });
  await f.controller.enter(); assert.equal(calls, 1); assert.equal(sessions, 2); assert.equal(f.states.at(-1)[0], 'retryable'); await f.controller.retry(); assert.equal(calls, 2); assert.equal(f.completed.length, 1); await f.controller.retry(); assert.equal(calls, 2);
});
test('navigation accepts only the pinned Google HTTPS authorization endpoint on explicit action', async () => {
  for (const value of ['http://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com.evil.invalid/o/oauth2/v2/auth', 'https://accounts.google.com/token', 'https://user@accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com:444/o/oauth2/v2/auth', 'javascript:alert(1)', 'https://accounts.google.com/o/oauth2/v2/auth#private']) assert.throws(() => googleNavigation(value));
  const f = harness(); await f.controller.begin('login', '/account'); assert.equal(f.starts, 1); assert.equal(f.navigations.length, 1); assert.equal(f.completions, 0);
});
test('client Google completion shares normal CSRF, validates DTO flags and cannot replace a signed-in owner', async () => {
  assert.equal(accountUser({ ...user, passwordEnabled: undefined }).passwordEnabled, true); for (const key of ['passwordEnabled', 'googleLinked']) for (const value of [null, 1, 'true']) assert.throws(() => accountUser({ ...user, [key]: value }));
  let actualUser=null; const calls = [], c = createCustomerAccountClient({ fetcher: async (url, options) => { calls.push({ url, options }); if(url.endsWith('/session'))return response({authenticated:!!actualUser,user:actualUser,csrfToken:actualUser?'fresh-csrf':'synthetic-csrf',google:{enabled:true}});actualUser=user;return response({intent:'login',next:'/account',user,csrfToken:'new-csrf',google:{enabled:true},recoveryCodes:['synthetic']}); } });
  await c.getSession(); await c.googleComplete(); assert.equal(c.snapshot().user.id, user.id); assert.equal(c.snapshot().google.enabled, true); assert.equal(calls[1].options.headers['X-Account-CSRF'], 'synthetic-csrf'); assert.deepEqual(JSON.parse(calls[1].options.body), {}); assert.equal(calls[1].options.credentials, 'same-origin');
  await assert.rejects(c.googleComplete(), e => e.code === 'owner_changed');
});
test('Google controller import is pure, official local button has no remote SDK or private persistence', async () => {
  const source = await readFile(new URL('../dist/account-google.js', import.meta.url), 'utf8'), page = await readFile(new URL('../dist/account-page.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|https:\/\/.*userinfo|access_token|refresh_token/); assert.match(page, /\/assets\/google-signin-light\.png/); assert.match(page, /aria-label="Continue with Google"/); assert.doesNotMatch(page, /accounts\.google\.com\/gsi\/client/); assert.match(page, /createGoogleAccountController/); assert.match(page, /googleController\.leave\(\)/);
});

function acknowledgedCompletion(intent, replacement) {
  const accountA = { ...user, googleLinked: true, name: 'Confirmed session profile' }, accountB = { ...user, id: 'synthetic-other-102', email: 'other102@example.invalid' };
  let actualUser = intent === 'login' ? null : accountA, ready = true, posts = 0;
  const completed = [], states = [], changes = [], requests = [];
  const privateCodes = Array.from({ length: 8 }, (_, index) => 'SYNTHETICPRIVATE102CODE' + index);
  const client = createCustomerAccountClient({ fetcher: async (url, options) => {
    requests.push(url);
    if (url.endsWith('/session')) return response({ authenticated: !!actualUser, user: actualUser, csrfToken: actualUser ? 'fresh-session-csrf-' + actualUser.id : 'fresh-preauth-csrf', mail: { enabled: false }, google: { enabled: true } });
    if (url.endsWith('/status')) return response({ ready, intent: ready ? intent : null });
    assert.ok(url.endsWith('/complete')); posts++; ready = false; actualUser = accountA;
    return { ok: true, status: 200, json: async () => {
      actualUser = replacement === 'other' ? accountB : replacement === 'logout' ? null : accountA;
      return { intent, next: '/account', user: { ...accountA, name: 'Earlier POST profile' }, csrfToken: 'earlier-post-csrf', mail: { enabled: false }, google: { enabled: true }, ...(intent === 'login' ? { recoveryCodes: privateCodes } : {}) };
    } };
  } });
  client.subscribe((value, reason) => changes.push({ id: value?.id || null, reason }));
  const controller = createGoogleAccountController({ client, onComplete: value => completed.push(value), onState: (...args) => states.push(args) });
  return { client, controller, completed, states, changes, requests, privateCodes, accountA, accountB, get posts() { return posts; } };
}

test('actual client and controller suppress A completion/codes when the cookie becomes B or logged out after POST commit before JSON acknowledgement', async () => {
  for (const intent of ['login', 'link', 'reauth']) for (const replacement of ['other', 'logout']) {
    const f = acknowledgedCompletion(intent, replacement); await f.controller.enter();
    assert.equal(f.posts, 1); assert.equal(f.completed.length, 0); assert.equal(f.client.snapshot().user?.id || null, replacement === 'other' ? f.accountB.id : null);
    assert.equal(f.states.at(-1)[0], 'error'); assert.equal(f.states.at(-1)[1].code, 'owner_changed');
    assert.ok(f.requests.at(-1).endsWith('/session'), 'Completion must be followed by a fresh owner GET');
    if (intent === 'login') { assert.ok(f.privateCodes.every(value => value === '')); assert.equal(f.changes.some(change => change.id === f.accountA.id), false); }
    await f.controller.retry(); await f.controller.enter(); assert.equal(f.posts, 1, 'Consumed completion must never replay automatically'); assert.equal(f.completed.length, 0);
  }
});

test('actual client/controller successful login, link and reauth release only owner-confirmed results and retain fresh session metadata', async () => {
  for (const intent of ['login', 'link', 'reauth']) {
    const f = acknowledgedCompletion(intent, 'stable'); await f.controller.enter();
    assert.equal(f.posts, 1); assert.equal(f.completed.length, 1); assert.equal(f.completed[0].intent, intent); assert.equal(f.completed[0].user.id, f.accountA.id); assert.equal(f.completed[0].user.name, 'Confirmed session profile'); assert.equal(f.completed[0].csrfToken, 'fresh-session-csrf-' + f.accountA.id);
    if (intent === 'login') assert.deepEqual(f.completed[0].recoveryCodes, f.privateCodes);
    await f.controller.enter(); assert.equal(f.posts, 1); assert.equal(f.completed.length, 1);
  }
});

test('Google setup/unlink withhold returned user on the same post-commit cookie race and preserve stable successful actions', async () => {
  for (const action of ['setupPassword', 'googleUnlink']) for (const replacement of ['other', 'logout', 'stable']) {
    let actualUser = user, posts = 0; const other = { ...user, id: 'other-action102', email: 'other-action102@example.invalid' }, confirmed = { ...user, passwordEnabled: true, googleLinked: action !== 'googleUnlink' };
    const client = createCustomerAccountClient({ fetcher: async (url, options) => {
      if (url.endsWith('/session')) return response({ authenticated: !!actualUser, user: actualUser, csrfToken: 'fresh-action-csrf', google: { enabled: true } });
      posts++; return { ok: true, status: 200, json: async () => { actualUser = replacement === 'other' ? other : replacement === 'logout' ? null : confirmed; return { user: confirmed, csrfToken: 'older-action-csrf', google: { enabled: true } }; } };
    } });
    await client.getSession();
    if (replacement === 'stable') assert.deepEqual(await client[action]('Synthetic action password 102'), confirmed);
    else await assert.rejects(client[action]('Synthetic action password 102'), error => error.code === 'owner_changed');
    assert.equal(posts, 1); assert.equal(client.snapshot().user?.id || null, replacement === 'other' ? other.id : replacement === 'logout' ? null : user.id);
  }
});

test('logout revision during the fresh completion owner GET aborts late private acknowledgement', async () => {
  let actualUser = null, release, entered; const pendingGet = new Promise(resolve => { entered = resolve; }), privateCodes = Array(8).fill('SYNTHETIC-PRIVATE-102'); let afterCommit = false;
  const client = createCustomerAccountClient({ fetcher: async (url, options) => {
    if (url.endsWith('/session')) {
      if (afterCommit) { entered(); return new Promise(resolve => { release = () => resolve(response({ authenticated: true, user, csrfToken: 'old-owner-csrf', google: { enabled: true } })); }); }
      return response({ authenticated: false, user: null, csrfToken: 'challenge-csrf', google: { enabled: true } });
    }
    if (url.endsWith('/logout')) { actualUser = null; return response({ ok: true }); }
    afterCommit = true; actualUser = user; return response({ intent: 'login', next: '/account', user, csrfToken: 'post-csrf', google: { enabled: true }, recoveryCodes: privateCodes });
  } });
  await client.getSession(); const pending = client.googleComplete(); await pendingGet; await client.logout(); release(); await assert.rejects(pending, error => error.code === 'aborted'); assert.equal(actualUser, null); assert.equal(client.snapshot().user, null); assert.ok(privateCodes.every(value => value === ''));
});
