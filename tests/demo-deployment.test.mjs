import { spawnSync } from 'node:child_process';
import { PYTHON } from '../conference/store.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { exportDemoCatalog } from '../scripts/export-demo-catalog.mjs';
import { loadCatalog } from '../conference/catalog.mjs';
import { loadManagedCatalog, loadImportedAliases } from '../conference/import-match.mjs';
import { legacyRecords, writeCatalogRecords, readCatalogRecords } from '../conference/catalog-records.mjs';

const hash = raw => createHash('sha256').update(raw).digest('hex');
const customer = 'a'.repeat(20), revision = 'b'.repeat(32);
const targetStore = '/var/lib/assaynova-demo/reports', targetImages = '/var/lib/assaynova-demo/seed-images';
const picture = await fs.readFile(new URL('../templates/coa/assets/sample-vial-product.png', import.meta.url));
async function fixture(t, managed = true) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'assaynova-demo-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceStore = path.join(root, 'source'), imageRoot = path.join(root, 'pictures');
  await fs.mkdir(path.join(sourceStore, 'customers'), { recursive: true }); await fs.mkdir(imageRoot);
  await fs.writeFile(path.join(imageRoot, 'BPC-157 10mg.png'), picture);
  const products = await loadCatalog(imageRoot);
  const row = { id: customer, name: 'Synthetic catalog', directory: imageRoot };
  let records;
  if (managed) {
    const legacy = await legacyRecords({ products }, { importId: 'c'.repeat(32), previewId: 'd'.repeat(32), customerId: customer });
    records = legacy.records; records.entries[0].hold = true;
    const extra = Buffer.concat([picture, Buffer.from('unused catalog image')]), id = hash(extra).slice(0, 32), extraPath = path.join(imageRoot, 'unused.png');
    await fs.writeFile(extraPath, extra);
    records.images.push({ id, filename: 'unused.png', sha256: hash(extra), bytes: extra.length });
    legacy.sources.push({ ...records.images.at(-1), path: extraPath, immutable: false });
    await writeCatalogRecords(sourceStore, revision, records, legacy.sources); row.catalogRevision = revision;
  }
  const profile = path.join(sourceStore, 'customers', 'profiles.json');
  await fs.writeFile(profile, JSON.stringify({ version: 1, customers: [row] }));
  for (const forbidden of ['published', 'removed', 'previews', 'staging', 'customer-imports/staging', 'customer-imports/receipts', 'accounts', 'admin-auth']) {
    const folder = path.join(sourceStore, forbidden); await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'forbidden-sentinel'), 'must never be exported');
  }
  return { root, sourceStore, imageRoot, profile, row, products, records, options: { sourceStore, imageRoot, targetStore, targetImages, output: path.join(root, 'output') } };
}

test('catalog exporter preserves exact current records, blocked rows and every declared image; relocates only profile directories', async t => {
  const f = await fixture(t), profileBefore = await fs.readFile(f.profile), recordBefore = await fs.readFile(path.join(f.sourceStore, 'customer-imports/revisions', revision, 'records.json'));
  const seen = [], originalRead = fs.readFile;
  fs.readFile = async (filename, ...args) => { seen.push(String(filename)); assert.ok(!String(filename).includes('forbidden-sentinel')); return originalRead(filename, ...args); };
  let manifest; try { manifest = await exportDemoCatalog(f.options); } finally { fs.readFile = originalRead; }
  assert.deepEqual(manifest.counts, { customers: 1, revisions: 1, images: 2 });
  assert.equal(manifest.files.length, 4); assert.ok(manifest.files.every(row => !/published|removed|previews|staging|receipts|accounts|admin-auth/.test(row.path)));
  const relocated = await readCatalogRecords(path.join(f.options.output, 'store'), revision);
  assert.deepEqual(relocated.records, f.records); assert.equal(relocated.counts.blocked, 1); assert.equal(relocated.counts.ready, 0); assert.equal(relocated.sources.length, 2);
  assert.deepEqual(await fs.readFile(path.join(f.options.output, 'store/customer-imports/revisions', revision, 'records.json')), recordBefore);
  const profiles = JSON.parse(await fs.readFile(path.join(f.options.output, 'store/customers/profiles.json'), 'utf8'));
  assert.deepEqual(profiles.customers[0], { ...f.row, directory: targetStore + '/customer-imports/revisions/' + revision + '/images' });
  assert.deepEqual(await fs.readFile(f.profile), profileBefore);
  for (const entry of manifest.files) { const raw = await fs.readFile(path.join(f.options.output, entry.path)); assert.equal(raw.length, entry.bytes); assert.equal(hash(raw), entry.sha256); }
  assert.ok(seen.length > 0);
});

