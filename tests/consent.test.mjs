import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY, DRAFT_KEY, SUPPORT_DRAFT_KEY, CONTACT_DRAFT_KEY, CATALOG, validateCatalog, catalogSignature, deniedChoices, createReceipt, readReceipt, readPreferenceCookie, effectivePermissions, createServiceGate, createPreferenceSyncGuard, createConsentActionAdapter } from '../dist/privacy/policy.js';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const originalHTML = await readFile(path.join(project, 'dist/index.html'), 'utf8');
const heroOffset = originalHTML.indexOf('<h1 id="hero-title"');
assert.ok(heroOffset >= 0, 'Fixture must contain the hero heading');
const expectedHeroLine = originalHTML.slice(0, heroOffset).split('\n').length;
function fixtureCatalog(events = []) {
  return validateCatalog({
    purposes: [
      { id: 'measurement', kind: 'analytics', label: 'Inert measurement', description: 'Test only; no network.' },
      { id: 'promotion', kind: 'marketing', label: 'Inert promotion', description: 'Test only; no network.' },
      { id: 'sale', kind: 'sale', label: 'Inert sale', description: 'Test only; no network.' },
      { id: 'sharing', kind: 'sharing', label: 'Inert sharing', description: 'Test only; no network.' }
    ],
    services: ['measurement', 'promotion', 'sale', 'sharing'].map((id) => ({
      id: `${id}_test`, purpose: id, label: `Inert ${id}`, description: 'A test hook with no tracking.', retention: 'Test lifetime',
      cookies: [{ name: `${id}_test`, path: '/' }], storage: [{ type: 'localStorage', key: `optional.${id}` }],
      start: async ({ signal }) => events.push(['start', id, signal]), stop: async () => events.push(['stop', id])
    }))
  });
}
function grant(catalog, names = catalog.purposes.map(({ id }) => id), now) {
  const choices = deniedChoices(catalog);
  for (const id of names) choices.purposes[id] = true;
  for (const service of catalog.services) choices.services[service.id] = choices.purposes[service.purpose];
  return createReceipt(catalog, choices, now);
}

test('current catalog has no invented optional purposes or services; default and unknown signal deny', () => {
  assert.deepEqual(validateCatalog(CATALOG), { purposes: [], services: [] });
  const catalog = fixtureCatalog();
  assert.ok(Object.values(effectivePermissions(catalog, null, false)).every((value) => !value));
  for (const signal of [null, undefined, 'false', 0, {}]) assert.ok(Object.values(effectivePermissions(catalog, grant(catalog), signal)).every((value) => !value));
  const partial = grant(catalog, ['measurement']);
  assert.deepEqual(effectivePermissions(catalog, partial, false), { measurement_test: true, promotion_test: false, sale_test: false, sharing_test: false });
});

test('GPC overrides older marketing, sale and sharing grants; other optional purposes still need explicit consent', () => {
  const catalog = fixtureCatalog();
  const oldGrant = grant(catalog, undefined, Date.now() - 10000);
  assert.deepEqual(effectivePermissions(catalog, oldGrant, true), { measurement_test: true, promotion_test: false, sale_test: false, sharing_test: false });
  assert.ok(Object.values(effectivePermissions(catalog, createReceipt(catalog, deniedChoices(catalog)), true)).every((value) => !value));
});

