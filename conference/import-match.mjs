import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseProduct, catalogDTO } from './catalog.mjs';
import { normalizeProductQuery } from './product-search.mjs';

export const codeKey = value => normalizeProductQuery(value).replace(/[\s-]/g, '');
const knownFullNames = new Map(JSON.parse(readFileSync(new URL('./product-aliases.json', import.meta.url), 'utf8')).map(row => [codeKey(row.canonicalName), row.canonicalName]));
export const revisionId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const productId = name => createHash('sha256').update(name).digest('hex').slice(0, 20);
const problem = message => Object.assign(new Error(message), { status: 400 });
export function safeCode(value) {
  if (typeof value !== 'string') throw problem('Use a safe short code for each image and SKU.');
  const code = value.normalize('NFKC').trim();
  if (!/^[a-z0-9][a-z0-9 _+()-]{0,63}$/i.test(code) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(code)) throw problem('Use a safe short code for each image and SKU.');
  return code;
}
const synonyms = new Map(Object.entries({ bpc157: 'BPC-157', tb500: 'TB-500', ghkcu: 'GHK-Cu', ahkcu: 'AHK-Cu', ll37: 'LL-37', aod9604: 'AOD-9604', ara290: 'ARA-290', igf1lr3: 'IGF-1 LR3', snap8: 'SNAP-8', cagriliintide: 'Cagrilintide', 'hgh191aa(somatropin)': 'HGH Somatropin' }));
function doseValue(value) {
  const match = /^(\d+(?:\.\d+)?)\s*(mg|ml|iu)(?:\s*[*x×]\s*\d+\s*(?:vials?|支|瓶))?$/i.exec(value.trim());
  if (!match || Number(match[1]) < 0.01 || Number(match[1]) > 100000) throw problem('Use a full product name with its per-vial dose and unit.');
  return { nominal: Number(match[1]), unit: match[2].toLowerCase() === 'iu' ? 'IU' : match[2].toLowerCase() };
}
export function productIdentity(value, dose = '', existing = []) {
  if (typeof value !== 'string' || value.length > 256 || /[^\x20-\x7e\u2010-\u2015\u2212]/.test(value)) throw problem('Use a full product name with its per-vial dose and unit.');
  let source = value.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g, '-').trim().replace(/\s+/g, ' ');
  const matches = existing.filter(row => codeKey(row.name) === codeKey(source));
  if (matches.length > 1) throw problem('More than one existing product has that full identity.');
  const exact = matches[0];
  if (exact) source = exact.name;
  else if (knownFullNames.has(codeKey(source))) source = knownFullNames.get(codeKey(source));
  source = source.replace(/(mg|ml|iu)\s*\+\s*(?=\S)/gi, '$1 + ');
  let parts = source.split(/\s+\+\s+/);
  if (parts.length === 1 && !/\d\s*(?:mg|ml|iu)$/i.test(source)) {
    if (!dose) throw problem('Use a full product name with its per-vial dose and unit.');
    const amount = doseValue(dose); source += ' ' + amount.nominal + amount.unit; parts = [source];
  }
  const normalized = parts.map(part => {
    const known = [...synonyms].sort(([a], [b]) => b.length - a.length).find(([key]) => codeKey(part).startsWith(key) && /^\d+(?:\.\d+)?(?:mg|ml|iu)$/i.test(codeKey(part).slice(key.length)));
    if (known) part = known[1] + ' ' + codeKey(part).slice(known[0].length);
    const match = /^(.+?)\s+(\d+(?:\.\d+)?)\s*(mg|ml|iu)$/i.exec(part);
    if (!match) throw problem('Use a full product name with its per-vial dose and unit.');
    let name = synonyms.get(codeKey(match[1])) || match[1].trim();
    if (/^(?:klow|glow)$/i.test(name)) {
      name = name.toUpperCase();
      if (match[3].toLowerCase() !== 'mg' || Number(match[2]) !== (name === 'KLOW' ? 80 : 70)) throw problem('Use the defined full blend name and dose.');
    }
    if (name.includes('+') && codeKey(name) !== 'nad+') throw problem('Use explicit names and doses for every blend component.');
    return name + ' ' + Number(match[2]) + (match[3].toLowerCase() === 'iu' ? 'IU' : match[3].toLowerCase());
  }).join(' + ');
  const parsed = parseProduct(normalized);
  if (normalized.length > 160 || parsed.components.some(row => !row.name || row.name.length > 100 || row.nominal < 0.01 || row.nominal > 100000 || !['mg', 'ml', 'IU'].includes(row.unit)) || new Set(parsed.components.map(row => row.name.toLowerCase())).size !== parsed.components.length) throw problem('Use a full product name with its per-vial dose and unit.');
  if (dose) {
    const amount = doseValue(dose);
    if (parsed.components.some(row => row.unit !== amount.unit) || Math.abs(parsed.components.reduce((sum, row) => sum + row.nominal, 0) - amount.nominal) > 1e-8) throw problem('The product name and Dose column disagree.');
  }
  const canonical = existing.find(row => codeKey(row.name) === codeKey(normalized));
  const name = canonical?.name || knownFullNames.get(codeKey(normalized)) || normalized;
  return { id: productId(name), name, ...parseProduct(name) };
}

