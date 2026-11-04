import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as reportData from '../dist/data.js';
import * as pageData from '../dist/routes.js';
import { DEMO_REPORT, DEMO_REPORTS, normalizeLookupCode, findReportByLookupCode, findLegacyReport, reportPath, lookupResultPath, resolveCOARoute, validateSubmission } from '../dist/data.js';

test('published immutable lookup codes identify two distinct fictional report records', () => {
  assert.ok(Object.isFrozen(DEMO_REPORTS));
  assert.equal(DEMO_REPORTS.length, 2);
  assert.equal(DEMO_REPORT, DEMO_REPORTS[0]);
  const first = findReportByLookupCode('AN-7K9Q-2M4X');
  const second = findReportByLookupCode('AN-8P6R-3N5Y');
  assert.equal(first.id, 'AN-2026-0042');
  assert.equal(first.sample, 'Reference sample A');
  assert.equal(second.sample, 'Reference sample C');
  for (const key of ['id', 'batch', 'purity', 'identity', 'identityOutcome', 'retentionTime', 'lookupCode']) assert.notEqual(first[key], second[key], key);
  assert.equal(first.identityOutcome, 'matched');
  assert.equal(second.identityOutcome, 'partial');
  for (const report of DEMO_REPORTS) {
    assert.ok(Object.isFrozen(report));
    assert.equal(report.publication, 'published');
    assert.notEqual(report.lookupCode, report.id);
    assert.match(report.disclaimer, /Fictional data/);
    assert.match(report.disclaimer, /Not a valid certificate of analysis/);
    assert.throws(() => { report.lookupCode = 'AN-0000-0000'; }, TypeError);
  }
});

test('lookup trims/case-normalizes exactly and rejects unknown, blank, malformed and report/submission IDs', () => {
  assert.equal(normalizeLookupCode('  an-7k9q-2m4x\n'), 'AN-7K9Q-2M4X');
  assert.equal(findReportByLookupCode('  an-7k9q-2m4x\n'), DEMO_REPORT);
  for (const value of ['', ' ', null, undefined, {}, 42, 'AN-7K9Q', '7K9Q-2M4X', 'AN-7K9Q-2M4X-extra', 'AN-7K9Q- 2M4X', 'AN-0000-0000', 'AN-2026-0042', 'AN-2026-0043', 'AN-DEMO-12345678', 'ＡＮ-7K9Q-2M4X', 'AN-7K9Q-2M4X'.repeat(100)]) {
    assert.equal(findReportByLookupCode(value), null, String(value));
  }
});

test('draft/unpublished and ambiguous duplicate codes reveal no selected record', () => {
  const draft = { ...DEMO_REPORT, publication: 'draft' };
  assert.equal(findReportByLookupCode(DEMO_REPORT.lookupCode, [draft]), null);
  assert.equal(findReportByLookupCode(DEMO_REPORT.lookupCode, [{ ...DEMO_REPORT, publication: undefined }]), null);
  for (const duplicate of [{ ...DEMO_REPORT }, { ...draft }, { ...DEMO_REPORT, lookupCode: DEMO_REPORT.lookupCode.toLowerCase() }]) {
    assert.equal(findReportByLookupCode(DEMO_REPORT.lookupCode, [DEMO_REPORT, duplicate]), null);
  }
  assert.equal(findReportByLookupCode(DEMO_REPORT.lookupCode, null), null);
});

test('canonical paths, narrow route parsing and explicit legacy-ID resolution stay separate', () => {
  for (const report of DEMO_REPORTS) {
    const canonical = '/coa/' + report.lookupCode;
    assert.equal(reportPath(report.lookupCode.toLowerCase()), canonical);
    assert.equal(resolveCOARoute(canonical).report, report);
    assert.equal(resolveCOARoute(canonical.toLowerCase() + '/').canonicalPath, canonical);
    assert.equal(findLegacyReport(' ' + report.id.toLowerCase() + ' '), report);
    assert.equal(findReportByLookupCode(report.id), null);
    assert.equal(new URL(canonical, 'http://127.0.0.1:4318').origin, 'http://127.0.0.1:4318');
  }
  assert.equal(findLegacyReport(DEMO_REPORT.lookupCode), null);
  assert.equal(findLegacyReport('AN-DEMO-12345678'), null);
  assert.equal(reportPath('AN-2026-0042'), null);
  assert.equal(resolveCOARoute('/coa/AN-0000-0000').report, null);
  assert.equal(resolveCOARoute('/coa/unknown').canonicalPath, null);
  assert.equal(resolveCOARoute('/coa/%41N-7K9Q-2M4X').report, DEMO_REPORT);
  for (const route of ['/', '/other', '/coa/', '/coa/a/b', '/coa/AN-7K9Q-2M4X/app.js', '/coa/unknown.css', '/coa/%2Fetc', '/coa/%ZZ', '/coa/' + 'A'.repeat(65)]) assert.equal(resolveCOARoute(route), null, route);
});

test('existing submission validation still validates requests independently from lookup', () => {
  assert.deepEqual(validateSubmission({ name: 'Demo person', email: 'demo@example.invalid', sample: 'Demo sample', service: 'purity', quantity: '1' }), {});
  assert.ok(validateSubmission({ name: '', email: '', sample: '', service: 'missing', quantity: '0' }).sample);
});

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appSource = await readFile(path.join(project, 'dist/app.js'), 'utf8');

