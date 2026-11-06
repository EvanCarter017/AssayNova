import { randomBytes, createHash } from 'node:crypto';
import { mkdir, open, realpath, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_IMAGES, loadCatalog } from './catalog.mjs';
import { revisionId, loadManagedCatalog, loadImportedAliases } from './import-match.mjs';
import { readCatalogRecords } from './catalog-records.mjs';

export const validCustomerId = value => typeof value === 'string' && /^[a-f0-9]{20}$/.test(value);
export const customerFingerprint = row => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
const problem = (status, message) => Object.assign(new Error(message), { status });
const unavailable = () => problem(503, 'Saved customer configuration is unavailable.');
const directoryError = () => problem(400, 'Customer directory could not be read. Check the saved server directory and reload products.');
function nameValue(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64 || /[^\x20-\x7e]/.test(value)) throw problem(400, 'Use a customer name with 1 to 64 printable ASCII characters.');
  return value.trim();
}
function directoryValue(value) {
  if (typeof value !== 'string' || value.length > 1024 || !(path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)) || /[\x00-\x1f\x7f]/.test(value) || /^(?:[\\/]{2}|[a-z]+:\/\/)/i.test(value) || value.split(/[\\/]/).some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw problem(400, 'Use an absolute local directory on the server computer.');
  return value;
}

