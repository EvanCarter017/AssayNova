import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as promptHelpers from '../dev/prompt.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, cp, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotateHTML, rendererDefinitions } from '../dev/context.mjs';
import { buildPrompt, sanitizeContext, sanitizeMarkup, sanitizeAddress, REQUEST_PLACEHOLDER } from '../dev/prompt.js';
import { primaryGesture, sourceHint, rendererForView } from '../dev/locator.js';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const baselineHTML = await readFile(path.join(project, 'dist/index.html'), 'utf8');
const privacyHTML = baselineHTML
  .replace(/<\/head>/i, '<link rel="stylesheet" href="/vendor/cookieconsent-3.2.1/cookieconsent.css"><link rel="stylesheet" href="/privacy/consent.css"></head>')
  .replace(/<\/body>/i, '<script type="module" src="/privacy/consent.js"></script></body>');
const baselineApp = await readFile(path.join(project, 'dist/app.js'), 'utf8');
const sourceLine = (source, needle) => {
  const index = source.indexOf(needle);
  assert.ok(index >= 0, `Expected source marker: ${needle}`);
  return source.slice(0, index).split('\n').length;
};
const heroLine = sourceLine(baselineHTML, '<h1 id="hero-title"');
const rendererLines = Object.fromEntries(['renderSubmission', 'renderSuccess', 'renderReport', 'renderReportNotFound', 'renderPortal', 'renderRequestDetail']
  .map((name) => [name, sourceLine(baselineApp, `function ${name}(`)]));

test('annotations use original opening-tag lines and preserve raw text, quoted >, comments and SVG', () => {
  const html = '<!doctype html>\n<!-- <fake> -->\n<div\n title="x > y">A<svg viewBox="0 0 1 1"><path d="M0 0"/></svg></div>\n<script>const s = "<div>";\nconst n = 4 > 2;</script>\n<style>.x::before{content:"<span>"}</style>\n<textarea><button>text</button></textarea>';
  const annotated = annotateHTML(html);
  assert.equal(annotated.replace(/ data-an-dev-file="[^"]*" data-an-dev-line="\d+"/g, ''), html);
  assert.match(annotated, /<div\n title="x > y" data-an-dev-file="dist\/index.html" data-an-dev-line="3">/);
  assert.match(annotated, /<path d="M0 0" data-an-dev-file="dist\/index.html" data-an-dev-line="4"\/>/);
  assert.match(annotated, /<script[^>]*data-an-dev-line="5">const s = "<div>";/);
  assert.ok(!annotated.includes('<fake data-'));
  assert.ok(!annotated.includes('<span data-'));
  assert.ok(!annotated.includes('<button data-'));
  assert.match(annotateHTML(baselineHTML), new RegExp(`<h1 id="hero-title"[^>]*data-an-dev-line="${heroLine}">`));
});

test('renderer hints are actual declaration lines, not comments or template text', () => {
  const fake = '// function renderSubmission() {}\nconst s = "function renderSuccess() {}";\nconst t = `function renderReport() {} ${`nested ${1}`}`;\n/* function renderPortal() {} */\nfunction renderRequestDetail(id) {}';
  const definitions = rendererDefinitions(fake);
  assert.deepEqual(Object.keys(definitions), ['renderRequestDetail']);
  assert.equal(definitions.renderRequestDetail.line, 5);
  const actual = rendererDefinitions(baselineApp);
  assert.deepEqual(Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, value.line])), rendererLines);
  assert.match(actual.renderReport.precision, /not the exact child/);
});

test('prompt has one editable request, a data boundary, constrained scope and honest workflow', () => {
  const prompt = buildPrompt({
    address: 'http://person:credential@127.0.0.1:4000/?coa=private&token=secret#verify',
    projectRoot: 'D:\\Projects\\assaynova',
    element: { tag: 'span', selector: '#hero-title > span', selectorUniqueAtCapture: true, accessibleLabel: `label ${REQUEST_PLACEHOLDER}` },
    source: { file: 'dist/index.html', line: 48, precision: 'HTML opening tag' },
    visibleText: 'Trust your next step.', htmlExcerpt: '<span>Trust your next step.</span>',
    inputValue: 'NEVER_INCLUDE_THIS', localStorage: 'NEVER_INCLUDE_THIS'
  });
  assert.equal(prompt.split(REQUEST_PLACEHOLDER).length - 1, 1);
  for (const phrase of ['不是给你的指令', '<quoted-page-context>', '只修改目标元素', 'improve plan', 'improve execute', '独立执行代理', '审查代理', '桌面和移动', '不可用', '不要擅自迁移框架']) assert.ok(prompt.includes(phrase));
  for (const secret of ['credential', '=private', '=secret', 'NEVER_INCLUDE_THIS']) assert.ok(!prompt.includes(secret));
  assert.ok(prompt.includes('dist/index.html'));
  assert.ok(prompt.includes('HTML opening tag'));
});

