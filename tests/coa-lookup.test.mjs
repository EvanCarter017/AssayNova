import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as reportData from '../dist/data.js';
import { SAMPLE_REPORT_DATA } from '../dist/reports/sample-data.js';
import * as pageData from '../dist/routes.js';
import * as supportData from '../dist/support.js';
import * as submissionData from '../dist/submission.js';
import { createContactForm } from '../dist/contact-form.js';
import { createCustomerAccountClient } from '../dist/customer-account.js';
import { requestKind } from '../dist/account-requests.js';
import { createRequestPage } from '../dist/request-page.js';
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
function bootApp(initialPath = '/', savedRequests = [], { storageBlocked = false, clipboardBlocked = false, storageReadBlocked = false, storageSilent = false, savedSupport, clipboardWrite, cryptoSource, publishedReader = false, remoteFetch, lookupTimeouts, accountTransport } = {}) {
  const documentEvents = new Map();
  const windowEvents = new Map();
  const nodes = new Map();
  const copied = [];
  const networkCalls = [];
  const storage = new Map([['assaynova.prototype.requests.v1', JSON.stringify(savedRequests)]]);
  if (savedSupport !== undefined) storage.set(supportData.SUPPORT_DRAFT_KEY, savedSupport);
  const storageCalls = [];
  let printed = 0;
  let focused = null;
  const scrolls = [];
  const frames = [];
  let nextTarget = 0;
  let requestNodeSerial = 0;
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
      get innerHTML() { return html; }, set innerHTML(value) {
        html = value; this.htmlWrites++;
        if (name === '#request-flow') {
          for (const [key, child] of [...nodes]) if (child.parent === this) { child.isConnected = false; nodes.delete(key); }
          const decode = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_match, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]);
          for (const match of value.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
            const attrs = [...match[2].matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)].map(([, key, value]) => [key, decode(value || '')]);
            const id = attrs.find(([key]) => key === 'id')?.[1];
            const child = node(id ? '#' + id : 'request-node-' + requestNodeSerial++);
            child.parent = this; child.tagName = match[1].toUpperCase(); child.isConnected = true;
            child.attributes.clear(); child.dataset = {};
            for (const [key, value] of attrs) { child.setAttribute(key, value); if (key.startsWith('data-')) child.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; }
            child.disabled = child.hasAttribute('disabled'); child.name = child.getAttribute('name') || '';
            child.textContent = decode(value.slice(match.index + match[0].length).split('<')[0]);
          }
        }
        if (name === '#dialog-content') {
          const heldRecovery = nodes.get('#recovery-container')?.isConnected === false;
          if (!heldRecovery) for (const [key, child] of [...nodes]) if (key === '#recovery-form' || key.startsWith('#support-')) { child.isConnected = false; nodes.delete(key); }
          if (value.includes('id="recovery-form"')) {
            node('#recovery-form');
            const decode = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_match, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]);
            for (const key of ['email', 'reference', 'notes']) {
              const field = node('#support-' + key); field.name = key;
              const content = key === 'notes' ? value.match(/<textarea[^>]*id="support-notes"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] : value.match(new RegExp('<input[^>]*id="support-' + key + '"[^>]*value="([^\"]*)"'))?.[1];
              field.value = decode(content || '');
            }
            node('#support-copy-fallback').hidden = true;
          }
        }
      },
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, callback) { events.set(type, callback); }, removeEventListener(type) { events.delete(type); },
      get firstElementChild() { return this.heldChild || (name === '#dialog-content' && html.includes('nova-support-dialog') ? node('#recovery-container') : null); },
      appendChild(child) { this.heldChild = child; child.parent = this; child.isConnected = true; return child; },
      setAttribute(key, value) { attributes.set(key, String(value)); }, getAttribute(key) { return attributes.get(key) ?? null; }, hasAttribute(key) { return attributes.has(key); }, removeAttribute(key) { attributes.delete(key); },
      focus() { focused = name; document.activeElement = this; }, select() {}, remove() { this.isConnected = false; }, scrollIntoView() { scrolls.push(this.id); },
      matches(selector) { return selector.split(',').some((item) => {
        if (item === 'a[href]') return this.tagName === 'A' && attributes.has('href');
        if (item === '[data-action]') return !!this.dataset.action;
        if (item === '[data-recovery-action]') return !!this.dataset.recoveryAction;
        if (item === '[hidden]') return this.hidden;
        if (item.startsWith('#')) return this.id === item.slice(1);
        if (item.startsWith('.')) return (attributes.get('class') || '').split(/\s+/).includes(item.slice(1));
        const parts = [...item.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
        return parts.length > 0 && parts.every(([, key, value]) => value === undefined ? attributes.has(key) : attributes.get(key) === value);
      }); },
      closest(selector) { for (let current = this; current; current = current.parent) if (current.matches(selector)) return current; return null; },
      close() { this.open = false; events.get('close')?.(); }, showModal() { this.open = true; },
      elements: { namedItem(key) { return node((name === '#recovery-form' ? '#support-' : '#request-') + key); } },
      requestSubmit() { for (const callback of documentEvents.get('submit') || []) callback({ target: this, preventDefault() {} }); },
      querySelector(selector) { if (this.id === 'request-flow') return [...nodes.values()].find(item => item.parent === this && item.isConnected && item.matches(selector)) || null; return selector === '[aria-invalid=true]' ? [...nodes.values()].find((item) => item.attributes.get('aria-invalid') === 'true') : selector === 'input[name="lookupCode"]' ? node(this.id === 'verify-form' ? '#report-id' : '#coa-lookup-code') : node(selector); },
      querySelectorAll(selector) { if (this.id === 'request-flow') return [...nodes.values()].filter(item => item.parent === this && item.isConnected && item.matches(selector)); return [...nodes.values()].filter((item) => selector === '[aria-invalid]' ? item.attributes.has('aria-invalid') : selector === '.field-error' && item.id.startsWith('error-')); }
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
      if (route.path === '/submit-sample') continue;
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
  if (publishedReader) node('meta[name="assaynova-report-reader"]').setAttribute('content','enabled');
  const internals = {};
  if (accountTransport) node('meta[name="assaynova-accounts"]').setAttribute('content','enabled');
  runInNewContext(runnable + '\nObject.assign(testInternals, { accountClient, getRecovery: () => recoveryForm, getReturn: () => recoveryReturn, navigateToURL });', {
    ...reportData, ...pageData, ...supportData, ...submissionData, SAMPLE_REPORT_DATA, createRequestPage, createContactForm, requestKind, createCustomerAccountClient: () => createCustomerAccountClient({ fetcher: accountTransport }), createAccountPage: () => ({ leave() {}, activate() {} }), testInternals: internals, document, window, location, history, URL,
    navigator: { clipboard: { writeText(value) { copied.push(value); if (clipboardWrite) return clipboardWrite(value); return clipboardBlocked ? Promise.reject(new Error('Synthetic clipboard restriction')) : Promise.resolve(); } }, sendBeacon: unexpectedNetwork },
    fetch: remoteFetch ?? unexpectedNetwork, AbortController, XMLHttpRequest: class { constructor() { unexpectedNetwork('XMLHttpRequest'); } },
    localStorage: {
      getItem: (key) => { storageCalls.push(['get', key]); if (storageReadBlocked) throw new Error('Synthetic read restriction'); return storage.get(key) ?? null; },
      setItem: (key, value) => { storageCalls.push(['set', key]); if (storageBlocked) throw new Error('Synthetic storage restriction'); if (!storageSilent) storage.set(key, value); },
      removeItem: (key) => { storageCalls.push(['remove', key]); if (storageBlocked) throw new Error('Synthetic storage restriction'); if (!storageSilent) storage.delete(key); }
    },
    crypto: cryptoSource ?? { randomUUID: () => '12345678-0000-0000-0000-000000000000' },
    FormData: class { constructor(form) { this.form = form; } entries() { return Object.entries(this.form.values); } },
    requestAnimationFrame: (callback) => frames.push(callback), setTimeout: (callback,ms) => { if (ms===10000) lookupTimeouts?.push(callback); return 0; }, clearTimeout() {}
  });
  function setRequestField(key, value) {
    const flow = node('#request-flow'); const field = flow.querySelector(`[data-rq-field="${key}"]`);
    assert.ok(field, 'Expected request field ' + key); field.value = String(value);
    flow.events.get('input')({ type: 'input', target: field });
  }
  function submitRequestStep() { const flow = node('#request-flow'); flow.events.get('submit')({ target: { id: 'request-step-form' }, preventDefault() {} }); }
  function enterRequestContact(values) {
    const flow = node('#request-flow');
    const back = flow.querySelector('[data-rq-step="1"]'); assert.ok(back);
    flow.events.get('click')({ target: back });
    const first = flow.querySelectorAll('[data-rq-field]').find(field => field.dataset.rqField.endsWith(':name'));
    const id = first.dataset.rqField.split(':')[1];
    for (const [key, value] of Object.entries({ name: values.sample || 'Synthetic sample', service: values.service || 'purity', quantity: values.quantity || '1' })) setRequestField(`sample:${id}:${key}`, value);
    submitRequestStep(); return !!flow.querySelector('[data-rq-field="email"]');
  }
  function dispatch(target, options = {}) {
    document.activeElement = target;
    const event = { target, button: 0, defaultPrevented: false, ...options, preventDefault() { this.defaultPrevented = true; } };
    if (target.closest('#request-flow')) node('#request-flow').events.get('click')?.(event);
    if (target.closest('#mobile-nav')) node('#mobile-nav').events.get('click')?.(event);
    for (const callback of documentEvents.get('click') || []) callback(event);
    return event;
  }
  return {
    nodes, copied, location, networkCalls, document, internals, navLinks, scrolls, storageCalls, storageSnapshot: () => new Map(storage), printed: () => printed, focused: () => focused, entryCount: () => entries.length,
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
    fillRecovery(values) { for (const [key, value] of Object.entries(values)) node('#support-' + key).value = value; },
    recoveryInput(key, value) { const field = node('#support-' + key); field.value = value; node('#recovery-form').events.get('input')({ target: field }); },
    saveRecovery() { node('#recovery-form').events.get('submit')({ preventDefault() {} }); },
    recoveryAction(action) { const target = node('recovery-action-' + nextTarget++); target.dataset.recoveryAction = action; return node('#recovery-form').events.get('click')({ target }); },
    enterRequestContact(values = {}) { return enterRequestContact(values); },
    saveRequest(values) {
      if (!enterRequestContact(values)) return;
      for (const key of ['name', 'email', 'notes']) setRequestField(key, values[key] ?? '');
      submitRequestStep();
      const flow = node('#request-flow');
      if (flow.querySelector('[data-rq-step="3"]')?.getAttribute('aria-current') === 'step') submitRequestStep();
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
    const record = SAMPLE_REPORT_DATA[code];
    const otherRecord = SAMPLE_REPORT_DATA[code === 'AN-7K9Q-2M4X' ? 'AN-8P6R-3N5Y' : 'AN-7K9Q-2M4X'];
    for (const value of [record.product, record.client, record.reportId, record.received, record.reported, record.identity, ...record.purity.map(value => value + '%')]) assert.ok(html.includes(value), value);
    for (const value of [otherRecord.client, otherRecord.reportId, otherRecord.purity[2] + '%', otherRecord.identity]) assert.ok(!html.includes(value), value);
    assert.ok(!/\[(?:Product name|Client name|YYYY-MM-DD|Analyte|Result|Spectrum|Title)|--\.--|identity-matched|identity-neutral|Chromatogram schematic/.test(html));
    assert.ok(html.includes('Report fields') && html.includes('Dylan Greene') && html.includes('Chief Chemist'));
    assert.ok(html.includes('Fictional data for illustration. Not a valid certificate of analysis.'));
    assert.ok(html.includes('Lookup Code') && !html.includes('COA Lookup Code'));
    assert.ok(html.includes('HPLC-UV chromatogram') && html.includes(record.retentionTime + ' min'));
    for (const analyte of ['GHK-Cu', 'KPV', 'BPC-157', 'Thymosin Beta-4']) assert.ok(html.includes(analyte));
    assert.ok(!/Aster-[1-4]|Cedar-[1-4]/.test(html));
    assert.ok(html.includes('GHK (apo ligand)') && html.includes('[M+2H]2+'));
    for (const row of record.composition) assert.ok(html.includes(row.analyte) && html.includes(row.summary));
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

test('public lookup has no sample shortcuts while sample reports and drafts preserve their disclosures and references', async () => {
  const homeHTML = await readFile(path.join(project, 'dist/index.html'), 'utf8');
  const text = (html) => html.replace(/<[^>]*>/g, ' ');
  assert.ok(!homeHTML.includes('class="preview-bar"'));
  assert.ok(!/\b(?:demo|concept|prototype|preview)\b/i.test(text(homeHTML)));
  assert.equal((homeHTML.match(/href="\/account" data-account-entry hidden/g) || []).length, 3);
  assert.match(homeHTML, /data-action="portal">My requests/);
  assert.ok(!/Client portal|CLIENT WORKSPACE|No account (?:is )?needed/.test(homeHTML));
  const publicReports = homeHTML.match(/<section id="home-reports"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(homeHTML, /home-report-samples|Sample reports|data-action="report"|methods-report-link|AN-7K9Q-2M4X|AN-8P6R-3N5Y/);
  assert.match(publicReports, /id="home-reports-title">Your code\.<br>The published report\./);
  assert.match(publicReports, /href="\/verify">Find a COA/);
  assert.match(homeHTML, /id="report-id"[^>]*placeholder="e\.g\. AN-XXXX-XXXX"/);
  const sample = bootApp('/coa/AN-7K9Q-2M4X');
  assert.match(sample.nodes.get('#coa-view').innerHTML, /id="coa-lookup-code"[^>]*placeholder="e\.g\. AN-XXXX-XXXX"/);
  assert.match(text(sample.nodes.get('#coa-view').innerHTML), /Sample report/);
  assert.match(text(sample.nodes.get('#coa-view').innerHTML), /Not a valid certificate of analysis/);
  const app = bootApp('/submit-sample');
  assert.match(app.nodes.get('#request-flow').innerHTML, /Submissions are unavailable/);
  assert.deepEqual(app.storageCalls, []);

});

test('actual SPA anchors select one view/title/active navigation without replacing the document or duplicating history', () => {
  for (const route of pageData.PAGE_ROUTES) {
    const direct = bootApp(route.path);
    assert.deepEqual(direct.visibleViews(), ['#' + route.view]);
    assert.equal(direct.document.title, route.title);
    assert.equal(direct.navLinks.filter((link) => link.getAttribute('aria-current') === 'page').length, route.path === '/submit-sample' ? 0 : 2);
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
  assert.equal(app.location.pathname, pageData.PAGE_ROUTES.at(-2).path);
  assert.equal(app.document.title, pageData.PAGE_ROUTES.at(-2).title);
  app.hashEvent();
  assert.equal(app.scrolls.length, scrollCount, 'Back/Forward and its hash event must not force scroll-to-top');
  app.travel(1);
  assert.deepEqual(app.visibleViews(), ['#' + pageData.PAGE_ROUTES.at(-1).view]);
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

test('deferred native-history focus is cancelled by a later skip fragment or request page', () => {
  const skip = bootApp('/');
  skip.hash('#testing');
  skip.hash('#main', { focusTarget: 'main' });
  skip.flushFrames();
  assert.equal(skip.focused(), '#main', 'A pending page heading must not steal native skip-link focus');
  const dialog = bootApp('/');
  dialog.hash('#verify');
  dialog.click('submit');
  dialog.flushFrames();
  assert.equal(dialog.focused(), '#request-page-title');
  assert.equal(dialog.nodes.get('#app-dialog').open, false);
});

test('request navigation uses its own page while saved-draft dialogs and mobile menu retain focus behavior', () => {
  for (const route of pageData.PAGE_ROUTES) {
    const app = bootApp(route.path);
    const event = app.click('submit');
    assert.equal(app.location.pathname, '/submit-sample');
    assert.equal(app.nodes.get('#app-dialog').open, false);
    assert.equal(app.focused(), '#request-page-title');
    if (route.path !== '/submit-sample') { app.travel(-1); app.flushFrames(); assert.equal(app.focused(), '#' + route.heading); }
    app.openMenu();
    app.click('portal', {}, { mobile: true });
    assert.equal(app.nodes.get('#mobile-nav').hidden, true);
    assert.equal(app.location.pathname, '/account');
    assert.equal(app.focused(), '#account-title');
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
  verify.submitLookup('  an-7k9q-2m4x  ', false);
  assert.equal(verify.location.pathname, '/coa/AN-7K9Q-2M4X');
  assert.match(verify.nodes.get('#coa-view').innerHTML, /src="\/reports\/sample-a\.svg"/);
  assert.match(verify.nodes.get('#coa-view').innerHTML, /href="\/reports\/sample-a\.pdf" download/);
  assert.match(verify.nodes.get('#coa-view').innerHTML, /99\.32%/);
  assert.ok(verify.nodes.get('#coa-view').innerHTML.includes(SAMPLE_REPORT_DATA['AN-7K9Q-2M4X'].product));
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
    for (const entry of ['server.mjs', 'report-pdf.mjs', 'dev-client.js', 'dev', 'dist', 'package.json']) await cp(path.join(project, entry), path.join(fixture, entry), { recursive: true });
    const port = await availablePort();
    child = spawn(process.execPath, ['server.mjs', '--no-accounts', `--port=${port}`, ...(mode === 'default' ? [] : ['--watch'])], {
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
        assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
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
            assert.equal((svg.match(/<image\b/g) || []).length, 3, 'Logo, product image and original signature are embedded');
            assert.equal((svg.match(/href="data:image\/png;base64,/g) || []).length, 3);
            assert.ok(svg.includes('fixed fictional sample data') && !svg.includes('placeholder'));
          } else {
            assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
            reportDownloads.push(url);
          }
        }
      }
      assert.equal(new Set(reportDownloads).size, 2);
      const moduleResponse = await fetch(base + '/reports/sample-data.js');
      assert.equal(moduleResponse.status, 200);
      assert.equal(await moduleResponse.text(), await readFile(path.join(project, 'dist/reports/sample-data.js'), 'utf8'));
      assert.equal((await fetch(base + '/reports/sample-data.js', { method: 'HEAD' })).status, 200);
      assert.match(await (await fetch(base + '/app.js')).text(), /import \{ SAMPLE_REPORT_DATA \} from '\.\/reports\/sample-data\.js'/);
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

test('public report module matches its authoritative fictional catalog and published summaries', async () => {
  const catalog = JSON.parse(await readFile(new URL('../templates/coa/sample_reports.json', import.meta.url), 'utf8'));
  assert.deepEqual(SAMPLE_REPORT_DATA, catalog);
  assert.deepEqual(Object.keys(catalog).sort(), DEMO_REPORTS.map(report => report.lookupCode).sort());
  for (const report of DEMO_REPORTS) {
    const record = catalog[report.lookupCode];
    assert.equal(record.reportId, report.id);
    assert.equal(record.purity[2] + '%', report.purity);
    assert.equal(record.identity, report.identity);
    assert.equal(record.retentionTime + ' min', report.retentionTime);
    assert.equal(record.received, report.received);
    assert.equal(record.reported, report.issued);
    assert.equal(record.composition.length, 4);
    assert.equal(record.spectra.length, 4);
    assert.equal(record.screenings[0].result, record.identity);
    for (const row of record.composition) assert.equal(((Number(row.sample1) + Number(row.sample2)) / 2).toFixed(2), row.summary);
    assert.equal(Math.max(...record.chromatogram.map(peak => peak.response)), record.chromatogram.find(peak => peak.time === Number(record.retentionTime)).response);
  }
});

test('sample ion envelopes use primary neutral masses, charge spacing and purity-compatible fitted areas', async () => {
  const refs = JSON.parse(await readFile(new URL('../templates/coa/analytical-references.json', import.meta.url), 'utf8'));
  const photos = JSON.parse(await readFile(new URL('../templates/coa/assets/sample-vials-sources.json', import.meta.url), 'utf8'));
  assert.equal(photos.sourceType, 'user-supplied edited image');
  assert.equal(photos.editing.mode, 'Built-in imagegen edit');
  assert.equal(photos.files.length, 1);
  const active = photos.files[0];
  assert.equal(active.file, 'sample-vial-product.png');
  const bytes = await readFile(new URL('../templates/coa/assets/' + active.file, import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  assert.equal(createHash('sha256').update(bytes).digest('hex').toUpperCase(), active.assetSha256);
  const brandOnly = await readFile(new URL('../templates/coa/assets/vial-unbranded.png', import.meta.url));
  assert.equal(createHash('sha256').update(brandOnly).digest('hex').toUpperCase(), photos.editing.brandOnly.sha256);
  assert.equal(photos.editing.reportVariant.sha256, active.assetSha256);
  assert.deepEqual(active.crop, [0, 0, ...active.size]);
  assert.equal(photos.archivedSources.creator, 'Thirdman');
  for (const photo of photos.archivedSources.files) {
    const original = await readFile(new URL('../templates/coa/assets/' + photo.file, import.meta.url));
    assert.equal(createHash('sha256').update(original).digest('hex').toUpperCase(), photo.originalSha256);
  }
  for (const [code, record] of Object.entries(SAMPLE_REPORT_DATA)) {
    assert.deepEqual(record.composition.map(row => row.analyte), refs.analytes.map(row => row.tableName));
    assert.ok(Math.abs(record.chromatogram.filter(peak => peak.kind === 'target').reduce((sum,peak) => sum + peak.area, 0) - Number(record.purity[2])) < 1e-5);
    for (const [index, spectrum] of record.spectra.entries()) {
      assert.equal(spectrum.neutralMass, refs.analytes[index].neutralMonoisotopicMass);
      for (const ion of spectrum.ions) {
        const envelope = refs.isotopeEnvelopes[String(spectrum.cid)];
        for (const [n, isotope] of ion.isotopes.entries()) assert.ok(Math.abs(isotope.response - ion.intensity * envelope[n] / 100) < .00051);
        if (spectrum.cid === 9941957) assert.equal(Math.max(...ion.isotopes.map(peak => peak.response)), ion.isotopes[0].response);
        if (spectrum.cid === 16132341) assert.equal(Math.max(...ion.isotopes.map(peak => peak.response)), ion.isotopes[2].response);
        const expected = (spectrum.neutralMass / ion.charge + refs.protonMassU) * (1 + ion.ppm / 1e6);
        assert.ok(Math.abs(ion.mz - expected) < 1e-6);
        for (const [n, isotope] of ion.isotopes.entries()) assert.ok(Math.abs(isotope.mz - ion.mz - n * refs.carbon13SpacingU / ion.charge) < 1e-6);
      }
    }
    assert.equal(record.spectra[3].status, code === 'AN-8P6R-3N5Y' ? 'Low signal' : 'Observed');
  }
});

function generatedFixture(code='AN-ABCD-1234') {
  return {report:{...DEMO_REPORT,lookupCode:code,sample:'HCG 5000IU',disclaimer:undefined},record:{...SAMPLE_REPORT_DATA[DEMO_REPORT.lookupCode],product:'HCG 5000IU',contentUnit:'IU'},label:'HCG 5000IU',assets:{svg:'/__reports/'+code+'/report.svg',pdf:'/__reports/'+code+'/report.pdf'}};
}
const flushLookup = async () => { for(let index=0;index<6;index++) await Promise.resolve(); };
test('opt-in lookup works without reload, preserves generated title/units/actions, refresh and back/forward',async()=>{
  const calls=[],bundle=generatedFixture();
  const remoteFetch=async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>bundle};};
  const app=bootApp('/verify',[],{publishedReader:true,remoteFetch});assert.equal(calls.length,0);
  app.submitLookup(' an-abcd-1234 ',false);await flushLookup();assert.equal(app.location.pathname,'/coa/AN-ABCD-1234');assert.match(app.document.title,/COA report/);assert.doesNotMatch(app.document.title,/Sample/);
  const html=app.nodes.get('#coa-view').innerHTML;assert.match(html,/HCG 5000IU/);assert.match(html,/Measured content · IU\/vial/);assert.match(html,/__reports\/AN-ABCD-1234\/report.pdf/);assert.doesNotMatch(html,/Sample report|Fictional data|Not a valid certificate|Illustrative certificate/);
  app.click('copy-code');await flushLookup();assert.equal(app.copied.at(-1),'AN-ABCD-1234');app.click('copy-link');await flushLookup();assert.equal(app.copied.at(-1),'http://127.0.0.1:4999/coa/AN-ABCD-1234');
  app.clickLink('/about');app.travel(-1);await flushLookup();assert.match(app.nodes.get('#coa-view').innerHTML,/HCG 5000IU/);app.travel(1);assert.equal(app.location.pathname,'/about');
  const refreshed=bootApp('/coa/an-abcd-1234',[],{publishedReader:true,remoteFetch});await flushLookup();assert.equal(refreshed.location.pathname,'/coa/AN-ABCD-1234');assert.match(refreshed.nodes.get('#coa-view').innerHTML,/HCG 5000IU/);
  app.click('report',{lookupCode:DEMO_REPORT.lookupCode});assert.match(app.nodes.get('#coa-view').innerHTML,/Sample report/);
});
test('actual static screening transcripts clarify only the PCR and fentanyl rows without changing records', () => {
  const before = JSON.stringify(SAMPLE_REPORT_DATA);
  for (const code of Object.keys(SAMPLE_REPORT_DATA)) {
    const app = bootApp('/coa/' + code);
    const html = app.nodes.get('#coa-view').innerHTML;
    const screening = html.match(/<h2>Screening outcomes<\/h2><dl[^>]*>([\s\S]*?)<\/dl>/)[1];
    assert.ok(screening.includes('<dt>Microbial Screening (PCR)</dt><dd>No microbial DNA detected</dd>'));
    assert.ok(screening.includes('<dt>Fentanyl Screening</dt><dd>Not detected</dd>'));
    assert.doesNotMatch(screening, /Microbial analysis \(PCR\)|Target microbial DNA not detected\.|Target signal not detected in the screen\.| · <\/dd>/);
    for (const row of SAMPLE_REPORT_DATA[code].screenings.slice(0, 3)) {
      assert.ok(screening.includes(`<dt>${row.test}</dt><dd>${row.result} · ${row.details}</dd>`));
    }
  }
  assert.equal(JSON.stringify(SAMPLE_REPORT_DATA), before);
});

test('actual generated screening transcripts preserve unassessed, positive, conflicting and escaped unknown states', async () => {
  const pcr = 'Microbial Screening (PCR)', fentanyl = 'Fentanyl Screening';
  const cases = [
    { rows: [{ test: 'Microbial analysis (PCR)', result: 'Not detected', details: 'Target microbial DNA not detected.' }, { test: 'Fentanyl', result: 'Not detected', details: 'Target signal not detected in the screen.' }], expected: [[pcr, 'No microbial DNA detected', ''], [fentanyl, 'Not detected', '']] },
    { rows: [{ test: pcr, result: 'No microbial DNA detected', details: '' }, { test: fentanyl, result: 'Not detected', details: '' }], expected: [[pcr, 'No microbial DNA detected', ''], [fentanyl, 'Not detected', '']] },
    { rows: [{ test: 'Microbial analysis (PCR)', result: 'Not assessed', details: 'No result supplied' }, { test: 'Fentanyl', result: 'Not assessed', details: 'No result supplied' }], expected: [[pcr, 'Not assessed', ''], [fentanyl, 'Not assessed', '']] },
    { rows: [{ test: 'Microbial analysis (PCR)', result: 'Detected', details: 'Target microbial DNA not detected.' }, { test: 'Fentanyl', result: 'Detected', details: 'Confirmatory analysis required' }], expected: [[pcr, 'Detected', 'Target microbial DNA not detected.'], [fentanyl, 'Detected', 'Confirmatory analysis required']] },
    { rows: [{ test: 'Microbial analysis (PCR)', result: 'Pass', details: 'No result supplied' }, { test: fentanyl, result: 'Pending', details: 'Review in progress' }], expected: [[pcr, 'Pass', 'No result supplied'], [fentanyl, 'Pending', 'Review in progress']] },
    { rows: [{ test: 'Microbial analysis (PCR)', result: 'Not detected', details: 'Positive signal requires review' }, { test: 'Fentanyl', result: 'Not detected', details: 'LOD 0.5 ng/mL; method LC-MS' }], expected: [[pcr, 'No microbial DNA detected', 'Positive signal requires review'], [fentanyl, 'Not detected', 'LOD 0.5 ng/mL; method LC-MS']] },
    { rows: [{ test: pcr, result: 'No microbial DNA detected', details: 'Target microbial DNA not detected.' }, { test: 'Fentanyl', result: 'not detected', details: 'Target signal not detected in the screen.' }], expected: [[pcr, 'No microbial DNA detected', 'Target microbial DNA not detected.'], [fentanyl, 'not detected', 'Target signal not detected in the screen.']] },
    { rows: [{ test: '<img src=x onerror="alert(1)">', result: '<b>Pending</b>', details: '<script>unsafe & "quoted"</script>' }, { test: 'Other screening', result: 'Not detected', details: 'Target signal not detected in the screen.' }], expected: [['<img src=x onerror="alert(1)">', '<b>Pending</b>', '<script>unsafe & "quoted"</script>'], ['Other screening', 'Not detected', 'Target signal not detected in the screen.']] }
  ];
  const escaped = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  let initialNegative;
  for (const [index, entry] of cases.entries()) {
    const bundle = generatedFixture();
    bundle.record = Object.freeze({ ...bundle.record, screenings: Object.freeze([...bundle.record.screenings.slice(0, 3).map(row => Object.freeze({ ...row })), ...entry.rows.map(row => Object.freeze({ ...row }))]) });
    const before = JSON.stringify(bundle);
    const app = bootApp('/coa/AN-ABCD-1234', [], { publishedReader: true, remoteFetch: async () => ({ ok: true, json: async () => bundle }) });
    await flushLookup();
    const html = app.nodes.get('#coa-view').innerHTML;
    const screening = html.match(/<h2>Screening outcomes<\/h2><dl[^>]*>([\s\S]*?)<\/dl>/)[1];
    for (const [label, result, details] of entry.expected) {
      assert.ok(screening.includes(`<dt>${escaped(label)}</dt><dd>${escaped(result)}${details ? ' · ' + escaped(details) : ''}</dd>`), JSON.stringify(entry));
    }
    assert.doesNotMatch(screening, /<(?:img|script|b)\b| · <\/dd>/);
    assert.equal(JSON.stringify(bundle), before);
    if (index === 0) initialNegative = screening;
    if (index === 1) assert.equal(screening, initialNegative, 'Canonical fields must render idempotently');
    if (index === 2) assert.doesNotMatch(screening, /No microbial DNA detected/);
  }
});

test('real COA transcript identifies same-sample replicates, means and mixed row units accessibly', async () => {
  const bundle = generatedFixture();
  bundle.record.contentUnit = 'mixed';
  bundle.record.purity = ['99.41', '99.43', '99.42'];
  bundle.record.composition = [
    { analyte: 'Peptide A', sample1: '10.10', sample2: '10.30', summary: '10.20', unit: 'mg' },
    { analyte: 'Peptide B', sample1: '5000.00', sample2: '5002.00', summary: '5001.00', unit: 'IU' }
  ];
  const app = bootApp('/coa/AN-ABCD-1234', [], { publishedReader: true, remoteFetch: async () => ({ ok: true, json: async () => bundle }) });
  await flushLookup();
  const html = app.nodes.get('#coa-view').innerHTML;
  assert.match(html, /<summary>Report fields<\/summary>/);
  assert.match(html, /Two determinations of the same sample\./);
  assert.match(html, /Purity \(HPLC-UV area%\)/);
  for (const [label, value] of [['Replicate 1', '99.41'], ['Replicate 2', '99.43'], ['Mean', '99.42']]) {
    assert.ok(html.includes(`<dt>${label}</dt><dd>${value}%</dd>`));
  }
  assert.match(html, /<caption>Measured content · Per-analyte results<\/caption>/);
  assert.match(html, /<th scope="col">Replicate 1<\/th><th scope="col">Replicate 2<\/th><th scope="col">Mean<\/th>/);
  assert.match(html, /<th scope="row">Peptide A \(mg\/vial\)<\/th><td>10.10<\/td><td>10.30<\/td><td>10.20<\/td>/);
  assert.match(html, /<th scope="row">Peptide B \(IU\/vial\)<\/th><td>5000.00<\/td><td>5002.00<\/td><td>5001.00<\/td>/);
  assert.doesNotMatch(html, /Sample [12]|Reported summary|mixed\/vial/);
  assert.match(html, /download>Download PDF/);
  app.click('print');
  assert.equal(app.printed(), 1);
});

test('opt-in lookup ignores late responses after navigation, input edits and newer overlapping codes',async()=>{
  const pending=[];const app=bootApp('/verify',[],{publishedReader:true,remoteFetch:(url,options)=>new Promise(resolve=>pending.push({url,options,resolve}))});
  app.submitLookup('AN-ABCD-1234',false);app.clickLink('/about');pending[0].resolve({ok:true,json:async()=>generatedFixture()});await flushLookup();assert.equal(app.location.pathname,'/about');assert.doesNotMatch(app.document.title,/ABCD/);
  app.clickLink('/verify');app.submitLookup('AN-ABCD-1234',false);app.submitLookup('AN-EFGH-5678',false);
  pending[2].resolve({ok:true,json:async()=>generatedFixture('AN-EFGH-5678')});await flushLookup();pending[1].resolve({ok:true,json:async()=>generatedFixture()});await flushLookup();assert.equal(app.location.pathname,'/coa/AN-EFGH-5678');
  const invalid=bootApp('/verify',[],{publishedReader:true,remoteFetch:async()=>({ok:false})});invalid.submitLookup('bad',false);assert.equal(invalid.networkCalls.length,0);invalid.submitLookup('AN-NONE-0000',false);await flushLookup();assert.equal(invalid.location.pathname,'/verify');assert.match(invalid.nodes.get('#verify-error').textContent,/No COA found/);
});
test('opt-in reader timeout returns a recoverable not-found state and accepts a later lookup',async()=>{
  const timeouts=[];let failed=true;
  const app=bootApp('/coa/AN-ABCD-1234',[],{publishedReader:true,lookupTimeouts:timeouts,remoteFetch:(_url,{signal})=>failed?new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('timed out')))):Promise.resolve({ok:true,json:async()=>generatedFixture()})});
  assert.match(app.nodes.get('#coa-view').innerHTML,/Finding your report/);timeouts[0]();await flushLookup();assert.match(app.nodes.get('#coa-view').innerHTML,/No COA found/);
  failed=false;app.submitLookup('AN-ABCD-1234');await flushLookup();assert.match(app.nodes.get('#coa-view').innerHTML,/HCG 5000IU/);
});

test('generated cached reports revalidate on fresh lookup and back navigation, clear all fields/actions after withdrawal and reject late success', async () => {
  let published=true;const calls=[];
  const app=bootApp('/verify',[],{publishedReader:true,remoteFetch:async(url,options)=>{calls.push([url,options]);return published?{ok:true,json:async()=>generatedFixture()}:{ok:false};}});
  app.submitLookup('AN-ABCD-1234',false);await flushLookup();assert.match(app.nodes.get('#coa-view').innerHTML,/HCG 5000IU/);assert.equal(calls.length,1);
  app.clickLink('/about');published=false;app.travel(-1);assert.match(app.nodes.get('#coa-view').innerHTML,/Finding your report/);assert.doesNotMatch(app.nodes.get('#coa-view').innerHTML,/HCG|Download PDF|copy-code/);await flushLookup();
  assert.equal(calls.length,2);assert.match(app.document.title,/not found/);assert.match(app.nodes.get('#coa-view').innerHTML,/No COA found/);assert.doesNotMatch(app.nodes.get('#coa-view').innerHTML,/HCG|__reports|Download PDF|data-action="copy-/);
  const copies=app.copied.length;app.click('copy-code');await flushLookup();assert.equal(app.copied.length,copies);
  app.clickLink('/verify');app.submitLookup('AN-ABCD-1234',false);await flushLookup();assert.equal(calls.length,3);assert.equal(app.location.pathname,'/verify');assert.match(app.nodes.get('#verify-error').textContent,/No COA found/);
  app.clickLink('/coa/AN-ABCD-1234');await flushLookup();assert.equal(calls.length,4);assert.doesNotMatch(app.nodes.get('#coa-view').innerHTML,/HCG|Download PDF/);assert.ok(calls.every(([,options])=>options.cache==='no-store'));
  const pending=[];const late=bootApp('/coa/AN-ABCD-1234',[],{publishedReader:true,remoteFetch:(url,options)=>new Promise(resolve=>pending.push({url,options,resolve}))});
  late.clickLink('/about');late.clickLink('/coa/AN-ABCD-1234');pending[1].resolve({ok:false});await flushLookup();pending[0].resolve({ok:true,json:async()=>generatedFixture()});await flushLookup();assert.match(late.nodes.get('#coa-view').innerHTML,/No COA found/);assert.doesNotMatch(late.nodes.get('#coa-view').innerHTML,/HCG|Download PDF/);
  late.clickLink('/about');late.travel(-1);assert.equal(pending.length,3);pending[2].resolve({ok:false});await flushLookup();assert.match(late.nodes.get('#coa-view').innerHTML,/No COA found/);
});

test('legacy portal and request actions navigate to account without reading, changing or importing any local bytes',()=>{
 const prior=[{id:'AN-DEMO-KEEP',sample:'Private legacy text',service:'purity',quantity:1}];
 for(const action of ['portal','requests','request-detail','request-resume','request-account','request-legacy']){const app=bootApp('/',prior,{storageReadBlocked:true});app.click(action,{id:prior[0].id});assert.equal(app.location.pathname,'/account');assert.deepEqual(app.storageCalls,[]);assert.deepEqual(app.requests(),prior);assert.doesNotMatch(app.nodes.get('#dialog-content').innerHTML,/Private legacy text/);}
 const recovery=bootApp('/');recovery.click('recover-report');assert.equal(recovery.location.pathname,'/contact');assert.equal(recovery.nodes.get('#app-dialog').open,false);assert.deepEqual(recovery.storageCalls,[]);
});

test('actual recovery auth return keeps the same-owner pending tuple through login and clears it for replacement owner',async()=>{
 const a={id:'account-a',email:'a@example.invalid',emailVerified:false,name:'A',company:''},b={...a,id:'account-b',email:'b@example.invalid'};
 for(const replacement of [false,true]){
  let session=a,remote=null;const writes=[];
  const transport=async(url,options)=>{const route=url.slice('/api/account'.length);if(route==='/session')return {ok:true,json:async()=>({authenticated:!!session,user:session,csrfToken:'synthetic-csrf'})};if(route==='/login'){session=replacement?b:a;return {ok:true,json:async()=>({user:session,csrfToken:'synthetic-csrf'})};}if(route==='/requests'){const body=JSON.parse(options.body);writes.push(body);if(!remote){remote={id:'doc-a',revision:1,record:body.record,createdAt:body.record.createdAt,updatedAt:body.record.createdAt};throw Error('Synthetic lost acknowledgement');}return {ok:true,json:async()=>({request:remote})};}throw Error('Unexpected synthetic route');};
  const app=bootApp('/contact?request=report-recovery',[],{accountTransport:transport});for(let i=0;i<24;i++)await Promise.resolve();assert.equal(app.location.search,'');assert.equal(app.nodes.get('#app-dialog').open,true);
  app.fillRecovery({email:'private-a@example.invalid',reference:'Private A project',notes:'Private A context'});await app.nodes.get('#recovery-form').events.get('submit')({preventDefault(){}});assert.equal(writes.length,1);
  session=null;await app.internals.accountClient.getSession();const form=app.nodes.get('#recovery-form');const button={dataset:{inquiryAction:'sign-in'},closest(){return this;}};form.events.get('click')({target:button});assert.equal(app.location.pathname,'/login');assert.ok(app.internals.getReturn());assert.equal(app.nodes.get('#app-dialog').open,false);
  await app.internals.accountClient.login({email:'synthetic@example.invalid',password:'Synthetic testing password'});app.internals.navigateToURL('/contact?request=report-recovery');for(let i=0;i<24;i++)await Promise.resolve();assert.equal(app.location.search,'');assert.equal(app.nodes.get('#app-dialog').open,true);
  if(replacement){assert.equal(app.internals.getReturn(),null);assert.equal(app.nodes.get('#support-reference').value,'');assert.doesNotMatch(app.nodes.get('#dialog-content').innerHTML,/Private A/);}
  else{assert.equal(app.nodes.get('#support-reference').value,'Private A project');await app.nodes.get('#recovery-form').events.get('submit')({preventDefault(){}});assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.match(app.nodes.get('#support-status').textContent,/Request submitted/);}
  assert.deepEqual(app.storageCalls,[]);
 }
});