// Only the primary admin owns this registry. Report snapshots are never edited.
export async function createCustomerCatalog({ store, images = DEFAULT_IMAGES, replaceFile = rename } = {}) {
  const folder = path.join(path.resolve(store), 'customers'), filename = path.join(folder, 'profiles.json');
  await mkdir(folder, { recursive: true });
  let pending = Promise.resolve();
  async function read() {
    let file;
    try { file = await open(filename, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw unavailable(); }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > 65536) throw new Error();
      const bytes = Buffer.alloc(65537), result = await file.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead < 1 || result.bytesRead > 65536) throw new Error();
      const config = JSON.parse(bytes.subarray(0, result.bytesRead));
      if (!config || Object.keys(config).sort().join(',') !== 'customers,version' || config.version !== 1 || !Array.isArray(config.customers) || config.customers.length > 32) throw new Error();
      const ids = new Set(), names = new Set();
      for (const row of config.customers) {
        if (!row || !['id', 'name', 'directory'].every(key => Object.hasOwn(row, key)) || Object.keys(row).some(key => !['id', 'name', 'directory', 'imageRevision', 'aliasRevision', 'catalogRevision'].includes(key)) || ['imageRevision', 'aliasRevision', 'catalogRevision'].some(key => Object.hasOwn(row, key) && !revisionId(row[key])) || !validCustomerId(row.id) || ids.has(row.id) || nameValue(row.name) !== row.name || names.has(row.name.toLowerCase())) throw new Error();
        directoryValue(row.directory); ids.add(row.id); names.add(row.name.toLowerCase());
      }
      return config;
    } catch { throw unavailable(); }
    finally { await file.close(); }
  }
  async function scanDirectory(directory) {
    directoryValue(directory);
    try {
      const canonical = await realpath(directory);
      directoryValue(canonical);
      const products = await loadCatalog(canonical);
      if (!products.length) throw new Error();
      return { directory: canonical, products };
    } catch { throw directoryError(); }
  }
  async function write(config, initial = false) {
    const data = JSON.stringify(config);
    if (Buffer.byteLength(data) > 65536) throw problem(400, 'Customer configuration exceeds its size limit.');
    const temporary = path.join(folder, '.profiles-' + randomBytes(16).toString('hex') + '.tmp');
    let file;
    try {
      file = await open(temporary, 'wx', 0o600); await file.writeFile(data); await file.sync(); await file.close(); file = null;
      // link is exclusive: concurrent initializers cannot replace the first seed.
      if (initial) await link(temporary, filename); else await replaceFile(temporary, filename);
    } catch (error) { if (!(initial && error.code === 'EEXIST')) throw unavailable(); }
    finally { await file?.close(); await unlink(temporary).catch(() => {}); }
  }
  if (!await read()) {
    let directory = directoryValue(images);
    // An unavailable initial directory can be repaired after signing in.
    try { directory = (await scanDirectory(images)).directory; } catch {}
    await write({ version: 1, customers: [{ id: randomBytes(10).toString('hex'), name: path.resolve(images) === path.resolve(DEFAULT_IMAGES) ? 'VialCove' : 'Research Client', directory }] }, true);
  }
  const managedDirectory = id => path.join(path.resolve(store), 'customer-imports', 'revisions', id, 'images');
  const display = row => row.catalogRevision || row.imageRevision ? { ...row, directory: managedDirectory(row.catalogRevision || row.imageRevision) } : { ...row };
  async function records() { const config = await read(); if (!config) throw unavailable(); return config.customers; }
  async function list() { return (await records()).map(display); }
  async function snapshot(id) {
    const customer = (await records()).find(row => row.id === id);
    if (!validCustomerId(id) || !customer) throw problem(400, 'Choose a saved customer.');
    return { customer: display(customer), fingerprint: customerFingerprint(customer) };
  }
  async function scan(id) {
    const customer = (await records()).find(row => row.id === id);
    if (!validCustomerId(id) || !customer) throw problem(400, 'Choose a saved customer.');
    try {
      if (customer.catalogRevision) {
        const catalog = await readCatalogRecords(store, customer.catalogRevision);
        if (catalog.records.origin.customerId !== customer.id) throw unavailable();
        return { customer: display(customer), ...catalog };
      }
      let products = customer.imageRevision ? (await loadManagedCatalog(store, customer.imageRevision)).products : (await scanDirectory(customer.directory)).products;
      if (customer.aliasRevision) products = await loadImportedAliases(store, customer.aliasRevision, products);
      return { customer: display(customer), products };
    } catch { throw directoryError(); }
  }
  function save(input) {
    const operation = pending.then(async () => {
      if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !['customerId', 'name', 'directory'].includes(key)) || (Object.hasOwn(input, 'customerId') && !validCustomerId(input.customerId))) throw problem(400, 'Supply only the saved customer, name and server directory.');
      const name = nameValue(input.name), directory = directoryValue(input.directory), customers = await records();
      const index = input.customerId === undefined ? -1 : customers.findIndex(row => row.id === input.customerId);
      if (input.customerId !== undefined && index < 0) throw problem(400, 'Choose a saved customer.');
      if (customers.some(row => row.id !== input.customerId && row.name.toLowerCase() === name.toLowerCase())) throw problem(400, 'A customer with that name already exists.');
      if (index < 0 && customers.length >= 32) throw problem(400, 'A maximum of 32 customers can be saved.');
      const previous = customers[index], sameDirectory = previous && path.resolve(directory) === path.resolve(display(previous).directory);
      const catalog = sameDirectory ? await scan(previous.id) : await scanDirectory(directory);
      const customer = sameDirectory ? { ...previous, name } : { id: input.customerId ?? randomBytes(10).toString('hex'), name, directory: catalog.directory };
      if (index < 0) customers.push(customer); else customers[index] = customer;
      await write({ version: 1, customers });
      return { ...catalog, customers: customers.map(display), customer: display(customer) };
    });
    pending = operation.catch(() => {}); return operation;
  }
  function activate(input) {
    const operation = pending.then(async () => {
      const customers = await records(), index = input.customerId ? customers.findIndex(row => row.id === input.customerId) : -1, previous = customers[index];
      if (input.customerId && (!previous || customerFingerprint(previous) !== input.fingerprint)) throw problem(409, 'Customer changed during import. Start a new import.');
      const name = nameValue(input.name ?? previous?.name);
      if (customers.some(row => row.id !== previous?.id && row.name.toLowerCase() === name.toLowerCase())) throw problem(409, 'A customer with that name already exists.');
      if (!previous && customers.length >= 32) throw problem(400, 'A maximum of 32 customers can be saved.');
      const imageRevision = input.imageRevision ?? previous?.imageRevision, aliasRevision = input.aliasRevision;
      if (!revisionId(aliasRevision) || (imageRevision !== undefined && !revisionId(imageRevision))) throw unavailable();
      let products = imageRevision ? (await loadManagedCatalog(store, imageRevision)).products : (await scanDirectory(previous.directory)).products;
      products = await loadImportedAliases(store, aliasRevision, products);
      const customer = { id: previous?.id ?? randomBytes(10).toString('hex'), name, directory: previous?.directory ?? managedDirectory(imageRevision), ...(imageRevision ? { imageRevision } : {}), aliasRevision };
      if (previous) customers[index] = customer; else customers.push(customer);
      await write({ version: 1, customers });
      return { customers: customers.map(display), customer: display(customer), products };
    });
    pending = operation.catch(() => {}); return operation;
  }
  function activateRecords(input) {
    const operation = pending.then(async () => {
      if (!validCustomerId(input.customerId) || !revisionId(input.catalogRevision)) throw unavailable();
      const customers = await records(), index = customers.findIndex(row => row.id === input.customerId), previous = customers[index];
      if (input.isNew ? previous : !previous || customerFingerprint(previous) !== input.fingerprint) throw problem(409, 'Catalog changed. Reload products before saving corrections.');
      const name = nameValue(input.name ?? previous?.name);
      if (customers.some(row => row.id !== input.customerId && row.name.toLowerCase() === name.toLowerCase())) throw problem(409, 'A customer with that name already exists.');
      if (!previous && customers.length >= 32) throw problem(400, 'A maximum of 32 customers can be saved.');
      const catalog = await readCatalogRecords(store, input.catalogRevision);
      if (catalog.records.origin.customerId !== input.customerId) throw unavailable();
      const customer = previous ? { ...previous, name, catalogRevision: input.catalogRevision } : { id: input.customerId, name, directory: managedDirectory(input.catalogRevision), catalogRevision: input.catalogRevision };
      if (previous) customers[index] = customer; else customers.push(customer);
      await write({ version: 1, customers });
      return { customers: customers.map(display), customer: display(customer), ...catalog };
    });
    pending = operation.catch(() => {}); return operation;
  }
  return { list, scan, save, snapshot, activate, activateRecords };
}