test('versioned receipts reject corrupt, expired, future, unknown-category/service, revision and catalog changes', () => {
  const catalog = fixtureCatalog();
  const now = Date.now();
  const receipt = grant(catalog, undefined, now);
  assert.deepEqual(readReceipt(JSON.stringify(receipt), catalog, now), receipt);
  assert.equal(readReceipt(receipt, catalog, receipt.expiresAt), null);
  assert.equal(readReceipt(receipt, catalog, now - 1), null);
  for (const invalidTime of [NaN, Infinity, -1, 'now']) assert.equal(readReceipt(receipt, catalog, invalidTime), null);
  for (const invalid of [null, 'broken{', {}, [], { ...receipt, version: 99 }, { ...receipt, revision: 99 }, { ...receipt, expiresAt: receipt.expiresAt + 1 }, { ...receipt, catalog: 'different' }, { ...receipt, proof: 'scroll' }, { ...receipt, extra: true }]) assert.equal(readReceipt(invalid, catalog, now), null);
  for (const mutate of [
    (value) => { value.choices.purposes.unknown = true; },
    (value) => { value.choices.services.unknown = true; },
    (value) => { value.choices.purposes.measurement = 'yes'; },
    (value) => { value.choices.purposes.measurement = false; },
    (value) => { delete value.choices.services.measurement_test; }
  ]) { const invalid = structuredClone(receipt); mutate(invalid); assert.equal(readReceipt(invalid, catalog, now), null); }
  const changed = fixtureCatalog();
  const next = validateCatalog({ purposes: changed.purposes.map((item) => ({ ...item, description: `${item.description} Changed.` })), services: changed.services });
  assert.notEqual(catalogSignature(next), catalogSignature(catalog));
  assert.equal(readReceipt(receipt, next, now), null);
});

test('reject and accept have the same 180-day lifetime; withdrawing replaces grants', () => {
  const catalog = fixtureCatalog();
  const now = Date.now();
  const accepted = grant(catalog, undefined, now);
  const rejected = createReceipt(catalog, deniedChoices(catalog), now);
  assert.equal(accepted.expiresAt - now, 180 * 86400000);
  assert.equal(rejected.expiresAt, accepted.expiresAt);
  assert.ok(Object.values(effectivePermissions(catalog, rejected, false)).every((value) => !value));
  assert.throws(() => createReceipt(catalog, { purposes: {}, services: {} }), /Invalid privacy choice/);
});

test('catalog rejects undeclared purposes, missing lifecycle hooks, broad cleanup and necessary storage cleanup', () => {
  const catalog = fixtureCatalog();
  const input = () => ({ purposes: catalog.purposes.map((item) => ({ ...item })), services: catalog.services.map((item) => ({ ...item })) });
  for (const mutate of [
    (value) => { value.services[0].purpose = 'unknown'; },
    (value) => { value.services[0].start = null; },
    (value) => { value.services[0].stop = null; },
    (value) => { value.services[0].cookies = [{ name: /.*/, path: '/' }]; },
    (value) => { value.services[0].cookies = [{ name: POLICY.cookie, path: '/' }]; },
    (value) => { value.services[0].cookies = [{ name: 'test', path: '/', domain: '.example.com' }]; },
    (value) => { value.services[0].storage = [{ type: 'localStorage', key: DRAFT_KEY }]; },
    (value) => { value.services[0].storage = [{ type: 'localStorage', key: SUPPORT_DRAFT_KEY }]; },
    (value) => { value.services[0].storage = [{ type: 'sessionStorage', key: SUPPORT_DRAFT_KEY }]; },
    (value) => { value.services[0].storage = [{ type: 'localStorage', key: CONTACT_DRAFT_KEY }]; },
    (value) => { value.services[0].storage = [{ type: 'sessionStorage', key: CONTACT_DRAFT_KEY }]; },
    (value) => { value.services[0].storage = [{ type: 'localStorage', key: POLICY.cookie }]; },
    (value) => { value.services[1].storage = value.services[0].storage; },
    (value) => { value.purposes.push({ id: 'invented', kind: 'analytics', label: 'Invented', description: 'No service.' }); },
    (value) => { value.purposes[0].kind = 'unknown'; }
  ]) { const value = input(); mutate(value); assert.throws(() => validateCatalog(value), TypeError); }
});