test('legacy image/alias revisions and selected directory PNGs export without duplicating unselected photos', async t => {
  const f = await fixture(t, false), imageRevision = 'e'.repeat(32), aliasRevision = 'f'.repeat(32), legacyFolder = path.join(f.sourceStore, 'customer-imports/revisions', imageRevision), aliasFolder = path.join(f.sourceStore, 'customer-imports/revisions', aliasRevision);
  await fs.mkdir(path.join(legacyFolder, 'images'), { recursive: true }); await fs.mkdir(aliasFolder, { recursive: true });
  await fs.writeFile(path.join(legacyFolder, 'images/BC10.png'), picture);
  const catalog = { version: 1, products: [{ id: f.products[0].id, name: f.products[0].name, imageCode: 'BC10', imageFile: 'BC10.png', sha256: hash(picture) }] };
  const aliases = { version: 1, aliases: [{ sku: 'SYNTH10', productId: f.products[0].id }] };
  await fs.writeFile(path.join(legacyFolder, 'catalog.json'), JSON.stringify(catalog)); await fs.writeFile(path.join(aliasFolder, 'aliases.json'), JSON.stringify(aliases));
  await fs.writeFile(path.join(f.imageRoot, 'BPC-157 10mg (2).png'), picture); await fs.writeFile(path.join(f.imageRoot, 'excluded.txt'), 'unrelated');
  const rows = [{ ...f.row, imageRevision, aliasRevision }, { ...f.row, id: '1'.repeat(20), name: 'Directory catalog', aliasRevision }];
  await fs.writeFile(f.profile, JSON.stringify({ version: 1, customers: rows }));
  const before = await fs.readFile(f.profile), result = await exportDemoCatalog(f.options);
  assert.equal(result.counts.customers, 2); assert.equal(result.counts.images, 2); assert.equal(result.counts.revisions, 2);
  assert.ok(!result.files.some(row => /excluded|\(2\)/.test(row.path)));
  const loaded = await loadManagedCatalog(path.join(f.options.output, 'store'), imageRevision), mapped = await loadImportedAliases(path.join(f.options.output, 'store'), aliasRevision, loaded.products);
  assert.deepEqual(mapped[0].importSkus, ['SYNTH10']);
  assert.deepEqual(await fs.readFile(f.profile), before);
  const rewritten = JSON.parse(await fs.readFile(path.join(f.options.output, 'store/customers/profiles.json'), 'utf8'));
  assert.equal(rewritten.customers[1].directory, targetImages + '/' + rows[1].id);
});

test('export refuses existing destinations, unsafe roots, traversal and arbitrary directory references', async t => {
  const f = await fixture(t, false); await fs.mkdir(f.options.output); await fs.writeFile(path.join(f.options.output, 'keep'), 'existing');
  await assert.rejects(exportDemoCatalog(f.options)); assert.equal(await fs.readFile(path.join(f.options.output, 'keep'), 'utf8'), 'existing');
  for (const patch of [{ output: path.join(f.sourceStore, 'nested') }, { output: path.join(f.imageRoot, 'nested') }, { sourceStore: 'relative' }, { imageRoot: '\\\\server\\share' }, { targetStore: '/var/lib/../escape' }, { targetImages: targetStore + '/images' }]) await assert.rejects(exportDemoCatalog({ ...f.options, output: path.join(f.root, 'unsafe'), ...patch }));
  const outside = path.join(f.root, 'unapproved'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'BPC-157 10mg.png'), picture);
  await fs.writeFile(f.profile, JSON.stringify({ version: 1, customers: [{ ...f.row, directory: outside }] }));
  const output = path.join(f.root, 'failed'); await assert.rejects(exportDemoCatalog({ ...f.options, output })); await fs.access(output); await assert.rejects(fs.access(path.join(output, 'catalog-manifest.json')), { code: 'ENOENT' });
});

test('missing, mismatched and redirected declared images stop export and preserve the source', async t => {
  for (const mode of ['missing', 'hash', 'link']) {
    const f = await fixture(t), filename = path.join(f.sourceStore, 'customer-imports/revisions', revision, 'images', f.records.images[0].id + '.png'), before = await fs.readFile(f.profile);
    if (mode === 'hash') await fs.writeFile(filename, 'mismatched');
    else { await fs.unlink(filename); if (mode === 'link') await fs.symlink(path.join(f.imageRoot, 'BPC-157 10mg.png'), filename); }
    await assert.rejects(exportDemoCatalog(f.options)); assert.deepEqual(await fs.readFile(f.profile), before); await fs.access(f.options.output); await assert.rejects(fs.access(path.join(f.options.output, 'catalog-manifest.json')), { code: 'ENOENT' });
  }
  const f = await fixture(t, false), target = path.join(f.root, 'real-output-parent'), linked = path.join(f.root, 'linked'); await fs.mkdir(target); await fs.symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(exportDemoCatalog({ ...f.options, output: path.join(linked, 'output') })); await assert.rejects(fs.access(path.join(target, 'output')), { code: 'ENOENT' });
});