test('failed lookup destinations are safe, refreshable not-found routes rather than stale report URLs', () => {
  for (const value of ['AN-0000-0000', 'AN-2026-0042', '', '   ', '<script>alert(1)</script>', 'AN-7K9Q- 2M4X', '../secret?value=private']) {
    const destination = lookupResultPath(value);
    assert.match(destination, /^\/coa\/[A-Za-z0-9-]+$/);
    assert.equal(resolveCOARoute(destination).report, null);
    assert.ok(!destination.includes('private'));
  }
  assert.equal(lookupResultPath('an-8p6r-3n5y '), '/coa/AN-8P6R-3N5Y');
});

// Minimal DOM adapters run the actual app event handlers and History transitions.
// They do not replace browser acceptance for layout, focus or native navigation.
function bootApp(initialPath = '/', savedRequests = [], { storageBlocked = false, clipboardBlocked = false } = {}) {
  const documentEvents = new Map();
  const windowEvents = new Map();
  const nodes = new Map();
  const copied = [];
  const networkCalls = [];
  const storage = new Map([['assaynova.prototype.requests.v1', JSON.stringify(savedRequests)]]);
  let printed = 0;
  let focused = null;
  const scrolls = [];
  const frames = [];
  let nextTarget = 0;
  let mediaChange;
  let currentURL = new URL(initialPath, 'http://127.0.0.1:4999');
  let entries = [currentURL.href];
  let cursor = 0;
  const node = (name) => {
    if (nodes.has(name)) return nodes.get(name);
    const events = new Map();
    const attributes = new Map();
    let html = '';
    const value = {
      id: name.replace(/^#/, ''), tagName: 'DIV', parent: null, dataset: {}, isConnected: true, hidden: false, open: false, htmlWrites: 0, textContent: '', value: '', values: {}, events, attributes,
      get innerHTML() { return html; }, set innerHTML(value) { html = value; this.htmlWrites++; },
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, callback) { events.set(type, callback); },
      setAttribute(key, value) { attributes.set(key, String(value)); }, getAttribute(key) { return attributes.get(key) ?? null; }, hasAttribute(key) { return attributes.has(key); }, removeAttribute(key) { attributes.delete(key); },
      focus() { focused = name; document.activeElement = this; }, select() {}, scrollIntoView() { scrolls.push(this.id); },
      matches(selector) { return selector.split(',').some((item) => item === 'a[href]' ? this.tagName === 'A' && attributes.has('href') : item === '[data-action]' ? !!this.dataset.action : item === '[hidden]' ? this.hidden : item.startsWith('#') && this.id === item.slice(1)); },
      closest(selector) { for (let current = this; current; current = current.parent) if (current.matches(selector)) return current; return null; },
      close() { this.open = false; events.get('close')?.(); }, showModal() { this.open = true; },
      elements: { namedItem(key) { return node('#request-' + key); } },
      requestSubmit() { for (const callback of documentEvents.get('submit') || []) callback({ target: this, preventDefault() {} }); },
      querySelector(selector) { return selector === '[aria-invalid=true]' ? [...nodes.values()].find((item) => item.attributes.get('aria-invalid') === 'true') : selector === 'input[name="lookupCode"]' ? node(this.id === 'verify-form' ? '#report-id' : '#coa-lookup-code') : node(selector); },
      querySelectorAll(selector) { return [...nodes.values()].filter((item) => selector === '[aria-invalid]' ? item.attributes.has('aria-invalid') : selector === '.field-error' && item.id.startsWith('error-')); }
    };
    nodes.set(name, value);
    return value;
  };
  const location = Object.fromEntries(['href', 'pathname', 'origin', 'search', 'hash'].map((key) => [key, '']));
  for (const key of Object.keys(location)) Object.defineProperty(location, key, { get: () => currentURL[key] });
  const history = {
    pushState(_state, _title, destination) { currentURL = new URL(destination, currentURL); entries = entries.slice(0, cursor + 1); entries.push(currentURL.href); cursor++; },
    replaceState(_state, _title, destination) { currentURL = new URL(destination, currentURL); entries[cursor] = currentURL.href; }
  };
  const document = {
    title: 'AssayNova', activeElement: null, body: node('body'),
    querySelector: node,
    querySelectorAll(selector) { return selector === '.desktop-nav a,.mobile-nav a' ? navLinks : []; },
    getElementById(id) { return node('#' + id); },
    addEventListener(type, callback) {
      if (!documentEvents.has(type)) documentEvents.set(type, []);
      documentEvents.get(type).push(callback);
    }
  };
  const navLinks = [];
  for (const route of pageData.PAGE_ROUTES) {
    node('#' + route.heading).parent = node('#' + route.view);
    for (const kind of ['desktop', 'mobile']) {
      const link = node(`${kind}-nav-${route.path}`);
      link.tagName = 'A'; link.setAttribute('href', route.path);
      if (kind === 'mobile') link.parent = node('#mobile-nav');
      navLinks.push(link);
    }
  }
  node('#report-title').parent = node('#coa-view');
  node('#main').setAttribute('tabindex', '-1');
  node('#mobile-nav').hidden = true;
  node('.menu-toggle').setAttribute('aria-expanded', 'false');
  const window = {
    location, scrollTo(...args) { scrolls.push(args); }, print() { printed++; },
    addEventListener(type, callback) { windowEvents.set(type, callback); },
    matchMedia() { return { addEventListener(_type, callback) { mediaChange = callback; } }; }
  };
  const runnable = appSource.replace(/^(?:import[^\n]+\r?\n)+/, '');
  assert.notEqual(runnable, appSource);
  const unexpectedNetwork = (...args) => { networkCalls.push(args); throw new Error('This draft-only workflow must not send network requests'); };
  runInNewContext(runnable, {
    ...reportData, ...pageData, document, window, location, history, URL,
    navigator: { clipboard: { writeText(value) { copied.push(value); return clipboardBlocked ? Promise.reject(new Error('Synthetic clipboard restriction')) : Promise.resolve(); } }, sendBeacon: unexpectedNetwork },
    fetch: unexpectedNetwork, XMLHttpRequest: class { constructor() { unexpectedNetwork('XMLHttpRequest'); } },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => { if (storageBlocked) throw new Error('Synthetic storage restriction'); storage.set(key, value); } },
    crypto: { randomUUID: () => '12345678-0000-0000-0000-000000000000' },
    FormData: class { constructor(form) { this.form = form; } entries() { return Object.entries(this.form.values); } },
    requestAnimationFrame: (callback) => frames.push(callback), setTimeout: () => 0, clearTimeout() {}
  });
  function dispatch(target, options = {}) {
    document.activeElement = target;
    const event = { target, button: 0, defaultPrevented: false, ...options, preventDefault() { this.defaultPrevented = true; } };
    if (target.closest('#mobile-nav')) node('#mobile-nav').events.get('click')?.(event);
    for (const callback of documentEvents.get('click') || []) callback(event);
    return event;
  }
  return {
    nodes, copied, location, networkCalls, document, navLinks, scrolls, printed: () => printed, focused: () => focused, entryCount: () => entries.length,
    visibleViews: () => [...pageData.PAGE_ROUTES.map(({ view }) => '#' + view), '#coa-view'].filter((id) => !node(id).hidden),
    requests: () => JSON.parse(storage.get('assaynova.prototype.requests.v1')),
    click(action, extra = {}, { mobile = false } = {}) {
      const target = node('trigger-' + nextTarget++); target.tagName = 'BUTTON'; target.dataset = { action, ...extra };
      if (mobile) target.parent = node('#mobile-nav');
      return dispatch(target);
    },
    clickLink(href, { mobile = false, target: browsingTarget, download, dataAction, ...options } = {}) {
      const link = node('anchor-' + nextTarget++); link.tagName = 'A'; link.setAttribute('href', href);
      if (browsingTarget !== undefined) link.setAttribute('target', browsingTarget);
      if (download !== undefined) link.setAttribute('download', download);
      if (dataAction) link.dataset.action = dataAction;
      if (mobile) link.parent = node('#mobile-nav');
      return dispatch(link, options);
    },
    symbolClick() { return dispatch(node('use-symbol')); },
    openMenu() { node('.menu-toggle').focus(); node('.menu-toggle').events.get('click')(); },
    desktopResize() { mediaChange({ matches: true }); },
    hash(hash, { focusTarget } = {}) {
      const oldURL = currentURL.href;
      history.pushState(null, '', hash);
      windowEvents.get('popstate')({ state: null });
      // Actual browsers perform fragment focusing after popstate listeners. An
      // unfocusable fragment target clears synchronous route focus to the body.
      if (focusTarget) {
        assert.ok(node('#' + focusTarget).hasAttribute('tabindex') || focusTarget === 'report-title');
        node('#' + focusTarget).focus();
      } else node('body').focus();
      windowEvents.get('hashchange')({ oldURL, newURL: currentURL.href });
    },
    flushFrames() { for (const callback of frames.splice(0)) callback(0); },
    hashEvent() { windowEvents.get('hashchange')(); },
    submitLookup(value, publicView = true) {
      const input = node(publicView ? '#coa-lookup-code' : '#report-id');
      input.value = value;
      const form = { id: publicView ? 'coa-lookup-form' : 'verify-form', matches: () => true, querySelector: () => input };
      for (const callback of documentEvents.get('submit') || []) callback({ target: form, preventDefault() {} });
    },
    saveRequest(values) {
      const form = node('#submission-form');
      form.values = values;
      form.events.get('submit')({ preventDefault() {} });
    },
    travel(delta) {
      const oldURL = currentURL.href;
      cursor += delta;
      assert.ok(cursor >= 0 && cursor < entries.length);
      currentURL = new URL(entries[cursor]);
      windowEvents.get('popstate')();
      if (new URL(oldURL).hash !== currentURL.hash) windowEvents.get('hashchange')({ oldURL, newURL: currentURL.href });
    }
  };
}

