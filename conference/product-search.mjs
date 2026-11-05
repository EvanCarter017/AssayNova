// Pure private-catalog search shared by the browser and Node tests. Alias data
// arrive through the admin DTO; this module never loads the quote workbook.
export function normalizeProductQuery(value) {
  return typeof value === 'string' ? value.normalize('NFKC').toLowerCase().trim()
    .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s+/g, ' ')
    .replace(/\s*\+\s*/g, '+').replace(/\s*-\s*/g, '-') : '';
}
const key = value => normalizeProductQuery(value).replace(/[\s-]/g, '');
const aliases = (product, field) => Array.isArray(product?.aliases?.[field]) ? product.aliases[field] : [];
function fullNames(product) {
  const parts = Array.isArray(product.components) ? product.components : [];
  if (!parts.length || new Set(parts.map(row => row.unit)).size !== 1) return [product.name];
  const dose = parts.reduce((sum, row) => sum + row.nominal, 0) + parts[0].unit;
  return [product.name, ...aliases(product, 'names').map(name => name + ' ' + dose)];
}
function exactNameDose(product, query) {
  // Preserve name + dose searches without requiring units. Quote-family codes
  // are deliberately absent here, so a photo's TR 5mg variant invents no TR5 SKU.
  if (fullNames(product).some(name => key(name).replace(/(?:mg|ml|iu)$/, '') === query)) return true;
  const canonical = key(product.name);
  return (product.components ?? []).some(row => canonical.includes(key(row.name + row.nominal + row.unit)) && key(row.name + row.nominal) === query);
}

function unitSKU(product, sku, query) {
  const parts = Array.isArray(product.components) ? product.components : [];
  const dose = /(\d+(?:\.\d+)?)(k)?$/i.exec(sku);
  if (!parts.length || !dose || !/[a-z]/i.test(sku.slice(0, dose.index)) || new Set(parts.map(row => row.unit)).size !== 1) return false;
  const nominal = parts.reduce((sum, row) => sum + row.nominal, 0);
  if (Number(dose[1]) * (dose[2] ? 1000 : 1) !== nominal) return false;
  return query === key(sku) + key(parts[0].unit);
}
function textContains(text, query, knownName) {
  const haystack = key(text);
  let position = haystack.indexOf(query);
  while (position !== -1) {
    // A dose of 2 must not find 20. Intrinsic chemical identifiers such as
    // BPC157 and IGF1LR3 remain valid bare-name searches.
    const next = haystack[position + query.length];
    if (knownName || !/\d$/.test(query) || !next || !/[\d.]/.test(next)) return true;
    position = haystack.indexOf(query, position + 1);
  }
  return false;
}

export function filterProducts(products, value) {
  if (!Array.isArray(products) || typeof value !== 'string') return [];
  const query = key(value);
  if (!query) return products.slice();
  const exactSKU = products.filter(product => aliases(product, 'skus').some(sku => key(sku) === query || unitSKU(product, sku, query)));
  if (exactSKU.length) return exactSKU.length === 1 ? exactSKU : [];
  const family = products.filter(product => aliases(product, 'families').some(alias => key(alias) === query));
  if (family.length) return family;
  const fullName = products.filter(product => fullNames(product).some(name => key(name) === query));
  if (fullName.length) return fullName;
  const knownName = products.some(product => aliases(product, 'names').some(name => key(name) === query));
  if (knownName) return products.filter(product => aliases(product, 'names').some(name => key(name) === query) || (product.components ?? []).some(row => key(row.name) === query && key(product.name).includes(key(row.name + row.nominal + row.unit))));
  const nameDose = products.filter(product => exactNameDose(product, query));
  if (nameDose.length) return nameDose;
  // Unknown SKU-like inputs never fall back to a partial product/dose match.
  if (!knownName && (/^[a-z]{1,5}\d+[a-z]{0,3}$/.test(query) || /^\d+[a-z]{1,3}\d*$/.test(query) || /^\d+$/.test(query) || /^[a-z]$/.test(query))) return [];
  return products.filter(product => {
    const canonical = key(product.name);
    if (query.includes('dac') && query.includes('nodac') !== canonical.includes('nodac')) return false;
    return [...fullNames(product), ...aliases(product, 'names')].some(name => textContains(name, query, knownName));
  });
}

export function matchesProduct(product, query, products = [product]) {
  return filterProducts(products, query).includes(product);
}