test('service gate starts only after permission, deduplicates, stops/cleans withdrawal, and preserves necessary data', async () => {
  const events = [];
  const catalog = fixtureCatalog(events);
  const storage = new Map([[DRAFT_KEY, 'untouched sentinel'], [SUPPORT_DRAFT_KEY, 'recovery sentinel'], [CONTACT_DRAFT_KEY, 'contact sentinel'], [POLICY.cookie, 'necessary sentinel'], ['optional.measurement', 'inert']]);
  const removedCookies = [];
  const gate = createServiceGate(catalog, {
    removeCookie: (item) => removedCookies.push(item.name), removeStorage: ({ key }) => storage.delete(key)
  });
  await gate.update(null, null);
  assert.equal(events.length, 0);
  const receipt = grant(catalog, ['measurement']);
  await Promise.all([gate.update(receipt, false), gate.update(receipt, false)]);
  assert.equal(events.filter(([event]) => event === 'start').length, 1);
  assert.equal(events[0][2].aborted, false);
  await gate.update(createReceipt(catalog, deniedChoices(catalog)), false);
  assert.equal(events[0][2].aborted, true);
  assert.equal(events.filter(([event]) => event === 'stop').length, 1);
  assert.ok(removedCookies.includes('measurement_test'));
  assert.equal(storage.get(DRAFT_KEY), 'untouched sentinel');
  assert.equal(storage.get(SUPPORT_DRAFT_KEY), 'recovery sentinel');
  assert.equal(storage.get(CONTACT_DRAFT_KEY), 'contact sentinel');
  assert.equal(storage.get(POLICY.cookie), 'necessary sentinel');
  assert.equal(storage.has('optional.measurement'), false);
});

test('withdrawal aborts an in-flight start immediately, then stops its effects without restarting', async () => {
  const original = fixtureCatalog();
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  let signal;
  let stops = 0;
  const catalog = validateCatalog({ purposes: original.purposes, services: original.services.map((service, index) => index ? service : { ...service, start: async (context) => { signal = context.signal; began(); await pending; }, stop: async () => { stops++; } }) });
  const gate = createServiceGate(catalog);
  const first = gate.update(grant(catalog, ['measurement']), false);
  await started;
  const revoked = gate.update(null, null);
  assert.equal(signal.aborted, true);
  release();
  await Promise.all([first, revoked]);
  assert.equal(stops, 1);
});

test('grant/withdraw/grant during an in-flight start cleans the aborted instance before starting a fresh live instance', async () => {
  const original = fixtureCatalog();
  let release;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const signals = [];
  const events = [];
  let live = false;
  const catalog = validateCatalog({ purposes: original.purposes, services: original.services.map((service, index) => index ? service : {
    ...service,
    start: async ({ signal }) => {
      signals.push(signal);
      events.push('start');
      if (signals.length === 1) { began(); await pending; }
      if (signal.aborted) { events.push('aborted-return'); return; }
      live = true;
    },
    stop: async () => { live = false; events.push('stop'); }
  }) });
  const gate = createServiceGate(catalog, { removeStorage: ({ key }) => { if (key === 'optional.measurement') events.push('cleanup'); } });
  const receipt = grant(catalog, ['measurement']);
  const first = gate.update(receipt, false);
  await started;
  const withdraw = gate.update(null, false);
  const regrant = gate.update(receipt, false);
  assert.equal(signals[0].aborted, true);
  release();
  const results = await Promise.all([first, withdraw, regrant]);
  assert.deepEqual(events, ['start', 'aborted-return', 'stop', 'cleanup', 'start']);
  assert.equal(signals.length, 2);
  assert.equal(signals[1].aborted, false);
  assert.equal(live, true);
  assert.deepEqual(results.at(-1).running, ['measurement_test']);
});

