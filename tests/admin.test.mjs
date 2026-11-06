import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdmin } from '../conference/admin.mjs';
import { createStudio } from '../conference/studio.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'assaynova-admin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const images = path.join(root, 'images'), store = path.join(root, 'store');
  await mkdir(images);
  await writeFile(path.join(images, 'BPC-157 10mg.png'), await readFile(path.join(project, 'templates/coa/assets/sample-vial-product.png')));
  return { root, images, store, authStore: path.join(root,'auth') };
}
async function freePort() {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function launch(t, files, { enabled = true, production = false, readonly = false } = {}) {
  const port = await freePort(), origin = 'http://127.0.0.1:' + port;
  // Observe real server settings at listen time without changing their values.
  const preload = path.join(files.root, 'inspect-timeouts.mjs');
  await writeFile(preload, "import http from 'node:http';const create=http.createServer;http.createServer=function(...args){const server=create(...args);server.once('listening',()=>console.log('TIMEOUT_PROOF:'+JSON.stringify([server.requestTimeout,server.headersTimeout])));return server;};");
  const args = ['--import', pathToFileURL(preload).href, 'server.mjs', '--port=' + port, ...(enabled || readonly ? ['--conference-reports', '--conference-store=' + files.store] : []), ...(enabled ? ['--admin', '--admin-images=' + files.images, '--admin-auth-store=' + files.authStore] : [])];
  const child = spawn(process.execPath, args, { cwd: project, env: { ...process.env, NODE_ENV: production ? 'production' : 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  let stopped;
  function stop() {
    if (!stopped) stopped = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    return stopped;
  }
  t.after(stop);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(origin + '/')).ok) return { origin, stop, output: () => output }; } catch {}
    await delay(30);
  }
  throw new Error('Admin fixture did not start: ' + output);
}
function raw(origin, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const request = http.request({ hostname: url.hostname, port: url.port, path: pathname, method, headers }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() })); });
    request.on('error', reject); request.end(body);
  });
}


async function fixtureFetch(origin) {
  const html=await (await fetch(origin+'/admin')).text();
  const mode=html.match(/name="admin-auth-mode" content="([^"]+)"/)[1];
  const csrf=html.match(/name="admin-auth-csrf" content="([^"]+)"/)[1];
  const response=await fetch(origin+'/admin/auth/'+mode,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Admin-CSRF':csrf},body:JSON.stringify({password:'Synthetic fixture password 073'})});
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  const secured=(url,options={})=>fetch(url,{...options,headers:{Cookie:cookie,...options.headers}});secured.cookie=cookie;return secured;
}

test('default, production and read-only servers reserve all /admin methods without opening the catalog', async t => {
  const files = await fixture(t);
  for (const options of [{ enabled: false }, { enabled: false, production: true }, { enabled: false, readonly: true }]) {
    const server = await launch(t, files, options);
    for (const pathname of ['/admin', '/admin/', '/admin/operator.js', '/admin/operator.css', '/admin/product-search.mjs', '/admin/api/session', '/admin/api/history', '/admin/api/generate', '/admin/images/opaque', '/admin/bundles/published/AN-TEST-0001/report.pdf']) {
      for (const method of ['GET', 'HEAD', 'POST']) assert.equal((await fetch(server.origin + pathname, { method })).status, 404, method + ' ' + pathname);
    }
    await server.stop();
  }
});