export function previewIndex(sourceRows, pictures, existing = [], folder = false) {
  const rows = sourceRows.map(row => ({ row: row.row, sku: String(row.sku || '').slice(0, 64), product: String(row.product || '').slice(0, 256), status: 'unmatched', reason: '', identity: null }));
  const index = new Map(), blocked = new Set();
  rows.forEach((row, position) => {
    try {
      if (sourceRows[position].error) throw problem(sourceRows[position].error);
      row.sku = safeCode(sourceRows[position].sku);
      row.identity = productIdentity(sourceRows[position].product, sourceRows[position].dose || '', existing);
      const key = codeKey(row.sku), previous = index.get(key);
      if (previous && codeKey(previous.identity.name) !== codeKey(row.identity.name)) blocked.add(key);
      else if (!previous) index.set(key, row);
    } catch (error) { row.reason = error.message; }
  });
  const imageRows = [], images = new Map(); let blocking = false;
  for (const picture of pictures) {
    const record = { path: picture.name, status: 'unmatched', reason: 'No matching short-code row.' }; imageRows.push(record);
    try {
      const basename = picture.name.split('/').at(-1).replace(/\.(?:png|jpe?g|webp)$/i, '');
      let code = safeCode(basename);
      if (!index.has(codeKey(code)) && / \(\d+\)$/.test(basename)) code = safeCode(basename.replace(/ \(\d+\)$/, ''));
      const key = codeKey(code), prior = images.get(key);
      if (prior && prior.sha256 !== picture.sha256) { blocked.add(key); record.status = 'conflict'; record.reason = 'Different images have the same normalized short code.'; blocking = true; }
      else if (!prior) images.set(key, { ...picture, code, record });
      else { record.status = 'duplicate'; record.reason = 'Identical image duplicate.'; }
    } catch (error) { record.status = 'conflict'; record.reason = error.message; blocking = true; }
  }
  const groups = new Map();
  for (const row of rows) if (row.identity && !blocked.has(codeKey(row.sku))) {
    const key = codeKey(row.identity.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const products = folder ? [] : existing.slice(), aliases = [], seenCodes = new Set();
  for (const group of groups.values()) {
    let product = existing.find(item => codeKey(item.name) === codeKey(group[0].identity.name));
    if (folder) {
      const candidates = group.map(row => images.get(codeKey(row.sku))).filter(Boolean);
      if (!candidates.length) { for (const row of group) row.reason = 'No short-code picture for this product.'; continue; }
      if (new Set(candidates.map(item => item.sha256)).size > 1) {
        blocking = true;
        for (const row of group) { row.status = 'conflict'; row.reason = 'Different pictures resolve to the same full product.'; }
        for (const image of candidates) { image.record.status = 'conflict'; image.record.reason = 'Different pictures resolve to the same full product.'; }
        continue;
      }
      const image = candidates[0]; product = { ...group[0].identity, imageCode: image.code, imageFile: image.code + '.png', sha256: image.sha256, preparedFile: image.file };
      products.push(product);
      for (const image of candidates) { image.record.status = 'valid'; image.record.reason = ''; }
    }
    if (!product) { for (const row of group) row.reason = 'No exact full product and dose in this customer catalog.'; continue; }
    for (const row of group) {
      const key = codeKey(row.sku);
      row.product = product.name;
      if (seenCodes.has(key)) { row.status = 'duplicate'; row.reason = 'Same short code and product already included.'; continue; }
      seenCodes.add(key); row.status = 'valid'; row.reason = '';
      aliases.push({ sku: row.sku, productId: product.id });
    }
  }
  for (const row of rows) if (blocked.has(codeKey(row.sku))) { row.status = 'conflict'; row.reason = 'Short code has conflicting products or pictures.'; }
  const counts = { total: rows.length, valid: 0, unmatched: 0, conflict: 0, duplicate: 0, images: imageRows.length };
  counts.unmatchedImages = imageRows.filter(row => row.status === 'unmatched').length;
  for (const row of rows) counts[row.status]++;
  return { rows: rows.map(({ identity, ...row }) => row), imageRows, counts, blocking, aliases, products };
}
export function savedRows(products) {
  return products.flatMap(product => (product.importSkus ?? catalogDTO(product).aliases.skus).map(sku => ({ row: 0, sku, product: product.name })));
}
async function jsonFile(filename, limit) {
  const actual = await realpath(filename); if (path.dirname(actual) !== path.dirname(filename)) throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
  const info = await stat(filename); if (!info.isFile() || info.size > limit || info.size < 1) throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
  return JSON.parse(await readFile(filename, 'utf8'));
}
async function revisionFolder(store, id) {
  if (!revisionId(id)) throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
  const base = await realpath(store), imports = await realpath(path.join(base, 'customer-imports')), root = await realpath(path.join(imports, 'revisions')), folder = await realpath(path.join(root, id));
  if (path.dirname(imports) !== base || path.basename(imports) !== 'customer-imports' || path.dirname(root) !== imports || path.basename(root) !== 'revisions') throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
  if (path.dirname(folder) !== root || path.basename(folder) !== id) throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
  return folder;
}
export async function loadImportedAliases(store, id, products) {
  const folder = await revisionFolder(store, id), data = await jsonFile(path.join(folder, 'aliases.json'), 2 * 1024 * 1024), used = new Set();
  if (data.version !== 1 || Object.keys(data).sort().join(',') !== 'aliases,version' || !Array.isArray(data.aliases) || !data.aliases.length || data.aliases.length > 10000) throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
  for (const row of data.aliases) {
    if (!row || Object.keys(row).sort().join(',') !== 'productId,sku' || safeCode(row.sku) !== row.sku || used.has(codeKey(row.sku)) || !products.some(product => product.id === row.productId)) throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
    used.add(codeKey(row.sku));
  }
  return products.map(product => ({ ...product, importSkus: data.aliases.filter(row => row.productId === product.id).map(row => row.sku) }));
}
export async function loadManagedCatalog(store, id) {
  const folder = await revisionFolder(store, id), data = await jsonFile(path.join(folder, 'catalog.json'), 2 * 1024 * 1024);
  if (data.version !== 1 || Object.keys(data).sort().join(',') !== 'products,version' || !Array.isArray(data.products) || !data.products.length || data.products.length > 500) throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
  const root = await realpath(path.join(folder, 'images')), ids = new Set(), codes = new Set(), products = [];
  if (path.dirname(root) !== folder || path.basename(root) !== 'images') throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
  for (const row of data.products) {
    if (!row || Object.keys(row).sort().join(',') !== 'id,imageCode,imageFile,name,sha256' || row.id !== productId(row.name) || ids.has(row.id) || safeCode(row.imageCode) !== row.imageCode || codes.has(codeKey(row.imageCode)) || row.imageFile !== row.imageCode + '.png' || !/^[a-f0-9]{64}$/.test(row.sha256)) throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
    const identity = productIdentity(row.name);
    if (identity.id !== row.id || identity.name !== row.name) throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
    const imagePath = await realpath(path.join(root, row.imageFile)), info = await stat(imagePath);
    if (path.dirname(imagePath) !== root || !info.isFile() || info.size > 8 * 1024 * 1024 || createHash('sha256').update(await readFile(imagePath)).digest('hex') !== row.sha256) throw problem('Imported catalog data is unavailable. Upload a replacement to repair it.');
    ids.add(row.id); codes.add(codeKey(row.imageCode)); products.push({ id: row.id, name: row.name, ...productIdentity(row.name), imagePath });
  }
  return { directory: root, products };
}