test('two-page synchronization denies an old shared grant after failed withdrawal persistence until each page explicitly persists a new choice', async () => {
  const catalog = fixtureCatalog();
  const shared = { cookie: grant(catalog, ['measurement'], Date.now() - 10000), writable: true };
  const pageA = createPreferenceSyncGuard(catalog);
  const pageB = createPreferenceSyncGuard(catalog);
  let liveB = false;
  let stopsB = 0;
  const inertCatalog = validateCatalog({ purposes: catalog.purposes, services: catalog.services.map((service, index) => index ? service : {
    ...service, start: async () => { liveB = true; }, stop: async () => { liveB = false; stopsB++; }
  }) });
  const gateB = createServiceGate(inertCatalog);
  await gateB.update(pageB.receipt(shared.cookie), false);
  assert.equal(liveB, true);
  const ticket = pageA.beginChoice();
  const withdrawn = createReceipt(catalog, deniedChoices(catalog));
  shared.writable = false; // A browser silently refuses the new cookie, preserving the old grant.
  if (shared.writable) shared.cookie = withdrawn;
  const result = pageA.commit(ticket, withdrawn, shared.cookie, shared.cookie);
  assert.equal(result.saved, false);
  assert.deepEqual(result.message, { version: 1, type: 'deny' });
  assert.equal(pageA.receipt(shared.cookie), null);
  assert.equal(pageB.receive(result.message), true);
  await gateB.update(pageB.receipt(shared.cookie), false);
  assert.equal(liveB, false);
  assert.equal(stopsB, 1);
  for (const page of [pageA, pageB]) {
    page.receive({ version: 1, type: 'changed' }); // Initialization/focus rereads the same shared cookie.
    assert.equal(page.receipt(shared.cookie), null);
    assert.equal(page.blocked, true);
    assert.equal(page.receive({ version: 1, type: 'grant' }), false);
  }
  const beforeDeny = pageB.beginChoice();
  pageB.receive(result.message);
  assert.equal(pageB.commit(beforeDeny, shared.cookie, shared.cookie, shared.cookie).saved, false, 'A pending action predating denial cannot unlock the latch');
  shared.writable = true;
  const fresh = grant(catalog, ['measurement']);
  const newAction = pageA.beginChoice();
  shared.cookie = fresh;
  const accepted = pageA.commit(newAction, fresh, shared.cookie, shared.cookie);
  assert.equal(accepted.saved, true);
  assert.equal(pageA.blocked, false);
  pageB.receive(accepted.message);
  assert.equal(pageB.receipt(shared.cookie), null, 'Another page cannot broadcast a grant');
  const localActionB = pageB.beginChoice();
  assert.equal(pageB.commit(localActionB, fresh, shared.cookie, shared.cookie).saved, true);
  await gateB.update(pageB.receipt(shared.cookie), false);
  assert.equal(liveB, true);
});

test('successful withdrawal also broadcasts denial, while passive rereads never clear the session latch', () => {
  const catalog = fixtureCatalog();
  const page = createPreferenceSyncGuard(catalog);
  const previous = grant(catalog);
  const rejected = createReceipt(catalog, deniedChoices(catalog));
  const result = page.commit(page.beginChoice(), rejected, rejected, previous);
  assert.equal(result.saved, true);
  assert.deepEqual(result.message, { version: 1, type: 'deny' });
  const peer = createPreferenceSyncGuard(catalog);
  peer.receive(result.message);
  for (let index = 0; index < 3; index++) {
    peer.receive({ version: 1, type: 'changed' });
    assert.equal(peer.receipt(previous), null);
    assert.equal(peer.receipt(rejected), null);
  }
  assert.equal(peer.commit(null, previous, previous, previous).saved, false, 'A passive reload has no explicit-action ticket');
});