test('actual public form handlers clear A on failure, survive refresh/history and then select C exactly', () => {
  const master = (html, code, stem) => {
    const other = stem === 'sample-a' ? 'sample-c' : 'sample-a';
    assert.ok(html.includes(`src="/reports/${stem}.svg"`));
    assert.ok(html.includes(`href="/reports/${stem}.pdf" download`));
    assert.ok(html.includes(code));
    assert.ok(!html.includes(`/reports/${other}.`));
    assert.ok(!/AN-2026-004[23]|99\.32%|97\.84%|Consistent|Partial match|identity-matched|identity-neutral|Chromatogram schematic/.test(html));
    assert.ok(html.includes('Report fields'));
    assert.ok(html.includes('[Product name]') && html.includes('Dylan Greene'));
    assert.equal((html.match(/<dd>--\.--%<\/dd>/g) || []).length, 3);
  };
  const app = bootApp('/coa/AN-7K9Q-2M4X');
  const view = app.nodes.get('#coa-view');
  master(view.innerHTML, 'AN-7K9Q-2M4X', 'sample-a');
  assert.equal(app.document.title, 'Sample report · AN-7K9Q-2M4X · AssayNova');
  app.submitLookup('AN-0000-0000');
  assert.equal(app.location.pathname, '/coa/AN-0000-0000');
  assert.ok(view.innerHTML.includes('No COA found.'));
  assert.ok(!/\/reports\/sample-[ac]\.(?:svg|pdf)|coa-master-paper/.test(view.innerHTML));
  assert.ok(!/data-action="(?:print|copy-code|copy-link)"/.test(view.innerHTML));
  app.click('copy-code'); app.click('print');
  assert.equal(app.copied.length, 0);
  assert.equal(app.printed(), 0);
  assert.ok(bootApp(app.location.pathname).nodes.get('#coa-view').innerHTML.includes('No COA found.'));
  app.travel(-1);
  master(view.innerHTML, 'AN-7K9Q-2M4X', 'sample-a');
  app.travel(1);
  assert.ok(view.innerHTML.includes('No COA found.'));
  app.submitLookup('<script>private</script>');
  assert.equal(app.location.pathname, '/coa/not-found');
  assert.ok(bootApp(app.location.pathname).nodes.get('#coa-view').innerHTML.includes('No COA found.'));
  app.submitLookup('an-8p6r-3n5y ');
  assert.equal(app.location.pathname, '/coa/AN-8P6R-3N5Y');
  master(view.innerHTML, 'AN-8P6R-3N5Y', 'sample-c');
  assert.ok(view.innerHTML.includes('Reference sample C'));
  assert.equal(app.document.title, 'Sample report · AN-8P6R-3N5Y · AssayNova');
  app.click('copy-code'); app.click('copy-link');
  assert.deepEqual(app.copied, ['AN-8P6R-3N5Y', 'http://127.0.0.1:4999/coa/AN-8P6R-3N5Y']);
  app.travel(-1); assert.ok(view.innerHTML.includes('No COA found.'));
  app.travel(1); master(view.innerHTML, 'AN-8P6R-3N5Y', 'sample-c');
  app.click('home');
  assert.equal(view.innerHTML, '');
  app.click('copy-code');
  assert.equal(app.copied.length, 2);
  app.clickLink('/verify');
  app.submitLookup('bad input', false);
  assert.equal(app.location.pathname, '/verify');
  assert.match(app.nodes.get('#verify-error').textContent, /No COA found/);
});