test('demo service and Nginx artifacts confine data and preserve ACME, host/origin boundaries and TLS gating', async () => {
  const read = name => fs.readFile(new URL('../deploy/demo/' + name, import.meta.url), 'utf8');
  const service = await read('assaynova.service'), http = await read('assaynova-http.nginx.conf'), https = await read('assaynova-https.nginx.conf'), installer = await read('install.sh');
  assert.match(service, /Environment=NODE_ENV=demo/); assert.match(service, /--host=127\.0\.0\.1 --port=4330/); assert.match(service, /User=assaynova-demo/); assert.match(service, /UMask=0077/); assert.match(service, /ReadWritePaths=\/var\/lib\/assaynova-demo/); assert.doesNotMatch(service, /--watch|--no-accounts/);
  for (const config of [http, https]) { assert.match(config, /location \^~ \/\.well-known\/acme-challenge\//); assert.doesNotMatch(config, /default_server|vialcove|alias \/var\/lib/i); const log = config.match(/log_format[^;]+;/)[0]; assert.match(log, /\$request_method \$uri \$server_protocol/); assert.doesNotMatch(log, /\$request_uri|\$request\b|\$args|cookie|authorization|referer|request_body/i); assert.match(config, /error_log \/dev\/null/); }
  assert.match(http, /location \/ \{ return 503; \}/); assert.doesNotMatch(http, /proxy_pass|ssl_certificate/);
  assert.match(https, /proxy_pass http:\/\/127\.0\.0\.1:4330/); assert.match(https, /proxy_set_header Origin \$http_origin/); assert.match(https, /proxy_set_header Host assaynovalabs\.com/); assert.match(https, /client_max_body_size 1m/); assert.match(https, /proxy_read_timeout 75s/);
  assert.match(installer, /sha256sum --check --status/); assert.match(installer, /nginx -t/); assert.doesNotMatch(installer, /curl[^\n]*\|\s*(?:bash|sh)|apt-get (?:upgrade|dist-upgrade)|--insecure|--nginx|certbot renew/);
  assert.equal(await read('requirements.txt'), 'Pillow==13.0.0\nreportlab==4.4.9\n');
});

test('installer manifest validation executes against synthetic artifacts and rejects forbidden files before opening them',async t=>{
 const f=await fixture(t),stage=path.join(f.root,'staged'),release=path.join(stage,'release');await fs.mkdir(release,{recursive:true});await exportDemoCatalog({...f.options,output:path.join(stage,'catalog')});
 const files=[];for(const name of ['server.mjs','report-pdf.mjs','package.json']){const raw=Buffer.from('{}');await fs.writeFile(path.join(release,name),raw);files.push({path:name,bytes:raw.length,sha256:hash(raw)});}const commit='1'.repeat(40),manifest={commit,files};await fs.writeFile(path.join(release,'release-manifest.json'),JSON.stringify(manifest));
 const installer=await fs.readFile(new URL('../deploy/demo/install.sh',import.meta.url),'utf8'),code=installer.match(/python3 - "\$staging" "\$commit" <<'PY'\n([\s\S]*?)\nPY/)[1],python=process.platform==='win32'?PYTHON:'python3';
 const run=()=>spawnSync(python,['-B','-c',code,stage,commit],{encoding:'utf8',windowsHide:true});assert.equal(run().status,0);
 manifest.files.push({path:'work/admin-auth/credential.json',bytes:1,sha256:'0'.repeat(64)});await fs.writeFile(path.join(release,'release-manifest.json'),JSON.stringify(manifest));const denied=run();assert.notEqual(denied.status,0);assert.match(denied.stderr,/manifest rejected/i);assert.doesNotMatch(denied.stderr,/Traceback/);
 manifest.files.pop();manifest.files[0].sha256='0'.repeat(64);await fs.writeFile(path.join(release,'release-manifest.json'),JSON.stringify(manifest));assert.notEqual(run().status,0);
});

test('export CLI rejects missing and duplicate flags without accessing a source or creating output',async t=>{
 const f=await fixture(t);const script=new URL('../scripts/export-demo-catalog.mjs',import.meta.url);for(const args of [[],['--source-store='+f.sourceStore,'--source-store='+f.sourceStore],['--source-store='+f.sourceStore,'--unknown=value']]){const result=spawnSync(process.execPath,[script.pathname.replace(/^\/([A-Za-z]:)/,'$1'),...args],{encoding:'utf8',windowsHide:true});assert.notEqual(result.status,0);assert.equal(result.stdout,'');assert.match(result.stderr,/Catalog export failed/);await assert.rejects(fs.access(f.options.output),{code:'ENOENT'});}
});