test('admin startup refuses missing reader, production, LAN binds and nonabsolute images', async t => {
  const files = await fixture(t);
  for (const [args, environment, expected] of [
    [['--admin'], 'test', /requires --conference-reports/],
    [['--admin', '--conference-reports'], 'production', /disabled in production/],
    [['--admin', '--conference-reports', '--host=0.0.0.0'], 'test', /loopback bind/],
    [['--admin', '--conference-reports', '--host=192.168.0.60'], 'test', /loopback bind/],
    [['--admin', '--conference-reports', '--host=::'], 'test', /loopback bind/],
    [['--admin', '--conference-reports', '--admin-images=relative'], 'test', /absolute admin image directory/],
    [['--admin', '--conference-reports', '--admin-images=' + files.images, '--admin-public-origin=https://example.invalid/path'], 'test', /plain public origin/]
  ]) {
    const child = spawn(process.execPath, ['server.mjs', ...args, '--port=' + await freePort()], { cwd: project, env: { ...process.env, NODE_ENV: environment }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', bytes => error += bytes);
    assert.notEqual(await new Promise(resolve => child.once('exit', resolve)), 0); assert.match(error, expected);
  }
});

test('mounted admin serves its shell/assets and enforces peer/Host/Origin/token/method/body/path guards', async t => {
  const files = await fixture(t), server = await launch(t, files), origin = server.origin;
  const securedFetch=await fixtureFetch(origin);
  assert.match(server.output(), /TIMEOUT_PROOF:\[10000,10000\]/);
  for (const pathname of ['/admin', '/admin/', '/admin/operator.css', '/admin/operator.js', '/admin/product-search.mjs']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await securedFetch(origin + pathname, { method }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      if (method === 'HEAD') assert.equal(await response.text(), '');
    }
  }
  const html = await (await securedFetch(origin + '/admin')).text(); assert.match(html, /AssayNova<span>ADMIN/); assert.match(html, /id="published-reports"/); assert.doesNotMatch(html, /Coming soon|Users|Orders|Temporary private/);
  const session = await (await securedFetch(origin + '/admin/api/session')).json(), id = session.products[0].id;
  assert.deepEqual(session.products[0].aliases.skus, ['BC10']);
  assert.deepEqual(session.products[0].aliases.families, ['BC']);
  assert.equal((await securedFetch(origin + '/product-search.mjs')).status, 404);
  assert.equal((await securedFetch(origin + '/admin/product-aliases.json')).status, 404);
  assert.equal(session.products.length, 1); assert.equal(session.products[0].imageURL, '/admin/images/' + session.defaultCustomerId + '/' + id); assert.doesNotMatch(JSON.stringify(session.products), /imagePath|[A-Z]:\\|source|private-fixture/);
  assert.equal((await securedFetch(origin + session.products[0].imageURL)).status, 200);
  assert.equal((await raw(origin, '/admin/api/session', { headers: { Host: 'localhost:' + new URL(origin).port } })).status, 403);
  assert.equal((await securedFetch(origin + '/admin/api/session', { headers: { Origin: 'http://evil.invalid' } })).status, 403);
  assert.equal((await securedFetch(origin + '/admin/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const post = (body = {}, headers = {}) => securedFetch(origin + '/admin/api/generate', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Studio-Token': session.token, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({}, { 'X-Studio-Token': 'é'.repeat(64) })).status, 403); assert.equal((await post({}, { 'X-Studio-Token': '' })).status, 403); assert.equal((await post({}, { Origin: '' })).status, 403); assert.equal((await post({}, { 'Content-Type': 'text/plain' })).status, 415); assert.equal((await post({ value: 'x'.repeat(9000) })).status, 413); assert.equal((await post({ productId: '../secret', publish: true })).status, 400);
  assert.equal((await securedFetch(origin + '/admin/api/history', { method: 'PUT' })).status, 405); assert.equal((await securedFetch(origin + '/admin/api/session')).status, 200); assert.equal((await securedFetch(origin + '/admin/api/session')).headers.get('access-control-allow-origin'), null);
  for (const pathname of ['/admin/../server.mjs', '/admin/%2e%2e/server.mjs', '/admin/%252e%252e/server.mjs', '/admin//api/session', '/admin%2fapi%2fsession', '/admin/bundles/published/AN-TEST-0001/private.json']) assert.ok([400, 404].includes((await raw(origin, pathname, {headers:{Cookie:securedFetch.cookie}})).status), pathname);
  for (const pathname of ['/api/session', '/api/history', '/api/generate', '/images/' + id, '/bundles/published/AN-TEST-0001/report.pdf']) for (const method of ['GET', 'POST']) assert.equal((await securedFetch(origin + pathname, { method })).status, 404);
  const admin = await createAdmin({ images: files.images, store: path.join(files.root, 'peer-store'), authStore:path.join(files.root,'peer-auth'), origin, publicOrigin: origin });
  let peerStatus;
  assert.equal(await admin.handle({ url: '/admin/api/session', method: 'GET', headers: { host: new URL(origin).host }, socket: { remoteAddress: '192.168.0.99' } }, { writeHead(status) { peerStatus = status; }, end() {} }), true); assert.equal(peerStatus, 403);
});

test('real integrated generation keeps preview private, publishes once, preserves namespaces and snapshots after restart', async t => {
  const files = await fixture(t); let server = await launch(t, files), origin = server.origin; let securedFetch=await fixtureFetch(origin);
  const session = await (await securedFetch(origin + '/admin/api/session')).json();
  const input = { customerId: session.defaultCustomerId, productId: session.products[0].id, fields: { lot: 'QA-071', received: '2026-11-05', reported: '2026-11-05', purity1: 99.41, purity2: 99.43 }, publish: false };
  const post = value => securedFetch(origin + '/admin/api/generate', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Studio-Token': session.token }, body: JSON.stringify(value) });
  const previewResponse = await post(input); assert.equal(previewResponse.status, 201); const preview = await previewResponse.json();
  assert.match(preview.previewURL, /^\/admin\/bundles\/previews\//); assert.match(preview.pdfURL, /^\/admin\/bundles\/previews\//); assert.equal((await fetch(origin + '/__reports/' + preview.report.lookupCode)).status, 404); assert.equal((await securedFetch(origin + preview.previewURL)).status, 200);
  const concurrent = await Promise.all([post({ ...input, publish: true }), post({ ...input, publish: true })]); assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 409]);
  const published = await concurrent.find(response => response.status === 201).json(), code = published.report.lookupCode;
  assert.match(published.previewURL, /^\/admin\/bundles\/published\//); assert.notEqual(code, preview.report.lookupCode); assert.equal(published.record.purity[2], '99.42');
  const dtoResponse = await fetch(origin + '/__reports/' + code); assert.equal(dtoResponse.status, 200); const dto = await dtoResponse.json(); assert.equal(dto.record.client, 'Research Client'); assert.equal(dto.assets.pdf, '/__reports/' + code + '/report.pdf'); assert.doesNotMatch(JSON.stringify(dto), /imagePath|seed|provenance|token/);
  const pdf = Buffer.from(await (await fetch(origin + dto.assets.pdf)).arrayBuffer()), svg = Buffer.from(await (await fetch(origin + dto.assets.svg)).arrayBuffer()); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.match(svg.toString(), /<svg/); assert.equal((await fetch(origin + '/coa/' + code)).status, 200); assert.equal((await fetch(origin + '/verify')).status, 200);
  assert.equal((await post({ ...input, fields: { purity1: 98 }, publish: true })).status, 400); const history = await (await securedFetch(origin + '/admin/api/history')).json(); assert.deepEqual(history.map(row => row.lookupCode), [code]);
  const storedBefore = await readFile(path.join(files.store, 'published', code, 'bundle.json'));
  await server.stop(); server = await launch(t, files); origin = server.origin; securedFetch=await fixtureFetch(origin);
  assert.equal((await (await securedFetch(origin + '/admin/api/history')).json())[0].lookupCode, code); assert.deepEqual(await readFile(path.join(files.store, 'published', code, 'bundle.json')), storedBefore); assert.deepEqual(Buffer.from(await (await fetch(origin + '/__reports/' + code + '/report.pdf')).arrayBuffer()), pdf); assert.deepEqual(Buffer.from(await (await fetch(origin + '/__reports/' + code + '/report.svg')).arrayBuffer()), svg);
  for (const pathname of ['/admin/bundles/published/' + code + '/private.json', '/__reports/' + code + '/private.json']) assert.equal((await securedFetch(origin + pathname)).status, 404);
  const newSession = await (await securedFetch(origin + '/admin/api/session')).json(); assert.notEqual(newSession.token, session.token);
});

test('compatibility studio redirects its root and uses the same canonical /admin shell and API', async t => {
  const files = await fixture(t), studio = await createStudio({ images: files.images, store: files.store, authStore:files.authStore, port: 0 });
  t.after(() => { studio.server.closeAllConnections(); return new Promise(resolve => studio.server.close(resolve)); });
  const securedFetch=await fixtureFetch(studio.origin);
  const redirect = await fetch(studio.origin + '/', { redirect: 'manual' }); assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), '/admin');
  assert.equal((await securedFetch(studio.origin + '/admin')).status, 200); const session = await (await securedFetch(studio.origin + '/admin/api/session')).json(); assert.match(session.products[0].imageURL, /^\/admin\/images\//); assert.equal(studio.server.requestTimeout, 10000); assert.equal(studio.server.headersTimeout, 10000); assert.equal((await fetch(studio.origin + '/api/session')).status, 404);
});