test('normal product labels retain sample-report honesty and new drafts preserve old stored references', async () => {
  const homeHTML = await readFile(path.join(project, 'dist/index.html'), 'utf8');
  const text = (html) => html.replace(/<[^>]*>/g, ' ');
  assert.ok(!homeHTML.includes('class="preview-bar"'));
  assert.ok(!/\b(?:demo|concept|prototype|preview)\b/i.test(text(homeHTML)));
  assert.equal((homeHTML.match(/data-action="portal">Saved drafts/g) || []).length, 3);
  assert.ok(!/Client portal|CLIENT WORKSPACE|YOUR WORKSPACE/.test(homeHTML));
  const publicReports = homeHTML.match(/<section id="home-reports"[\s\S]*?<\/section>/)[0];
  assert.match(publicReports, /Sample reports/);
  for (const code of ['AN-7K9Q-2M4X', 'AN-8P6R-3N5Y']) assert.ok(publicReports.includes(`data-action="report" data-lookup-code="${code}"`));
  assert.match(publicReports, /href="\/verify">Find a COA/);
  const sample = bootApp('/coa/AN-7K9Q-2M4X');
  assert.match(text(sample.nodes.get('#coa-view').innerHTML), /Sample report/);
  assert.match(text(sample.nodes.get('#coa-view').innerHTML), /Not a valid certificate of analysis/);
  const old = { id: 'AN-DEMO-OLD12345', sample: 'Older saved sample', name: 'Saved name', email: 'saved@example.invalid', service: 'purity', quantity: 1 };
  const app = bootApp('/', [old]);
  app.click('requests');
  assert.ok(app.nodes.get('#dialog-content').innerHTML.includes(old.id));
  app.click('submit');
  assert.match(text(app.nodes.get('#dialog-content').innerHTML), /Save request/);
  assert.match(text(app.nodes.get('#dialog-content').innerHTML), /Saving does not send your request/);
  app.saveRequest({ name: 'New saved name', email: 'new@example.invalid', company: '', sample: 'New saved sample', service: 'purity', quantity: '1', notes: '' });
  assert.equal(app.requests().length, 2);
  assert.match(app.requests()[0].id, /^AN-REQ-/);
  assert.equal(app.requests()[1].id, old.id);
  const confirmation = text(app.nodes.get('#dialog-content').innerHTML);
  assert.match(confirmation, /Draft · Not sent/);
  assert.match(confirmation, /has not been sent to the laboratory/);
  assert.ok(!/\b(?:demo|concept|prototype|preview)\b/i.test(confirmation));
});