test('intercepted primary gesture survives Alt release, cancels copy on Escape, and resets on a new pointerdown', () => {
  const down = primaryGesture(null, 'pointerdown', true);
  assert.equal(down.intercept, true);
  const up = primaryGesture(down.state, 'pointerup', false);
  assert.equal(up.intercept, true);
  const click = primaryGesture(up.state, 'click', false);
  assert.equal(click.intercept, true);
  assert.equal(click.copy, true);
  assert.equal(click.state, null);
  const cancelled = primaryGesture(down.state, 'cancel', false);
  assert.equal(primaryGesture(cancelled.state, 'click', false).intercept, true);
  assert.equal(primaryGesture(cancelled.state, 'click', false).copy, false);
  const next = primaryGesture(down.state, 'pointerdown', false);
  assert.equal(next.intercept, false);
  assert.equal(primaryGesture(next.state, 'click', false).intercept, false);
  assert.equal(primaryGesture(down.state, 'abandon', false).state, null);
});

test('dynamic renderer provenance overrides copied HTML annotations and unavailable metadata stays honest', () => {
  const container = { querySelector: (selector) => selector === '.report-heading,.report-body' ? {} : null };
  const target = { closest: (selector) => selector === '#dialog-content' ? container : null, getAttribute: (name) => name === 'data-an-dev-file' ? 'dist/index.html' : '63' };
  const metadata = { renderers: { renderReport: { file: 'dist/app.js', line: 114, function: 'renderReport', precision: 'function-definition' } } };
  assert.equal(sourceHint(target, metadata).function, 'renderReport');
  assert.equal(sourceHint(target, metadata).line, 114);
  assert.equal(sourceHint(target, {}).precision, 'unavailable');
  assert.ok(!sourceHint(target, {}).file);
  const outer = { closest: () => null, getAttribute: (name) => name === 'data-an-dev-file' ? 'dist/index.html' : '104' };
  assert.equal(sourceHint(outer, metadata).line, 104);
  assert.equal(rendererForView({ success: true, requestDetail: true }), 'renderSuccess');
  assert.equal(rendererForView({ portal: true, requestDetail: true }), 'renderPortal');
  assert.equal(rendererForView({ requestDetail: true }), 'renderRequestDetail');
});

test('public report and recovery children have honest active-renderer provenance', () => {
  const metadata = { renderers: rendererDefinitions(baselineApp) };
  for (const name of ['renderReport', 'renderReportNotFound']) {
    const container = { querySelector: (selector) => {
      if (name === 'renderReport' && selector === '.report-heading,.report-body') return {};
      if (name === 'renderReportNotFound' && selector === '.coa-not-found') return {};
      return null;
    } };
    const target = { closest: (selector) => selector === '#coa-view' ? container : null, getAttribute: () => '48' };
    const hint = sourceHint(target, metadata);
    assert.equal(hint.function, name);
    assert.equal(hint.file, 'dist/app.js');
    assert.equal(hint.line, rendererLines[name]);
    assert.match(hint.precision, /function-definition/);
    assert.equal(sourceHint(target, {}).precision, 'unavailable');
  }
});

