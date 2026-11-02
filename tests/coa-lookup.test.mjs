import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_REPORT, DEMO_REPORTS, normalizeLookupCode, findReportByLookupCode, findLegacyReport, reportPath, resolveCOARoute, validateSubmission } from '../dist/data.js';

test('published immutable lookup codes identify two distinct fictional report records', () => {
  assert.ok(Object.isFrozen(DEMO_REPORTS));
  assert.equal(DEMO_REPORTS.length, 2);
  assert.equal(DEMO_REPORT, DEMO_REPORTS[0]);
  const first = findReportByLookupCode('AN-7K9Q-2M4X');
  const second = findReportByLookupCode('AN-8P6R-3N5Y');
  assert.equal(first.id, 'AN-2026-0042');
  assert.equal(first.sample, 'Reference sample A');
  assert.equal(second.sample, 'Reference sample C');
  for (const key of ['id', 'batch', 'purity', 'identity', 'retentionTime', 'lookupCode']) assert.notEqual(first[key], second[key], key);
  for (const report of DEMO_REPORTS) {
    assert.ok(Object.isFrozen(report));
    assert.equal(report.publication, 'published');
    assert.notEqual(report.lookupCode, report.id);
    assert.match(report.disclaimer, /Fictional demonstration data/);
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
      for (const route of ['/coa/AN-0000-0000', '/coa/AN-2026-0042', '/coa/unknown']) {
        const response = await fetch(base + route);
        assert.equal(response.status, 404);
        assert.ok((await response.text()).includes('id="coa-view"'), 'Unknown code keeps a recoverable app shell');
        const head = await fetch(base + route, { method: 'HEAD' });
        assert.equal(head.status, 404);
        assert.equal(await head.text(), '');
      }
      for (const route of ['/missing', '/assets/missing.png', '/coa/AN-7K9Q-2M4X/missing.css', '/coa/missing.css', '/__dev/not-allowed', '/server.mjs']) {
        const response = await fetch(base + route);
        assert.equal(response.status, 404);
        assert.equal(await response.text(), 'Not found');
      }
      assert.equal((await fetch(base + '/coa/%ZZ')).status, 400);
      assert.equal((await fetch(base + reportPath(DEMO_REPORT.lookupCode), { method: 'POST' })).status, 405);
      assert.equal((await fetch(base + '/?coa=AN-2026-0042')).status, 200);
      assert.equal((await fetch(base + '/__dev/context')).status, mode === 'watch' ? 200 : 404);
      for (const asset of ['/app.js', '/data.js', '/styles.css', '/assets/assaynova-logo.png']) assert.equal((await fetch(base + asset)).status, 200, asset);
    });
  });
}