test('both saved-draft entry actions show only this device drafts with a keyboard-scrollable native panel', () => {
  const old = { id: 'AN-DEMO-LEGACY01', sample: 'Synthetic local draft', email: 'local@example.invalid', service: 'purity', quantity: 1 };
  for (const saved of [[], [old]]) {
    const app = bootApp('/', saved);
    let firstView;
    for (const action of ['portal', 'requests']) {
      app.click(action);
      const html = app.nodes.get('#dialog-content').innerHTML;
      assert.match(html, /id="dialog-title">Saved drafts/);
      assert.match(html, /stored only in this browser/);
      assert.match(html, /These are saved drafts, not submitted requests/);
      assert.match(html, /<section[^>]*id="panel-requests"[^>]*tabindex="0"/);
      assert.ok(!/role="tab|panel-reports|data-tab=|data-action="report"|Reference sample [AC]|AN-2026-004[23]/.test(html));
      assert.ok(html.includes(saved.length ? old.id : 'No saved drafts yet.'));
      if (firstView) assert.equal(html, firstView);
      firstView = html;
    }
    app.click('request-detail', { id: 'missing-synthetic-id' });
    assert.equal(app.nodes.get('#dialog-content').innerHTML, firstView);
    app.click('submit');
    assert.match(app.nodes.get('#dialog-content').innerHTML, /id="submission-form"/);
    app.click('close');
    assert.equal(app.nodes.get('#app-dialog').open, false);
    assert.equal(app.networkCalls.length, 0);
  }
});

test('actual request handler requires a contact email, associates its helper and saves an unverified unsent local draft', () => {
  const old = { id: 'AN-DEMO-KEEP001', sample: 'Synthetic older draft', email: 'older@example.invalid', service: 'purity', quantity: 1 };
  const app = bootApp('/', [old]);
  app.click('submit');
  const formHTML = app.nodes.get('#dialog-content').innerHTML;
  const emailInput = formHTML.match(/<input[^>]*id="request-email"[^>]*>/)[0];
  for (const attribute of ['type="email"', 'required', 'maxlength="160"', 'autocomplete="email"', 'aria-describedby="request-email-help error-email"']) assert.ok(emailInput.includes(attribute));
  assert.match(formHTML, /id="request-email-help"/);
  assert.match(formHTML, /Request draft/);
  assert.match(formHTML, /On this device/);
  assert.match(formHTML, /Saving does not send your request or email/);
  assert.ok(!/type="password"|data-action="(?:login|register|send)"|mailto:/.test(formHTML));
  const values = { name: 'Synthetic contact', email: '', company: '', sample: 'Synthetic new draft', service: 'purity', quantity: '1', notes: '' };
  for (const email of ['', 'invalid-address']) {
    app.saveRequest({ ...values, email });
    assert.match(app.nodes.get('#error-email').textContent, /valid email address/);
    assert.equal(app.nodes.get('#request-email').attributes.get('aria-invalid'), 'true');
    assert.equal(app.focused(), '#request-email');
    assert.deepEqual(app.requests(), [old]);
  }
  app.saveRequest({ ...values, email: '  a&b@example.invalid  ' });
  assert.equal(app.nodes.get('#request-email').attributes.has('aria-invalid'), false);
  assert.equal(app.requests().length, 2);
  assert.equal(app.requests()[0].email, 'a&b@example.invalid');
  assert.equal(app.requests()[0].status, 'Draft request');
  assert.match(app.requests()[0].id, /^AN-REQ-/);
  assert.equal(app.requests()[1].id, old.id);
  const confirmation = app.nodes.get('#dialog-content').innerHTML;
  assert.match(confirmation, /Draft · Not sent/);
  assert.match(confirmation, /No email is sent when a draft is saved/);
  const details = confirmation.match(/<dl class="success-details">[\s\S]*?<\/dl>/)[0];
  assert.ok(details.includes('a&amp;b@example.invalid'));
  assert.ok(!confirmation.replace(details, '').includes('a&amp;b@example.invalid'));
  assert.equal(app.networkCalls.length, 0);
});

test('saved detail escapes supplied legacy strings and keeps the email in the private success-details region', () => {
  const old = { id: 'AN-DEMO-ESCAPE01', sample: '<b>Synthetic sample</b>', name: '<img src=x>', email: 'name"><img src=x>@example.invalid', company: 'A&B', service: 'purity', quantity: '<svg>', notes: '<script>synthetic</script>' };
  const app = bootApp('/', [old]);
  app.click('portal');
  assert.ok(!app.nodes.get('#dialog-content').innerHTML.includes('<svg>'));
  app.click('request-detail', { id: old.id });
  const html = app.nodes.get('#dialog-content').innerHTML;
  for (const escaped of ['&lt;b&gt;Synthetic sample&lt;/b&gt;', '&lt;img src=x&gt;', 'name&quot;&gt;&lt;img src=x&gt;@example.invalid', 'A&amp;B', '&lt;svg&gt;', '&lt;script&gt;synthetic&lt;/script&gt;']) assert.ok(html.includes(escaped), escaped);
  assert.ok(!/<b>Synthetic|<img src=x>|<script>synthetic/.test(html));
  const details = html.match(/<dl class="success-details">[\s\S]*?<\/dl>/)[0];
  assert.ok(details.includes('name&quot;&gt;&lt;img src=x&gt;@example.invalid'));
  assert.ok(!html.replace(details, '').includes('@example.invalid'));
  assert.match(html, /Draft · Not sent/);
  assert.match(html, /No email is sent/);
  assert.equal(app.networkCalls.length, 0);
});

test('local save keeps the 50-draft cap and reports blocked storage without submission or mail success', () => {
  const saved = Array.from({ length: 50 }, (_, index) => ({ id: `AN-DEMO-LOCAL${index}`, sample: `Synthetic draft ${index}`, email: 'local@example.invalid', service: 'purity', quantity: 1 }));
  const values = { name: 'Synthetic contact', email: 'local@example.invalid', company: '', sample: 'Synthetic newest draft', service: 'purity', quantity: '1', notes: '' };
  const app = bootApp('/', saved);
  app.click('submit');
  app.saveRequest(values);
  assert.equal(app.requests().length, 50);
  assert.match(app.requests()[0].id, /^AN-REQ-/);
  assert.equal(app.requests()[1].id, saved[0].id);
  assert.equal(app.requests().at(-1).id, saved[48].id);
  const blocked = bootApp('/', [saved[0]], { storageBlocked: true });
  blocked.click('submit');
  blocked.saveRequest(values);
  assert.match(blocked.nodes.get('#submission-error').textContent, /could not save/);
  assert.match(blocked.nodes.get('#dialog-content').innerHTML, /id="submission-form"/);
  assert.deepEqual(blocked.requests(), [saved[0]]);
  assert.equal(app.networkCalls.length + blocked.networkCalls.length, 0);
});

test('actual SPA anchors select one view/title/active navigation without replacing the document or duplicating history', () => {
  for (const route of pageData.PAGE_ROUTES) {
    const direct = bootApp(route.path);
    assert.deepEqual(direct.visibleViews(), ['#' + route.view]);
    assert.equal(direct.document.title, route.title);
    assert.equal(direct.navLinks.filter((link) => link.getAttribute('aria-current') === 'page').length, 2);
    const before = direct.entryCount();
    assert.equal(direct.clickLink(route.path).defaultPrevented, true);
    assert.equal(direct.entryCount(), before);
    assert.equal(direct.focused(), '#' + route.heading);
  }
  const app = bootApp('/');
  const document = app.document;
  for (const route of pageData.PAGE_ROUTES.slice(1)) {
    const before = app.entryCount();
    app.clickLink(route.path);
    assert.equal(app.entryCount(), before + 1);
    assert.equal(app.document, document);
    assert.deepEqual(app.visibleViews(), ['#' + route.view]);
  }
  const scrollCount = app.scrolls.length;
  app.travel(-1);
  assert.equal(app.location.pathname, '/verify');
  assert.equal(app.document.title, 'Verify COA · AssayNova');
  app.hashEvent();
  assert.equal(app.scrolls.length, scrollCount, 'Back/Forward and its hash event must not force scroll-to-top');
  app.travel(1);
  assert.deepEqual(app.visibleViews(), ['#contact-view']);
});

test('actual anchor interception preserves modified, nonprimary, external, target, download, unknown and skip-link defaults', () => {
  const app = bootApp('/about');
  for (const [href, options] of [
    ['/contact', { ctrlKey: true }], ['/contact', { metaKey: true }], ['/contact', { shiftKey: true }], ['/contact', { altKey: true }], ['/contact', { button: 1 }],
    ['/contact', { target: '_blank' }], ['/contact', { target: '_self' }], ['/contact', { download: '' }], ['https://example.invalid/about', {}],
    ['/missing', {}], ['/app.js', {}], ['#main', {}], ['/', { dataAction: 'home', ctrlKey: true }]
  ]) {
    assert.equal(app.clickLink(href, options).defaultPrevented, false, href + JSON.stringify(options));
    assert.equal(app.location.pathname, '/about');
    assert.equal(app.entryCount(), 1);
  }
  assert.equal(app.symbolClick().defaultPrevented, false, 'SVG symbol hrefs are not anchors');
  assert.equal(app.clickLink('http://127.0.0.1:4999/contact').defaultPrevented, true);
  assert.equal(app.location.pathname, '/contact');
  const before = app.entryCount();
  app.clickLink('/coa/AN-8P6R-3N5Y', { dataAction: 'report' });
  assert.equal(app.entryCount(), before + 1, 'A report anchor with a legacy data action navigates only once');
  assert.match(app.nodes.get('#coa-view').innerHTML, /src="\/reports\/sample-c\.svg"/);
  assert.deepEqual(app.navLinks.filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.getAttribute('href')), ['/verify', '/verify']);
});

