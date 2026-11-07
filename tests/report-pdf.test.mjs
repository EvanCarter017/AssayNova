import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseReportPDFRoute, builtinReportPDF } from '../report-pdf.mjs';
import { SAMPLE_REPORT_DATA } from '../dist/reports/sample-data.js';
import { handlePublicReport } from '../conference/reader.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function fixture(t) {
  const store = await mkdtemp(path.join(tmpdir(), 'assaynova-pdf-')); t.after(() => rm(store, { recursive: true, force: true }));
  async function record(code, folder = 'published', publication = 'published') {
    const directory = path.join(store, folder, code); await mkdir(directory, { recursive: true });
    const bytes = Buffer.from('%PDF-synthetic-route-fixture-' + code);
    await writeFile(path.join(directory, 'report.pdf'), bytes);
    await writeFile(path.join(directory, 'bundle.json'), JSON.stringify({ label: 'Route fixture', report: { lookupCode: code, publication }, record: SAMPLE_REPORT_DATA['AN-7K9Q-2M4X'] }));
    return bytes;
  }
  const bytes = await record('AN-TEST-0001'); await record('AN-TEST-0002', 'previews'); await record('AN-TEST-0003', 'published', 'preview');
  return { store, bytes };
}
async function server(t, store, { enabled = false, production = false } = {}) {
  const port = await freePort(), child = spawn(process.execPath, ['server.mjs', '--no-accounts', '--port=' + port, ...(enabled ? ['--conference-reports', '--conference-store=' + store] : [])], { cwd: project, env: { ...process.env, NODE_ENV: production ? 'production' : 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } });
  const origin = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error(output); try { if ((await fetch(origin + '/')).ok) return origin; } catch {} await delay(30); }
  throw new Error('PDF fixture did not start: ' + output);
}

test('canonical PDF route is exact and has only two fixed built-in file mappings', () => {
  assert.equal(parseReportPDFRoute('/coa/AN-TEST-0001/report.pdf'), 'AN-TEST-0001');
  for (const route of ['/coa/an-test-0001/report.pdf', '/coa/AN-TEST-0001/report.pdf?x=1', '/coa/%41N-TEST-0001/report.pdf', '/coa/AN-TEST-0001/report.pdf/', '/coa/AN-TEST-0001/../report.pdf', '/coa/AN-TEST-0001/report.svg', '/coa/AN-TEST-0001/report.pdf#part', '/coa/AN-TEST-0001/report.pdf\n', '/coa/AN-TEST-0001/report.pdf\r\n']) assert.equal(parseReportPDFRoute(route), null, route);
  assert.equal(builtinReportPDF('AN-7K9Q-2M4X'), 'sample-a.pdf'); assert.equal(builtinReportPDF('AN-8P6R-3N5Y'), 'sample-c.pdf'); assert.equal(builtinReportPDF('AN-TEST-0001'), null);
});

test('static and production aliases serve the correct two master PDFs inline with HEAD parity and existing pages intact', async t => {
  const { store } = await fixture(t);
  for (const production of [false, true]) {
    const origin = await server(t, store, { production });
    for (const [code, stem] of [['AN-7K9Q-2M4X', 'sample-a'], ['AN-8P6R-3N5Y', 'sample-c']]) {
      const route = '/coa/' + code + '/report.pdf', response = await fetch(origin + route), bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/pdf'); assert.equal(response.headers.get('content-disposition'), `inline; filename="${code}.pdf"`); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(bytes, await readFile(path.join(project, 'dist/reports/' + stem + '.pdf'))); assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      const head = await fetch(origin + route, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), ''); for (const header of ['content-type', 'content-disposition', 'cache-control', 'x-content-type-options']) assert.equal(head.headers.get(header), response.headers.get(header));
      assert.equal((await fetch(origin + '/coa/' + code)).status, 200);
      assert.equal((await fetch(origin + route, { method: 'POST' })).status, 405);
    }
    for (const route of ['/coa/AN-TEST-0001/report.pdf', '/coa/AN-7K9Q-2M4X/report.pdf?x=1', '/coa/%41N-7K9Q-2M4X/report.pdf', '/coa/AN-7K9Q-2M4X/report.pdf/extra', '/__dev/context', '/admin/api/session']) assert.equal((await fetch(origin + route)).status, 404, route);
  }
});

test('opt-in canonical alias serves only a published valid record and preserves legacy attachment URLs', async t => {
  const { store, bytes } = await fixture(t), origin = await server(t, store, { enabled: true });
  const response = await fetch(origin + '/coa/AN-TEST-0001/report.pdf'); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes); assert.equal(response.headers.get('content-disposition'), 'inline; filename="AN-TEST-0001.pdf"');
  const head = await fetch(origin + '/coa/AN-TEST-0001/report.pdf', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const legacy = await fetch(origin + '/__reports/AN-TEST-0001/report.pdf'); assert.equal(legacy.status, 200); assert.equal(legacy.headers.get('content-disposition'), 'attachment; filename="AN-TEST-0001.pdf"'); assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), bytes);
  for (const route of ['/coa/AN-TEST-0002/report.pdf', '/coa/AN-TEST-0003/report.pdf', '/coa/AN-NONE-0000/report.pdf', '/coa/AN-TEST-0001/report.pdf?x=1', '/coa/AN-TEST-0001/report.pdf/private', '/coa/%41N-TEST-0001/report.pdf', '/coa/AN-TEST-0001/%2e%2e%2fprivate.json']) assert.equal((await fetch(origin + route)).status, 404, route);
  assert.equal((await fetch(origin + '/coa/AN-TEST-0001/report.pdf', { method: 'PUT', body: 'unexpected' })).status, 405);
  assert.equal((await fetch(origin + '/coa/AN-TEST-0001')).status, 200);
});

test('shared reader handles canonical GET/HEAD without changing caller dispatch API', async t => {
  const { store, bytes } = await fixture(t), publicServer = http.createServer(async (request, response) => { if (!await handlePublicReport(request, response, new URL(request.url, 'http://localhost').pathname, store)) { response.writeHead(404); response.end(); } });
  await new Promise(resolve => publicServer.listen(0, '127.0.0.1', resolve)); t.after(() => { publicServer.closeAllConnections(); return new Promise(resolve => publicServer.close(resolve)); });
  const origin = 'http://127.0.0.1:' + publicServer.address().port;
  assert.deepEqual(Buffer.from(await (await fetch(origin + '/coa/AN-TEST-0001/report.pdf')).arrayBuffer()), bytes);
  assert.equal((await fetch(origin + '/coa/AN-TEST-0001/report.pdf', { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(origin + '/coa/AN-TEST-0001/report.pdf', { method: 'DELETE' })).status, 405);
});