function firstConsentHarness({ writable = true, catalog: input = CATALOG } = {}) {
  const catalog = validateCatalog(input);
  const synchronization = createPreferenceSyncGuard(catalog);
  let internalCookie = {};
  let raw = '';
  let writes = 0;
  const results = [];
  const order = [];
  const write = () => { writes++; if (writable) raw = encodeURIComponent(JSON.stringify(internalCookie)); };
  const readStored = () => readPreferenceCookie(raw, catalog);
  const actions = createConsentActionAdapter(catalog, synchronization, {
    readStored,
    readVendor: () => raw ? JSON.parse(decodeURIComponent(raw)) : {},
    writeReceipt: (receipt) => { order.push('receipt-write'); internalCookie.data = receipt; write(); },
    onResult: (result) => { results.push(result); order.push(result.saved ? 'saved' : 'failed'); }
  });
  return {
    actions, synchronization, results, order, readStored,
    raw: () => raw, writes: () => writes,
    target({ first = true, synchronousCallback = false, action = 'necessary' } = {}) {
      order.push('vendor-target');
      // CookieConsent 3.2.1 Je()/Fe(): first builds and writes the full wrapper.
      // Its UI handlers then defer Ve()->onFirstConsent, onConsent via rAF/timer.
      const categories = ['necessary', ...(action === 'all' ? catalog.purposes.map(({ id }) => id) : [])];
      const services = { necessary: [], ...Object.fromEntries(catalog.purposes.map(({ id }) => [id, action === 'all' ? catalog.services.filter(({ purpose }) => purpose === id).map(({ id }) => id) : []])) };
      const changed = JSON.stringify([categories, services]) !== JSON.stringify([internalCookie.categories, internalCookie.services]);
      internalCookie = { categories, services, revision: POLICY.revision, data: internalCookie.data ?? null };
      if (first || changed) write();
      if (synchronousCallback) this.firstCallback();
    },
    firstCallback() { order.push('onFirstConsent'); actions.onVendorChoice({ cookie: structuredClone(internalCookie) }); },
    consentCallback() { order.push('onConsent'); return synchronization.receipt(readStored()); }
  };
}

test('first-consent controller adapter waits through capture microtasks until the real vendor target write, saves once, and survives delayed first/consent callbacks and reload', async () => {
  const page = firstConsentHarness();
  page.actions.afterDispatch(); // Ordinary click/close/navigation has no explicit-action ticket.
  assert.equal(page.writes(), 0);
  page.order.push('capture');
  page.actions.begin();
  await Promise.resolve(); // Browsers may checkpoint between capture and target listeners.
  page.order.push('microtask-checkpoint');
  assert.equal(page.raw(), '', 'Capture must never write a receipt before the vendor wrapper exists');
  assert.equal(page.writes(), 0);
  assert.equal(page.results.length, 0);
  page.target();
  assert.equal(page.readStored(), null, 'The initial vendor cookie has no first-party receipt yet');
  page.order.push('bubble');
  page.actions.afterDispatch();
  const saved = page.readStored();
  assert.ok(saved);
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].saved, true);
  assert.equal(page.synchronization.blocked, false);
  page.firstCallback();
  assert.deepEqual(page.consentCallback(), saved);
  assert.equal(page.results.length, 1, 'Delayed vendor callbacks cannot consume the action twice or turn success into failure');
  assert.deepEqual(page.order, ['capture', 'microtask-checkpoint', 'vendor-target', 'bubble', 'receipt-write', 'saved', 'onFirstConsent', 'onConsent']);
  const reloaded = createPreferenceSyncGuard(CATALOG);
  assert.deepEqual(reloaded.receipt(readPreferenceCookie(page.raw(), CATALOG)), saved, 'A reload accepts the fully persisted receipt');
});

test('controller adapter also handles synchronous first callback and unchanged settings without duplicate or missing saves', () => {
  const page = firstConsentHarness();
  page.actions.begin();
  page.target({ synchronousCallback: true });
  page.actions.afterDispatch();
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].saved, true);
  const firstWrites = page.writes();
  page.actions.begin();
  page.target({ first: false }); // CookieConsent makes no callback or write for an unchanged selection.
  page.actions.afterDispatch();
  assert.equal(page.writes(), firstWrites + 1);
  assert.equal(page.results.length, 2);
  assert.equal(page.results[1].saved, true);
});

test('first-consent blocked-cookie failure stays honestly denied through the same delayed callback order', async () => {
  const page = firstConsentHarness({ writable: false });
  page.actions.begin();
  await Promise.resolve();
  assert.equal(page.writes(), 0);
  page.target();
  page.actions.afterDispatch();
  page.firstCallback();
  assert.equal(page.consentCallback(), null);
  assert.equal(page.raw(), '');
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].saved, false);
  assert.deepEqual(page.results[0].message, { version: 1, type: 'deny' });
  assert.equal(page.synchronization.blocked, true);
});