test('legacy hashes, trailing slashes and COA queries canonicalize without losing the previous page', () => {
  for (const [input, output, view] of [
    ['/#testing', '/testing-methods', '#testing-view'], ['/#verify', '/verify', '#verify-view'], ['/about/', '/about', '#about-view'],
    ['/?coa=AN-2026-0043', '/coa/AN-8P6R-3N5Y', '#coa-view'], ['/?coa=unknown', '/verify', '#verify-view']
  ]) {
    const app = bootApp(input);
    assert.equal(app.location.pathname, output);
    assert.equal(app.entryCount(), 1);
    assert.deepEqual(app.visibleViews(), [view]);
    if (input.includes('unknown')) assert.match(app.nodes.get('#verify-error').textContent, /No report matches/);
    assert.deepEqual(bootApp(app.location.pathname).visibleViews(), [view]);
  }
  for (const [hash, path] of [['testing', '/testing-methods'], ['verify', '/verify']]) {
    const app = bootApp('/about');
    app.clickLink('/#' + hash);
    assert.equal(app.location.pathname, path);
    assert.equal(app.entryCount(), 2);
    app.travel(-1);
    assert.equal(app.location.pathname, '/about');
  }
  const process = bootApp('/about');
  process.clickLink('/#process');
  assert.deepEqual(process.visibleViews(), ['#home-view']);
  assert.equal(process.location.hash, '#process');
  assert.equal(process.scrolls.at(-1), 'process');
  process.hash('#testing');
  assert.equal(process.location.pathname, '/testing-methods');
  assert.deepEqual(process.visibleViews(), ['#testing-view']);
});

test('native report fragments preserve skip focus, report DOM and pending manual-copy state across popstate then hashchange', async () => {
  for (const code of ['AN-7K9Q-2M4X', 'AN-8P6R-3N5Y']) {
    const app = bootApp('/coa/' + code, [], { clipboardBlocked: true });
    app.click('copy-link');
    await new Promise((resolve) => setImmediate(resolve)); // Settle the host/VM promise boundary.
    const report = app.nodes.get('#coa-view');
    const writes = report.htmlWrites;
    const fallback = app.nodes.get('#report-copy-fallback');
    const field = app.nodes.get('#report-copy-value');
    const pendingLink = 'http://127.0.0.1:4999/coa/' + code;
    assert.equal(fallback.hidden, false);
    assert.equal(field.value, pendingLink);
    assert.equal(app.clickLink('#main').defaultPrevented, false);
    app.hash('#main', { focusTarget: 'main' });
    app.flushFrames();
    assert.equal(app.location.hash, '#main');
    assert.equal(app.focused(), '#main');
    assert.equal(report.htmlWrites, writes, 'Native fragments must not replace report controls');
    assert.equal(app.nodes.get('#report-copy-fallback'), fallback);
    assert.equal(app.nodes.get('#report-copy-value'), field);
    assert.equal(field.value, pendingLink);
    assert.equal(fallback.hidden, false);
    assert.equal(app.clickLink('/coa/' + code + '#report-title').defaultPrevented, false);
    app.hash('#report-title', { focusTarget: 'report-title' });
    app.flushFrames();
    assert.equal(app.location.hash, '#report-title');
    assert.equal(app.focused(), '#report-title');
    assert.equal(report.htmlWrites, writes);
    app.click('copy-retry');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.copied.at(-1), pendingLink, 'Pending copy-link kind survives fragment history');
    app.click('print');
    assert.equal(app.printed(), 1);
  }
});