test('context and markup are bounded, allowlisted, and exclude editable/control data', () => {
  const html = '<div data-an-dev-line="48" onclick="bad()"><input type="password" value="HIDDEN_A" checked><textarea>HIDDEN_B</textarea><select><option value="HIDDEN_C" selected>HIDDEN_D</option></select><div contenteditable="true"><b>HIDDEN_E</b><div>HIDDEN_F</div>HIDDEN_G</div><script>HIDDEN_H</script><a href="https://user:HIDDEN_I@example.com/path?key=HIDDEN_J">safe</a><dl class="success-details"><dd>HIDDEN_K</dd></dl><div class="reference-box"><strong>HIDDEN_L</strong></div><div id="panel-requests"><table><tr><td>HIDDEN_M</td></tr></table><button data-id="HIDDEN_N">Details</button></div></div>';
  const clean = sanitizeMarkup(html);
  for (const marker of ['HIDDEN_', 'data-an-dev-', 'onclick', 'checked', 'selected', 'value=']) assert.ok(!clean.includes(marker), marker);
  assert.ok(clean.includes('safe'));
  assert.ok(clean.includes('example.com/path?key'));
  const data = sanitizeContext({
    address: 'https://user:password@example.com/path?token=secret#private=value',
    element: { tag: 'div', value: 'HIDDEN' }, visibleText: 'x'.repeat(5000), htmlExcerpt: '<b>' + 'y'.repeat(5000) + '</b>',
    computedStyle: { color: 'red', unrelated: 'HIDDEN' },
    matchingCSS: Array.from({ length: 20 }, () => ({ path: '/styles.css?v=secret', selector: 'z'.repeat(1000), declarations: 'p'.repeat(2000) })),
    cookie: 'HIDDEN', textarea: 'HIDDEN', viewport: { width: 1280, height: 720, dpr: 1, scrollX: 0, scrollY: 10 }
  });
  assert.ok(!JSON.stringify(data).includes('HIDDEN'));
  assert.ok(!JSON.stringify(data).includes('secret'));
  assert.ok(data.visibleText.length <= 360);
  assert.ok(data.htmlExcerpt.length <= 1200);
  assert.equal(data.matchingCSS.length, 8);
  assert.ok(data.matchingCSS[0].selector.length <= 240);
  assert.ok(data.matchingCSS[0].declarations.length <= 500);
  assert.equal(sanitizeAddress('javascript:alert(1)'), '[non-HTTP address omitted]');
});

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function withServer(mode, callback, host) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'assaynova-dev-test-'));
  let child;
  let exit;
  let output = '';
  try {
    for (const file of ['server.mjs', 'dev-client.js', 'dev', 'dist', 'package.json']) await cp(path.join(project, file), path.join(fixture, file), { recursive: true });
    const port = await freePort();
    assert.notEqual(port, 4317);
    child = spawn(process.execPath, ['server.mjs', '--no-accounts', `--port=${port}`, ...(host === undefined ? [] : [`--host=${host}`]), ...(mode === 'default' ? [] : ['--watch'])], {
      cwd: fixture, env: { ...process.env, NODE_ENV: mode === 'production' ? 'production' : 'test' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 7000);
      const data = (chunk) => { output += chunk; if (output.includes('Press Ctrl+C to stop.')) { clearTimeout(timeout); resolve(); } };
      child.stdout.on('data', data);
      child.stderr.on('data', data);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Server exited during startup: ${output}`)); });
    });
    await callback({ base: `http://127.0.0.1:${port}`, fixture, output: () => output });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (exit) await exit;
    const resolvedFixture = path.resolve(fixture);
    const resolvedTemp = path.resolve(tmpdir());
    assert.equal(path.dirname(resolvedFixture).toLowerCase(), resolvedTemp.toLowerCase(), 'Cleanup must stay directly inside the temporary directory');
    assert.ok(path.basename(resolvedFixture).startsWith('assaynova-dev-test-'));
    assert.notEqual(resolvedFixture.toLowerCase(), resolvedTemp.toLowerCase());
    await rm(resolvedFixture, { recursive: true, force: true });
  }
}

for (const mode of ['default', 'production', 'watch']) {
  test(`HTTP ${mode}: dev isolation, static routes, methods, HEAD and CSP`, async () => {
    await withServer(mode, async ({ base, fixture, output }) => {
      assert.match(output(), /Bind: 127\.0\.0\.1/);
      const response = await fetch(base);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const enabled = mode === 'watch';
      assert.equal(html.includes('/__dev/client.js'), enabled);
      assert.equal(html.includes('data-an-dev-file'), enabled);
      if (!enabled) assert.equal(html, privacyHTML);
      for (const route of ['client.js', 'locator.js', 'prompt.js', 'context', 'status']) {
        const result = await fetch(`${base}/__dev/${route}`);
        assert.equal(result.status, enabled ? 200 : 404, route);
        const body = await result.text();
        if (!enabled) assert.ok(!body.includes(fixture));
      }
      for (const route of ['/__dev/context.mjs', '/__dev/../server.mjs', '/dev/locator.js', '/server.mjs', '/dev-client.js']) assert.equal((await fetch(base + route)).status, 404, route);
      assert.equal((await fetch(`${base}/__dev/events`, { method: 'HEAD' })).status, enabled ? 405 : 404);
      assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
      assert.equal(await (await fetch(base, { method: 'HEAD' })).text(), '');
      assert.equal((await fetch(base, { method: 'POST' })).status, 405);
      for (const route of ['/app.js', '/styles.css', '/assets/assaynova-logo.png']) assert.equal((await fetch(base + route)).status, 200, route);
      if (enabled) {
        const metadata = await (await fetch(`${base}/__dev/context`)).json();
        assert.equal(metadata.projectRoot, fixture);
        assert.equal(metadata.renderers.renderSubmission.line, rendererLines.renderSubmission);
        assert.equal(metadata.renderers.renderReport.line, rendererLines.renderReport);
        assert.match(html, new RegExp(`<h1 id="hero-title"[^>]*data-an-dev-line="${heroLine}">`));
      }
    });
  });
}

test('explicit LAN binding serves normal SPA, reports and privacy without exposing development routes', async () => {
  await withServer('default', async ({ base, fixture, output }) => {
    assert.match(output(), /Bind: 0\.0\.0\.0/);
    assert.match(output(), /Local: http:\/\/127\.0\.0\.1:/);
    const expectedCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
    for (const route of ['/testing-methods', '/about', '/verify', '/contact', '/coa/AN-7K9Q-2M4X']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route); assert.equal(await response.text(), privacyHTML, route);
      assert.equal(response.headers.get('content-security-policy'), expectedCSP);
      const head = await fetch(base + route, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    }
    for (const route of ['/styles.css', '/app.js', '/reports/sample-a.pdf', '/privacy/consent.js']) {
      const response = await fetch(base + route); assert.equal(response.status, 200, route);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path.join(fixture, 'dist', route)));
      assert.equal((await fetch(base + route, { method: 'HEAD' })).status, 200);
    }
    for (const route of ['client.js', 'locator.js', 'prompt.js', 'context', 'status', 'events']) {
      assert.equal((await fetch(`${base}/__dev/${route}`)).status, 404, route);
      assert.equal((await fetch(`${base}/__dev/${route}`, { method: 'HEAD' })).status, 404, route);
    }
    assert.deepEqual(await (await fetch(base + '/privacy/signals')).json(), { gpc: false });
    assert.deepEqual(await (await fetch(base + '/privacy/signals', { headers: { 'Sec-GPC': '1' } })).json(), { gpc: true });
  }, '0.0.0.0');
});

