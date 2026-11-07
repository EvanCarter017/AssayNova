import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadCatalog } from '../conference/catalog.mjs';
import { loadManagedCatalog, loadImportedAliases } from '../conference/import-match.mjs';
import { readCatalogRecords } from '../conference/catalog-records.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('Catalog export rejected; any partial output is retained.'); };
const within = (root, value) => { const relative = path.relative(root, value); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\x00-\x1f\x7f]/.test(value) || value.split(/[\\/]/).some(part => part === '..' || part === '.') || path.parse(value).root === value) fail();
  return path.resolve(value);
}
function linux(value) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(value)) fail();
  return value;
}
async function noLinks(filename, missing = false) {
  for (let current = filename; ; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) fail(); }
    catch (error) { if (!missing || error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}
async function bytes(filename, maximum) {
  await noLinks(filename);
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.size < 1 || info.size > maximum) fail();
  const raw = await fs.readFile(filename);
  if (raw.length !== info.size) fail();
  return raw;
}

// Explicit roots only. This never constructs the catalog/store writers and
// never enumerates the report store or follows import jobs, receipts or history.
export async function exportDemoCatalog({ sourceStore, imageRoot, targetStore, targetImages, output }) {
  sourceStore = absolute(sourceStore); imageRoot = absolute(imageRoot); output = absolute(output);
  targetStore = linux(targetStore); targetImages = linux(targetImages);
  if (targetStore === targetImages || targetStore.startsWith(targetImages + '/') || targetImages.startsWith(targetStore + '/')) fail();
  if ([sourceStore, imageRoot].some(root => within(root, output) || within(output, root))) fail();
  await noLinks(sourceStore); await noLinks(imageRoot); await noLinks(output, true);
  const profileRaw = await bytes(path.join(sourceStore, 'customers', 'profiles.json'), 65536);
  const config = JSON.parse(profileRaw);
  if (!config || Object.keys(config).sort().join(',') !== 'customers,version' || config.version !== 1 || !Array.isArray(config.customers) || config.customers.length > 32) fail();
  const ids = new Set(), names = new Set();
  for (const row of config.customers) {
    if (!row || Object.keys(row).some(key => !['id', 'name', 'directory', 'catalogRevision', 'imageRevision', 'aliasRevision'].includes(key)) || !/^[a-f0-9]{20}$/.test(row.id) || ids.has(row.id) || typeof row.name !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(row.name) || row.name.trim() !== row.name || names.has(row.name.toLowerCase()) || typeof row.directory !== 'string' || !(path.isAbsolute(row.directory) || /^[a-z]:[\\/]/i.test(row.directory)) || row.directory.length > 1024 || /^[\\/]{2}/.test(row.directory) || /[\x00-\x1f\x7f]/.test(row.directory) || row.directory.split(/[\\/]/).some(part => part === '..') || ['catalogRevision', 'imageRevision', 'aliasRevision'].some(key => Object.hasOwn(row, key) && !/^[a-f0-9]{32}$/.test(row[key]))) fail();
    ids.add(row.id); names.add(row.name.toLowerCase());
  }
  // Exclusive output creation. Failures leave evidence rather than deleting it.
  await fs.mkdir(output, { mode: 0o700 });
  const files = new Map(), revisions = new Set(), sourceHashes = new Map(); let images = 0;
  async function save(relative, raw) {
    if (files.has(relative)) { if (files.get(relative).sha256 !== digest(raw)) fail(); return; }
    if (!/^(?:store|images)\//.test(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) fail();
    const destination = path.join(output, ...relative.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, raw, { flag: 'wx', mode: 0o600 });
    files.set(relative, { path: relative, bytes: raw.length, sha256: digest(raw) });
  }
  async function copy(relative, source, maximum, expected) {
    const raw = await bytes(source, maximum);
    if (sourceHashes.has(source) && sourceHashes.get(source).sha256 !== digest(raw)) fail();
    sourceHashes.set(source, { maximum, sha256: digest(raw) });
    if (expected && digest(raw) !== expected) fail();
    await save(relative, raw);
  }
  const revisionPath = id => path.join(sourceStore, 'customer-imports', 'revisions', id);
  for (const row of config.customers) {
    if (row.catalogRevision) {
      const id = row.catalogRevision, folder = revisionPath(id);
      const recordRaw = await bytes(path.join(folder, 'records.json'), 64 * 1024 * 1024);
      const catalog = await readCatalogRecords(sourceStore, id);
      if (JSON.stringify(JSON.parse(recordRaw)) !== JSON.stringify(catalog.records)) fail();
      if (catalog.records.origin.customerId !== row.id) fail();
      await copy('store/customer-imports/revisions/' + id + '/records.json', path.join(folder, 'records.json'), 64 * 1024 * 1024, digest(recordRaw));
      for (const image of catalog.records.images) { await copy('store/customer-imports/revisions/' + id + '/images/' + image.id + '.png', path.join(folder, 'images', image.id + '.png'), 8 * 1024 * 1024, image.sha256); images++; }
      row.directory = targetStore + '/customer-imports/revisions/' + id + '/images'; revisions.add(id);
    } else {
      let products;
      if (row.imageRevision) {
        const id = row.imageRevision, folder = revisionPath(id), catalogRaw = await bytes(path.join(folder, 'catalog.json'), 2 * 1024 * 1024);
        products = (await loadManagedCatalog(sourceStore, id)).products;
        const catalog = JSON.parse(catalogRaw);
        await copy('store/customer-imports/revisions/' + id + '/catalog.json', path.join(folder, 'catalog.json'), 2 * 1024 * 1024, digest(catalogRaw));
        for (const item of catalog.products) { await copy('store/customer-imports/revisions/' + id + '/images/' + item.imageFile, path.join(folder, 'images', item.imageFile), 8 * 1024 * 1024, item.sha256); images++; }
        row.directory = targetStore + '/customer-imports/revisions/' + id + '/images'; revisions.add(id);
      } else {
        const directory = absolute(row.directory); await noLinks(directory);
        if (!within(imageRoot, directory)) fail();
        products = await loadCatalog(directory); if (!products.length) fail();
        for (const product of products) { await copy('images/' + row.id + '/' + path.basename(product.imagePath), product.imagePath, 8 * 1024 * 1024); images++; }
        row.directory = targetImages + '/' + row.id;
      }
      if (row.aliasRevision) {
        await loadImportedAliases(sourceStore, row.aliasRevision, products);
        await copy('store/customer-imports/revisions/' + row.aliasRevision + '/aliases.json', path.join(revisionPath(row.aliasRevision), 'aliases.json'), 2 * 1024 * 1024); revisions.add(row.aliasRevision);
      }
    }
  }
  await save('store/customers/profiles.json', Buffer.from(JSON.stringify(config)));
  // Detect a concurrent registry change before marking the export complete.
  if (!(await bytes(path.join(sourceStore, 'customers', 'profiles.json'), 65536)).equals(profileRaw)) fail();
  for (const [filename, snapshot] of sourceHashes) if (digest(await bytes(filename, snapshot.maximum)) !== snapshot.sha256) fail();
  const manifest = { version: 1, kind: 'assaynova-demo-catalog', targetStore, targetImages, counts: { customers: config.customers.length, revisions: revisions.size, images }, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  await fs.writeFile(path.join(output, 'catalog-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = {}, names = { 'source-store': 'sourceStore', 'image-root': 'imageRoot', 'target-store': 'targetStore', 'target-images': 'targetImages', output: 'output' };
    for (const arg of process.argv.slice(2)) { const match = /^--([a-z-]+)=(.+)$/.exec(arg); if (!match || !Object.hasOwn(names, match[1]) || Object.hasOwn(options, names[match[1]])) fail(); options[names[match[1]]] = match[2]; }
    if (Object.keys(options).length !== 5) fail();
    const result = await exportDemoCatalog(options); console.log(JSON.stringify({ ok: true, counts: result.counts, files: result.files.length }));
  } catch { console.error('Catalog export failed; inspect the supplied roots and retained output.'); process.exitCode = 1; }
}