test('native legacy fragment event pairs canonicalize once and focus the new visible page heading', () => {
  for (const [hash, path, heading, view] of [
    ['#testing', '/testing-methods', '#testing-page-title', '#testing-view'],
    ['#verify', '/verify', '#verify-page-title', '#verify-view']
  ]) {
    const app = bootApp('/');
    const reportWrites = app.nodes.get('#coa-view').htmlWrites;
    const scrollCount = app.scrolls.length;
    app.hash(hash);
    assert.equal(app.location.pathname, path);
    assert.equal(app.location.hash, '');
    assert.equal(app.focused(), 'body', 'Native fragment steps occur after synchronous app listeners');
    app.flushFrames();
    assert.equal(app.focused(), heading);
    assert.deepEqual(app.visibleViews(), [view]);
    assert.equal(app.nodes.get('#coa-view').htmlWrites, reportWrites + 1, 'The event pair renders only once');
    assert.equal(app.scrolls.length, scrollCount, 'Native history rendering must not force scroll-to-top');
    assert.equal(app.entryCount(), 2);
    app.travel(-1);
    app.flushFrames();
    assert.equal(app.location.pathname, '/');
    assert.equal(app.focused(), '#hero-title');
  }
});

test('deferred native-history focus is cancelled by a later skip fragment or request dialog', () => {
  const skip = bootApp('/');
  skip.hash('#testing');
  skip.hash('#main', { focusTarget: 'main' });
  skip.flushFrames();
  assert.equal(skip.focused(), '#main', 'A pending page heading must not steal native skip-link focus');
  const dialog = bootApp('/');
  dialog.hash('#verify');
  dialog.click('submit');
  dialog.flushFrames();
  assert.equal(dialog.focused(), '#dialog-title');
  assert.equal(dialog.nodes.get('#app-dialog').open, true);
});

test('page navigation closes stale dialogs, mobile request/drafts return to menu and routes remain underneath dialogs', () => {
  for (const route of pageData.PAGE_ROUTES) {
    const app = bootApp(route.path);
    const event = app.click('submit');
    assert.equal(app.location.pathname, route.path);
    assert.equal(app.nodes.get('#app-dialog').open, true);
    app.click('close');
    assert.equal(app.document.activeElement, event.target, 'Desktop close restores the exact trigger');
    app.openMenu();
    app.click('portal', {}, { mobile: true });
    assert.equal(app.nodes.get('#mobile-nav').hidden, true);
    app.click('close');
    assert.equal(app.focused(), '.menu-toggle');
    app.click('submit');
    app.clickLink('/contact');
    assert.equal(app.nodes.get('#app-dialog').open, false);
    assert.deepEqual(app.visibleViews(), ['#contact-view']);
    assert.equal(app.focused(), '#contact-title');
    app.openMenu();
    app.clickLink('/', { mobile: true });
    assert.equal(app.nodes.get('#mobile-nav').hidden, true);
    assert.equal(app.nodes.get('.menu-toggle').getAttribute('aria-expanded'), 'false');
    app.openMenu(); app.desktopResize();
    assert.equal(app.nodes.get('#mobile-nav').hidden, true);
    assert.equal(app.networkCalls.length, 0);
  }
  const verify = bootApp('/verify');
  verify.nodes.get('#demo-lookup').events.get('click')();
  assert.equal(verify.location.pathname, '/coa/AN-7K9Q-2M4X');
  assert.match(verify.nodes.get('#coa-view').innerHTML, /src="\/reports\/sample-a\.svg"/);
  assert.match(verify.nodes.get('#coa-view').innerHTML, /href="\/reports\/sample-a\.pdf" download/);
  assert.ok(!/99\.32%|AN-2026-0042/.test(verify.nodes.get('#coa-view').innerHTML));
});

async function availablePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  assert.notEqual(port, 4317);
  return port;
}

async function withCOAServer(mode, callback) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'assaynova-coa-test-'));
  let child;
  let exited;
  let output = '';
  try {
    for (const entry of ['server.mjs', 'dev-client.js', 'dev', 'dist', 'package.json']) await cp(path.join(project, entry), path.join(fixture, entry), { recursive: true });
    const port = await availablePort();
    child = spawn(process.execPath, ['server.mjs', `--port=${port}`, ...(mode === 'default' ? [] : ['--watch'])], {
      cwd: fixture, env: { ...process.env, NODE_ENV: mode === 'production' ? 'production' : 'test' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    exited = new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('COA test server startup timed out: ' + output)), 7000);
      const receive = (chunk) => {
        output += chunk;
        if (output.includes('Press Ctrl+C to stop.')) { clearTimeout(timer); resolve(); }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('COA server exited during startup: ' + output)); });
    });
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (exited) await exited;
    const resolvedFixture = path.resolve(fixture);
    const resolvedTemp = path.resolve(tmpdir());
    assert.equal(path.dirname(resolvedFixture).toLowerCase(), resolvedTemp.toLowerCase());
    assert.ok(path.basename(resolvedFixture).startsWith('assaynova-coa-test-'));
    assert.notEqual(resolvedFixture.toLowerCase(), resolvedTemp.toLowerCase());
    await rm(resolvedFixture, { recursive: true, force: true });
  }
}