test('empty, hostname and malformed host arguments exit before listening', async () => {
  for (const host of ['', 'localhost', '300.1.2.3', '[::1]']) {
    await assert.rejects(withServer('default', () => assert.fail('Invalid host must not listen'), host), error => {
      assert.match(error.message, /Server exited during startup:/);
      assert.match(error.message, /Choose a literal IPv4 or IPv6 address for --host/);
      assert.ok(!error.message.includes('Press Ctrl+C to stop.'));
      assert.ok(!error.message.includes('timed out'));
      return true;
    });
  }
});

test('dev file read failures return 503 and leave the server running', async () => {
  await withServer('watch', async ({ base, fixture }) => {
    await rm(path.join(fixture, 'dev/locator.js'));
    await rm(path.join(fixture, 'dist/app.js'));
    assert.equal((await fetch(`${base}/__dev/locator.js`)).status, 503);
    const head = await fetch(`${base}/__dev/context`, { method: 'HEAD' });
    assert.equal(head.status, 503);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(`${base}/__dev/status`)).status, 200);
  });
});

test('watch event stream keeps CSS changes and closes cleanly', async () => {
  await withServer('watch', async ({ base, fixture }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    let reader;
    try {
      const response = await fetch(`${base}/__dev/events`, { signal: controller.signal });
      reader = response.body.getReader();
      let text = new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /event: connected/);
      await appendFile(path.join(fixture, 'dist/styles.css'), '\n/* test watch event */\n');
      while (!text.includes('event: change')) text += new TextDecoder().decode((await reader.read()).value);
      assert.match(text, /"paths":\["\/styles.css"\]/);
      const status = await (await fetch(`${base}/__dev/status`)).json();
      assert.ok(status.revision >= 1);
    } finally {
      clearTimeout(timeout);
      await reader?.cancel();
      controller.abort();
    }
  });
});