test('all versus necessary vendor actions persist exact distinct optional choices through the production adapter', async () => {
  const catalog = fixtureCatalog(); // Inert declared services; the shipped catalog remains empty.
  for (const action of ['all', 'necessary']) {
    const page = firstConsentHarness({ catalog });
    page.actions.begin();
    await Promise.resolve();
    assert.equal(page.writes(), 0, 'Intent alone cannot grant permission');
    page.target({ action });
    assert.equal(page.readStored(), null, 'A vendor selection without a matching receipt is denied');
    page.actions.afterDispatch();
    page.firstCallback();
    const receipt = page.readStored();
    assert.ok(receipt);
    assert.deepEqual(page.consentCallback(), receipt);
    assert.equal(page.results.length, 1);
    assert.equal(page.results[0].saved, true);
    const allowed = action === 'all';
    const expected = deniedChoices(catalog);
    for (const purpose of catalog.purposes) expected.purposes[purpose.id] = allowed;
    for (const service of catalog.services) expected.services[service.id] = allowed;
    assert.deepEqual(receipt.choices, expected);
    assert.deepEqual(JSON.parse(decodeURIComponent(page.raw())).data, receipt, 'Exact persisted read-back includes the intended choices');
    assert.equal(receipt.expiresAt - receipt.issuedAt, 180 * 86400000);
    assert.deepEqual(effectivePermissions(catalog, receipt, false), Object.fromEntries(catalog.services.map(({ id }) => [id, allowed])));
    assert.deepEqual(effectivePermissions(catalog, receipt, true), { measurement_test: allowed, promotion_test: false, sale_test: false, sharing_test: false });
  }
});

test('necessary action withdraws a previously persisted all grant without touching necessary storage', () => {
  const catalog = fixtureCatalog();
  const page = firstConsentHarness({ catalog });
  page.actions.begin();
  page.target({ action: 'all' });
  page.actions.afterDispatch();
  assert.ok(Object.values(effectivePermissions(catalog, page.readStored(), false)).every(Boolean));
  page.actions.begin();
  page.target({ first: false, action: 'necessary' });
  page.actions.afterDispatch();
  const rejected = page.readStored();
  assert.ok(rejected);
  assert.ok(Object.values(effectivePermissions(catalog, rejected, false)).every((value) => !value));
  assert.equal(page.results.at(-1).saved, true);
  assert.deepEqual(page.results.at(-1).message, { version: 1, type: 'deny' });
  const stored = JSON.parse(decodeURIComponent(page.raw()));
  assert.deepEqual(stored.categories, ['necessary']);
  assert.deepEqual(stored.services.necessary, []);
  assert.ok(stored.data, 'The necessary preference receipt remains stored');
});

test('failed stop still cleans declared storage and requires reload before any restart', async () => {
  const original = fixtureCatalog();
  let starts = 0;
  const cleaned = [];
  const errors = [];
  const catalog = validateCatalog({ purposes: original.purposes, services: original.services.map((service) => ({ ...service, start: async () => { starts++; }, stop: async () => { throw new Error('inert stop failure'); } })) });
  const gate = createServiceGate(catalog, { removeStorage: ({ key }) => cleaned.push(key), onError: (error) => errors.push(error.message) });
  const receipt = grant(catalog, ['measurement']);
  await gate.update(receipt, false);
  const result = await gate.update(null, false);
  assert.equal(result.reloadRequired, true);
  assert.ok(cleaned.includes('optional.measurement'));
  assert.deepEqual(errors, ['inert stop failure']);
  await gate.update(receipt, false);
  assert.equal(starts, 1);
});