for (const mode of ['default', 'production', 'watch']) {
  test(`HTTP ${mode}: exact deep links and HEAD, recoverable unknown 404, unrelated 404 and dev isolation`, async () => {
    await withCOAServer(mode, async (base) => {
      for (const page of pageData.PAGE_ROUTES) {
        for (const route of [page.path, ...(page.path === '/' ? [] : [page.path + '/'])]) {
          const response = await fetch(base + route);
          assert.equal(response.status, 200, route);
          const html = await response.text();
          assert.ok(html.includes('id="' + page.view + '"'));
          assert.ok(html.includes('/privacy/consent.js'));
          assert.equal(html.includes('/__dev/client.js'), mode === 'watch');
          const head = await fetch(base + route, { method: 'HEAD' });
          assert.equal(head.status, 200); assert.equal(await head.text(), '');
          assert.equal((await fetch(base + route, { method: 'POST' })).status, 405);
        }
      }
      for (const report of DEMO_REPORTS) {
        const route = reportPath(report.lookupCode);
        const response = await fetch(base + route);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
        const html = await response.text();
        assert.ok(html.includes('id="coa-view"'));
        assert.ok(html.includes('src="/app.js"'));
        assert.ok(html.includes('href="/styles.css"'));
        assert.equal(html.includes('/__dev/client.js'), mode === 'watch');
        assert.equal(html.includes('data-an-dev-file'), mode === 'watch');
        const head = await fetch(base + route, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), '');
        assert.equal((await fetch(base + route.toLowerCase())).status, 200);
        assert.equal((await fetch(base + route + '/')).status, 200);
      }
      const reportDownloads = [];
      for (const [stem, code, otherCode] of [['sample-a', 'AN-7K9Q-2M4X', 'AN-8P6R-3N5Y'], ['sample-c', 'AN-8P6R-3N5Y', 'AN-7K9Q-2M4X']]) {
        for (const extension of ['svg', 'pdf']) {
          const url = `/reports/${stem}.${extension}`;
          const response = await fetch(base + url);
          assert.equal(response.status, 200, url);
          const bytes = Buffer.from(await response.arrayBuffer());
          assert.deepEqual(bytes, await readFile(path.join(project, 'dist', url)));
          const head = await fetch(base + url, { method: 'HEAD' });
          assert.equal(head.status, 200, url);
          assert.equal((await head.arrayBuffer()).byteLength, 0);
          assert.equal(head.headers.get('content-type'), response.headers.get('content-type'));
          if (extension === 'svg') {
            const svg = bytes.toString('utf8');
            assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
            assert.ok(svg.includes(code) && !svg.includes(otherCode));
            assert.ok(svg.includes('width="210mm"') && svg.includes('height="297mm"'));
            assert.ok(!/<(?:script|text)\b|onload=|href="https?:/i.test(svg));
          } else {
            assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
            reportDownloads.push(url);
          }
        }
      }
      assert.equal(new Set(reportDownloads).size, 2);
      for (const route of ['/coa/AN-0000-0000', '/coa/AN-2026-0042', '/coa/unknown', '/coa/not-found']) {
        const response = await fetch(base + route);
        assert.equal(response.status, 404);
        assert.ok((await response.text()).includes('id="coa-view"'), 'Unknown code keeps a recoverable app shell');
        const head = await fetch(base + route, { method: 'HEAD' });
        assert.equal(head.status, 404);
        assert.equal(await head.text(), '');
      }
      for (const route of ['/missing', '/assets/missing.png', '/about.css', '/%61bout', '/%2fabout', '/about%2f', '/contact/extra', '/testing-methods/missing', '/coa/AN-7K9Q-2M4X/missing.css', '/coa/missing.css', '/__dev/not-allowed', '/server.mjs']) {
        const response = await fetch(base + route);
        assert.equal(response.status, 404);
        assert.equal(await response.text(), 'Not found');
      }
      assert.equal((await fetch(base + '/coa/%ZZ')).status, 400);
      assert.equal((await fetch(base + reportPath(DEMO_REPORT.lookupCode), { method: 'POST' })).status, 405);
      assert.equal((await fetch(base + '/?coa=AN-2026-0042')).status, 200);
      assert.equal((await fetch(base + '/__dev/context')).status, mode === 'watch' ? 200 : 404);
      const heroPath = '/assets/assaynova-lab-hero.jpg';
      const hero = await fetch(base + heroPath);
      assert.equal(hero.status, 200);
      assert.equal(hero.headers.get('content-type'), 'image/jpeg');
      const heroBytes = Buffer.from(await hero.arrayBuffer());
      assert.deepEqual([...heroBytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
      assert.deepEqual(heroBytes, await readFile(path.join(project, 'dist', heroPath)));
      const heroHead = await fetch(base + heroPath, { method: 'HEAD' });
      assert.equal(heroHead.status, 200);
      assert.equal(heroHead.headers.get('content-type'), 'image/jpeg');
      assert.equal(heroHead.headers.get('cache-control'), hero.headers.get('cache-control'));
      assert.equal((await heroHead.arrayBuffer()).byteLength, 0);
      for (const asset of ['/app.js', '/data.js', '/routes.js', '/styles.css', '/assets/assaynova-logo.png']) assert.equal((await fetch(base + asset)).status, 200, asset);
    });
  });
}