test('request-private markup strips all identifying opening attributes including marked void images', () => {
  for (const marker of ['data-request-private', 'data-request-private=""', 'data-request-private="yes"']) {
    for (const html of [`<img ${marker} role="img" src="blob:SECRET_FILE" alt="SECRET_NAME" title="SECRET_EMAIL" id="SECRET_REF" class="SECRET_CLASS" name="SECRET_NAME">`, `<section><h2>Public heading</h2><div ${marker} id="SECRET_REF"><h3>SECRET_SAMPLE</h3><img src="blob:SECRET_FILE" alt="SECRET_NAME"><span>SECRET_EMAIL</span></div></section>`]) {
      const clean = sanitizeMarkup(html);
      assert.ok(!clean.includes('SECRET'), clean);
      assert.ok(!/src=|alt=|title=|name=|data-request-private=/.test(clean), clean);
      assert.match(clean, /content omitted/);
      const prompt = buildPrompt({ htmlExcerpt: html, visibleText: 'Public heading', element: { tag: 'section' } });
      assert.ok(!prompt.includes('SECRET'));
    }
  }
});

test('live locator masks request summary/review children and ancestors and returns honest dynamic provenance', async () => {
  class Element {
    constructor(tag, attributes = {}, children = []) { this.localName = tag; this.nodeType = 1; this.attributes = attributes; this.childNodes = children; this.id = attributes.id || ''; for (const child of children) child.parentElement = this; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    matches(selector) { return selector.split(',').some(part => { if (part.startsWith('#')) return this.id === part.slice(1); if (part.startsWith('.')) return (this.attributes.class || '').split(/\s+/).includes(part.slice(1)); const attr = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(part); return attr ? this.hasAttribute(attr[1]) && (attr[2] === undefined || this.getAttribute(attr[1]) === attr[2]) : this.localName === part; }); }
    closest(selector) { for (let value = this; value; value = value.parentElement) if (value.matches(selector)) return value; return null; }
  }
  const text = value => ({ nodeType: 3, textContent: value });
  const image = new Element('img', { 'data-request-private': '', src: 'blob:SECRET_FILE', alt: 'SECRET_FILENAME', role: 'img' });
  const privateBlock = new Element('div', { 'data-request-private': '', title: 'SECRET_REF' }, [new Element('h3', {}, [text('SECRET_SAMPLE')]), text('SECRET_EMAIL'), image]);
  const heading = new Element('h2', {}, [text('Public heading')]);
  const root = new Element('section', { id: 'request-flow' }, [heading, privateBlock]);
  const document = { createTreeWalker(target, _kind, filter) { const values = []; const collect = node => { if (node.nodeType === 3) values.push(node); else for (const child of node.childNodes) collect(child); }; collect(target); let i = 0; return { nextNode() { while (i < values.length) { const value = values[i++]; if (filter.acceptNode(value) === 1) return value; } return null; } }; } };
  const source = (await readFile(path.join(project, 'dev/locator.js'), 'utf8')).replace(/^import[^\n]+\r?\n/, '').replace(/export function/g, 'function');
  const context = { ...promptHelpers, Element, Node: { TEXT_NODE: 3 }, NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 }, document, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
  runInNewContext(source + '\nglobalThis.actual = { privateContent, safeText, htmlExcerpt, sourceHint };', context);
  assert.equal(context.actual.privateContent(image), true);
  assert.equal(context.actual.safeText(root), 'Public heading');
  for (const selected of [root, privateBlock, image]) {
    const excerpt = context.actual.htmlExcerpt(selected);
    assert.ok(!excerpt.includes('SECRET'), excerpt);
    assert.ok(!buildPrompt({ htmlExcerpt: excerpt, visibleText: context.actual.safeText(selected) }).includes('SECRET'));
  }
  const hint = context.actual.sourceHint(image, { renderers: {} });
  assert.equal(hint.precision, 'unavailable'); assert.equal(hint.file, undefined);
  const outer = { closest: () => null, getAttribute: key => key === 'data-an-dev-file' ? 'dist/index.html' : '100' };
  assert.equal(context.actual.sourceHint(outer, {}).line, 100);
});


test('account profile, recovery codes and draft summaries reuse the private markup boundary', () => {
  const raw = '<section data-request-private><h2>PRIVATE_ACCOUNT_NAME</h2><p>PRIVATE_ACCOUNT_EMAIL</p><ul><li><code>PRIVATE_ACCOUNT_CODE</code></li></ul><textarea>PRIVATE_ACCOUNT_COPY</textarea><button data-id="PRIVATE_ACCOUNT_DRAFT">Resume</button></section>';
  const clean = sanitizeMarkup(raw); assert.ok(!clean.includes('PRIVATE_ACCOUNT_')); assert.ok(clean.includes('[content omitted]'));
});
