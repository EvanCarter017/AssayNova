import { randomBytes, createHash } from 'node:crypto';
import { mkdir, lstat, realpath, readFile, open, copyFile, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { productIdentity, codeKey } from './import-match.mjs';
import { catalogDTO } from './catalog.mjs';
import { filterProducts } from './product-search.mjs';

const failure = () => Object.assign(new Error('Saved catalog records are unavailable.'), { status: 503 });
export const recordProblem = (status, message) => Object.assign(new Error(message), { status });
export const entryId = value => typeof value === 'string' && /^[a-f0-9]{20}$/.test(value);
export const assetId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const text = (value, limit = 2048) => typeof value === 'string' && value.length <= limit && !/[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''));
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => plain(value) && Object.keys(value).every(key => names.includes(key));
const fields = value => keys(value, ['sku', 'product', 'dose']) && Object.keys(value).length === 3 && ['sku', 'product', 'dose'].every(key => text(value[key]));
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const sourceIssues = new Map([
  ['Formula in a selected identity column.', 'SOURCE_FORMULA'],
  ['Ambiguous merged identity cells.', 'SOURCE_MERGE'],
  ['Missing SKU or Product.', 'SOURCE_MISSING_IDENTITY']
]);
const revisionCache = new Map();
const signature = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
async function verifiedBytes(filename, expectedHash, verifiedFiles) {
  const info = await lstat(filename, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw failure();
  const stamp = signature(info), prior = verifiedFiles.get(filename);
  if (prior?.stamp === stamp && prior.sha256 === expectedHash) return Number(info.size);
  if (hash(await readFile(filename)) !== expectedHash) throw failure();
  verifiedFiles.set(filename, { stamp, sha256: expectedHash });
  return Number(info.size);
}
function cacheRevision(key, value) {
  revisionCache.delete(key); revisionCache.set(key, value);
  let bytes = [...revisionCache.values()].reduce((sum, item) => sum + item.bytes, 0);
  while (revisionCache.size > 8 || bytes > 64 * 1024 * 1024) {
    const oldest = revisionCache.keys().next().value;
    bytes -= revisionCache.get(oldest).bytes; revisionCache.delete(oldest);
  }
}
const messages = Object.freeze({
  HELD: 'This entry is on hold and cannot be selected.', MISSING_SKU: 'Enter a short code for this entry.',
  INVALID_SKU: 'Use a short code of 1 to 64 printable characters.', INVALID_IDENTITY: 'Check the full product name and per-vial dose.',
  MISSING_IMAGE: 'Choose or upload a product image.', IMAGE_CONFLICT: 'Choose which uploaded picture belongs to this entry.',
  DUPLICATE_SKU: 'This short code is used by another active entry. Edit it or hold a duplicate.',
  SEARCH_COLLISION: 'This short code collides with another entry in exact dose search.',
  SOURCE_FORMULA: 'A selected source cell contains a formula. Enter and save literal identity details.',
  SOURCE_MERGE: 'A source merge is ambiguous. Enter and save the correct identity details.',
  SOURCE_MISSING_IDENTITY: 'The source row has missing identity details. Review and save them.'
});

export function skuText(value) {
  if (!text(value) || !value.trim()) return null;
  const normalized = value.normalize('NFKC').trim();
  return normalized.length <= 64 && !/[^\x20-\x7e]/.test(normalized) ? normalized : null;
}
export function makeEntries(rows, images, { jobId, sheet = '', existingEntries = [] } = {}) {
  if (!Array.isArray(rows) || rows.length > 10000) throw recordProblem(400, 'Choose a table with at most 10000 product rows.');
  const used = new Set(existingEntries.map(entry => entry.id));
  return rows.map((row, index) => {
    const raw = { sku: String(row.sku ?? ''), product: String(row.product ?? ''), dose: String(row.dose ?? '') };
    if (!fields(raw)) throw recordProblem(400, 'A selected identity cell exceeds its supported size.');
    const source = { sheet: String(sheet), row: Number.isSafeInteger(row.row) ? row.row : index + 1 };
    const id = hash(String(jobId) + '\0' + sheet + '\0' + source.row + '\0' + index).slice(0, 20);
    if (used.has(id)) throw failure(); used.add(id);
    const code = skuText(raw.sku), candidates = code ? images.filter(image => {
      const basename = path.basename(image.filename.replace(/\\/g, '/')).replace(/\.(?:png|jpe?g|webp)$/i, '');
      return codeKey(basename) === codeKey(code) || codeKey(basename.replace(/ \(\d+\)$/, '')) === codeKey(code);
    }) : [];
    const unique = new Set(candidates.map(image => image.sha256));
    return { id, source, raw, values: { ...raw }, hold: false, imageId: unique.size === 1 ? candidates[0].id : null,
      imageConflict: unique.size > 1, sourceIssue: sourceIssues.get(row.error) || (row.error ? 'SOURCE_MERGE' : null), reviewed: false };
  });
}

export function validateRecords(value) {
  if (!keys(value, ['version', 'entries', 'images', 'origin']) || value.version !== 2 || !Array.isArray(value.entries) || value.entries.length > 10000 || !Array.isArray(value.images) || value.images.length > 500 || !keys(value.origin, ['importId', 'previewId', 'customerId', 'correctionId']) || !assetId(value.origin.importId) || !assetId(value.origin.previewId) || !entryId(value.origin.customerId) || (Object.hasOwn(value.origin, 'correctionId') && !/^[a-f0-9]{64}$/.test(value.origin.correctionId))) throw failure();
  const ids = new Set(), imageIds = new Set(); let bytes = 0;
  for (const image of value.images) {
    if (!keys(image, ['id', 'filename', 'sha256', 'bytes']) || Object.keys(image).length !== 4 || !assetId(image.id) || imageIds.has(image.id) || !text(image.filename, 512) || !image.filename || /[\x00-\x1f\x7f]/.test(image.filename) || !/^[a-f0-9]{64}$/.test(image.sha256) || !Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > 8 * 1024 * 1024) throw failure();
    bytes += image.bytes; imageIds.add(image.id);
  }
  if (bytes > 512 * 1024 * 1024) throw recordProblem(400, 'The saved image pool exceeds 512 MiB.');
  for (const entry of value.entries) {
    if (!keys(entry, ['id', 'source', 'raw', 'values', 'hold', 'imageId', 'imageConflict', 'sourceIssue', 'reviewed']) || Object.keys(entry).length !== 9 || !entryId(entry.id) || ids.has(entry.id) || !keys(entry.source, ['sheet', 'row']) || Object.keys(entry.source).length !== 2 || !text(entry.source.sheet, 128) || !Number.isSafeInteger(entry.source.row) || entry.source.row < 0 || entry.source.row > 10000 || !fields(entry.raw) || !fields(entry.values) || typeof entry.hold !== 'boolean' || typeof entry.reviewed !== 'boolean' || typeof entry.imageConflict !== 'boolean' || (entry.sourceIssue !== null && !Object.values(Object.fromEntries(sourceIssues)).includes(entry.sourceIssue)) || (entry.imageId !== null && !imageIds.has(entry.imageId))) throw failure();
    ids.add(entry.id);
  }
  return value;
}

export function evaluateRecords(value) {
  validateRecords(value);
  const results = value.entries.map(entry => {
    const issues = [], sku = skuText(entry.values.sku); let identity = null;
    const add = code => { if (!issues.some(issue => issue.code === code)) issues.push({ code, message: messages[code] }); };
    if (entry.hold) add('HELD');
    if (!entry.values.sku.trim()) add('MISSING_SKU'); else if (!sku) add('INVALID_SKU');
    if (entry.sourceIssue && !entry.reviewed) add(entry.sourceIssue);
    try { identity = productIdentity(entry.values.product, entry.values.dose); } catch { add('INVALID_IDENTITY'); }
    if (!entry.imageId) add(entry.imageConflict ? 'IMAGE_CONFLICT' : 'MISSING_IMAGE');
    return { entry, sku, identity, issues, add };
  });
  const claims = new Map();
  for (const result of results) if (!result.entry.hold && result.sku) { const key = codeKey(result.sku); if (!claims.has(key)) claims.set(key, []); claims.get(key).push(result); }
  for (const group of claims.values()) if (group.length > 1) for (const result of group) result.add('DUPLICATE_SKU');
  // Blocked literal short codes also own their exact spelling. Never synthesize
  // a ready product's unit-qualified code over a retained unresolved claim.
  for (const result of results) if (!result.entry.hold && result.sku && result.identity) {
    const probe = { ...result.identity, name: '', aliases: { skus: [result.sku], names: [], families: [] } };
    const units = new Set(result.identity.components.map(component => component.unit));
    if (units.size === 1) {
      const key = codeKey(result.sku) + codeKey([...units][0]), owners = claims.get(key);
      if (owners && filterProducts([probe], key).length) for (const other of owners) if (other.entry.id !== result.entry.id) { result.add('SEARCH_COLLISION'); other.add('SEARCH_COLLISION'); }
    }
  }
  const entries = results.map(({ entry, issues }) => ({ ...entry, status: issues.length ? 'blocked' : 'ready', issues }));
  const products = results.filter(result => !result.issues.length).map(({ entry, identity, sku }) => {
    const legacy = catalogDTO(identity);
    return { ...identity, id: entry.id, sku, status: 'ready', imageId: entry.imageId,
      aliases: { skus: [sku], names: legacy.aliases.names, families: legacy.aliases.families } };
  });
  return { entries, products, counts: { total: entries.length, ready: products.length, blocked: entries.length - products.length } };
}

export function recordsDTO(catalog) {
  const customerId = catalog.customer.id, images = new Map(catalog.records.images.map(image => [image.id, image]));
  const url = id => '/admin/catalog-assets/' + customerId + '/' + id;
  return { catalogRevision: catalog.customer.catalogRevision, counts: catalog.counts,
    entries: catalog.entries.map(entry => ({ id: entry.id, source: { ...entry.source }, raw: { ...entry.raw }, values: { ...entry.values }, hold: entry.hold,
      status: entry.status, issues: entry.issues.map(issue => ({ ...issue })), image: entry.imageId ? { id: entry.imageId, url: url(entry.imageId), filename: images.get(entry.imageId).filename } : null })),
    products: catalog.products.map(product => ({ id: product.id, sku: product.sku, status: 'ready', name: product.name, components: product.components, unit: product.unit,
      aliases: product.aliases, imageURL: '/admin/images/' + customerId + '/' + product.id })) };
}

export function applyCorrection(records, id, input) {
  if (!keys(input, ['expectedRevision', 'changes', 'image']) || !assetId(input.expectedRevision) || !keys(input.changes, ['sku', 'product', 'dose', 'hold']) || !Object.keys(input.changes).length && !Object.hasOwn(input, 'image')) throw recordProblem(400, 'Supply correction fields and the current catalog revision.');
  const copy = structuredClone(records), entry = copy.entries.find(entry => entry.id === id);
  if (!entry) throw recordProblem(404, 'Catalog entry is unavailable.');
  for (const field of ['sku', 'product', 'dose']) if (Object.hasOwn(input.changes, field)) {
    if (!text(input.changes[field])) throw recordProblem(400, 'Correction text exceeds its supported size.');
    entry.values[field] = input.changes[field];
  }
  if (['sku', 'product', 'dose'].every(field => Object.hasOwn(input.changes, field))) entry.reviewed = true;
  if (Object.hasOwn(input.changes, 'hold')) { if (typeof input.changes.hold !== 'boolean') throw recordProblem(400, 'Choose whether this entry is on hold.'); entry.hold = input.changes.hold; }
  if (Object.hasOwn(input, 'image')) {
    if (input.image !== null && (!keys(input.image, ['assetId']) || Object.keys(input.image).length !== 1 || !copy.images.some(image => image.id === input.image.assetId))) throw recordProblem(400, 'Choose a saved picture from this customer.');
    entry.imageId = input.image?.assetId ?? null; entry.imageConflict = false;
  }
  evaluateRecords(copy); return copy;
}

async function noRedirects(filename) {
  for (let current = path.resolve(filename); ; current = path.dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw failure(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}
export async function catalogRevisionFolder(store, revision) {
  if (!assetId(revision)) throw failure();
  const base = await realpath(store), imports = await realpath(path.join(base, 'customer-imports')), root = await realpath(path.join(imports, 'revisions')), folder = path.join(root, revision);
  await noRedirects(folder);
  const actual = await realpath(folder);
  if (!same(path.dirname(imports), base) || !same(path.dirname(root), imports) || !same(path.dirname(actual), root) || path.basename(actual) !== revision) throw failure();
  return actual;
}
export async function readCatalogRecords(store, revision) {
  try {
    const folder = await catalogRevisionFolder(store, revision), file = path.join(folder, 'records.json'); await noRedirects(file);
    const info = await lstat(file, { bigint: true }); if (!info.isFile() || info.size < 1n || info.size > 64n * 1024n * 1024n) throw failure();
    const stamp = signature(info), prior = revisionCache.get(folder);
    const cached = prior?.stamp === stamp ? prior : { stamp, bytes: Number(info.size), records: validateRecords(JSON.parse(await readFile(file, 'utf8'))), verifiedFiles: new Map() };
    const records = structuredClone(cached.records), sources = [];
    const imageFolder = path.join(folder, 'images'); await noRedirects(imageFolder);
    const root = await realpath(imageFolder); if (!same(path.dirname(root), folder)) throw failure();
    for (const image of records.images) {
      const filename = path.join(root, image.id + '.png'); await noRedirects(filename);
      const imageInfo = await lstat(filename), actual = await realpath(filename);
      if (!imageInfo.isFile() || !same(path.dirname(actual), root) || imageInfo.size !== image.bytes || await verifiedBytes(actual, image.sha256, cached.verifiedFiles) !== image.bytes) throw failure();
      sources.push({ ...image, path: actual, immutable: true });
    }
    cacheRevision(folder, cached);
    const evaluated = evaluateRecords(records), byId = new Map(sources.map(image => [image.id, image]));
    return { records, sources, ...evaluated, products: evaluated.products.map(product => ({ ...product, imagePath: byId.get(product.imageId).path })) };
  } catch (error) { if (error.status) throw error; throw failure(); }
}
export async function writeCatalogRecords(store, revision, records, sources) {
  validateRecords(records);
  if (!assetId(revision)) throw failure();
  const root = path.join(path.resolve(store), 'customer-imports', 'revisions'); await noRedirects(root); await mkdir(root, { recursive: true });
  const parent = await realpath(root), folder = path.join(parent, revision); await mkdir(folder); await mkdir(path.join(folder, 'images'));
  for (const image of records.images) {
    const source = sources.find(source => source.id === image.id); if (!source) throw failure();
    await noRedirects(source.path); const actual = await realpath(source.path), info = await lstat(actual);
    if (!info.isFile() || info.size !== image.bytes || hash(await readFile(actual)) !== image.sha256) throw failure();
    const destination = path.join(folder, 'images', image.id + '.png');
    if (source.immutable) { try { await link(actual, destination); } catch (error) { if (!['EXDEV', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error; await copyFile(actual, destination, constants.COPYFILE_EXCL); } }
    else await copyFile(actual, destination, constants.COPYFILE_EXCL);
    const copied = await open(destination, 'r+'); try { await copied.sync(); } finally { await copied.close(); }
  }
  const file = await open(path.join(folder, 'records.json'), 'wx', 0o600); try { await file.writeFile(JSON.stringify(records)); await file.sync(); } finally { await file.close(); }
  return readCatalogRecords(store, revision);
}

export async function legacyRecords(catalog, origin) {
  const images = [], sources = [], entries = [];
  for (const product of catalog.products) {
    const bytes = await readFile(product.imagePath), sha256 = hash(bytes), id = sha256.slice(0, 32);
    if (!images.some(image => image.id === id)) { const image = { id, filename: path.basename(product.imagePath), sha256, bytes: bytes.length }; images.push(image); sources.push({ ...image, path: product.imagePath, immutable: false }); }
    const skus = product.importSkus?.length ? product.importSkus : catalogDTO(product).aliases.skus.length ? catalogDTO(product).aliases.skus : [product.name];
    for (const sku of skus) {
      const raw = { sku, product: product.name, dose: '' };
      entries.push({ id: randomBytes(10).toString('hex'), source: { sheet: '', row: 0 }, raw, values: { ...raw }, hold: false, imageId: id, imageConflict: false, sourceIssue: null, reviewed: false });
    }
  }
  return { records: { version: 2, entries, images, origin }, sources };
}