async function withServer(mode, callback) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'assaynova-consent-test-'));
  let child;
  let exited;
  try {
    for (const name of ['server.mjs', 'dev-client.js', 'dev', 'dist', 'package.json']) await cp(path.join(project, name), path.join(fixture, name), { recursive: true });
    const socket = createServer();
    await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    assert.notEqual(port, 4317);
    child = spawn(process.execPath, ['server.mjs', `--port=${port}`, ...(mode === 'default' ? [] : ['--watch'])], { cwd: fixture, env: { ...process.env, NODE_ENV: mode === 'production' ? 'production' : 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output}`)), 7000);
      const receive = (chunk) => { output += chunk; if (output.includes('Press Ctrl+C to stop.')) { clearTimeout(timer); resolve(); } };
      child.stdout.on('data', receive); child.stderr.on('data', receive);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture exited during startup')); });
    });
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (exited) await exited;
    const target = path.resolve(fixture);
    const parent = path.resolve(tmpdir());
    assert.equal(path.dirname(target).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(target).startsWith('assaynova-consent-test-'));
    assert.notEqual(target.toLowerCase(), parent.toLowerCase());
    await rm(target, { recursive: true, force: true });
  }
}

for (const mode of ['default', 'production', 'watch']) {
  test(`HTTP ${mode}: first-party privacy is always injected and assets are self-hosted`, async () => {
    await withServer(mode, async (base) => {
      const html = await (await fetch(base)).text();
      for (const asset of ['/privacy/consent.js', '/privacy/policy.js', '/privacy/consent.css', '/vendor/cookieconsent-3.2.1/cookieconsent.esm.js', '/vendor/cookieconsent-3.2.1/cookieconsent.css']) {
        const response = await fetch(base + asset);
        assert.equal(response.status, 200, asset);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
        const source = await response.text();
        assert.ok(!/\b(?:src|href)\s*=\s*["']https?:|\b(?:fetch|import)\s*\(\s*["']https?:|url\(\s*["']?https?:/i.test(source), asset);
        assert.equal((await fetch(base + asset, { method: 'HEAD' })).status, 200);
      }
      assert.equal(html.split('src="/privacy/consent.js"').length - 1, 1);
      assert.equal(html.split('href="/privacy/consent.css"').length - 1, 1);
      assert.equal(html.includes('/__dev/client.js'), mode === 'watch');
      assert.equal(html.includes('data-an-dev-file'), mode === 'watch');
      if (mode === 'watch') {
        assert.match(html, new RegExp(`<h1 id="hero-title"[^>]*data-an-dev-line="${expectedHeroLine}">`));
        assert.ok(!/<script[^>]*src="\/privacy\/consent.js"[^>]*data-an-dev/.test(html));
      }
      assert.equal((await fetch(base + '/__dev/events', { method: 'HEAD' })).status, mode === 'watch' ? 405 : 404);
    });
  });
}

test('HTTP signals expose only the Sec-GPC boolean for GET/HEAD, never identifiers or cookies', async () => {
  await withServer('production', async (base) => {
    for (const [header, expected] of [[undefined, false], ['1', true], ['0', false], ['2', false], ['arbitrary', false]]) {
      const response = await fetch(`${base}/privacy/signals?ignored=value`, { headers: header === undefined ? {} : { 'Sec-GPC': header } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { gpc: expected });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('vary'), 'Sec-GPC');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.match(response.headers.get('content-type'), /application\/json/);
    }
    const head = await fetch(`${base}/privacy/signals`, { method: 'HEAD', headers: { 'Sec-GPC': '1' } });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('cache-control'), 'no-store');
    assert.equal(head.headers.get('vary'), 'Sec-GPC');
    assert.equal(head.headers.get('set-cookie'), null);
    assert.equal((await fetch(`${base}/privacy/signals`, { method: 'POST' })).status, 405);
  });
});

test('official optimized vendor bytes and MIT license match recorded SHA-256', async () => {
  const expected = { 'cookieconsent.esm.js': '467e1b7632f2b1919001e46603f878ed04c2267de92b8f27e92cbdf778244107', 'cookieconsent.css': 'dd7ad33177579ec69138b107f107ea6bbb2c3e54cfae9c03ca6691e112b4a711', LICENSE: 'e3cf4e09e007ffede1a8a50aa006b489a5eafd466a2094551a0ac2b308230bfd' };
  for (const [name, hash] of Object.entries(expected)) {
    const bytes = await readFile(path.join(project, 'dist/vendor/cookieconsent-3.2.1', name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
  }
});
