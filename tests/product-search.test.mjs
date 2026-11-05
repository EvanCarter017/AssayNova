import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { parseProduct, catalogDTO, loadCatalog, DEFAULT_IMAGES } from '../conference/catalog.mjs';
import { normalizeProductQuery, filterProducts, matchesProduct } from '../conference/product-search.mjs';

const data = JSON.parse(await readFile(new URL('../conference/product-aliases.json', import.meta.url), 'utf8'));
const products = [...data.map(row => row.canonicalName), 'Kisspeptin 10mg', 'Oxytocin 10mg'].map(name => {
  const product = catalogDTO({ id: createHash('sha256').update(name).digest('hex').slice(0, 20), name, ...parseProduct(name) });
  return { ...product, imageURL: '/admin' + product.imageURL };
});
const names = query => filterProducts(products, query).map(row => row.name).sort();

test('query normalization handles NFKC/case/spacing/dashes and preserves plus and identity variants', () => {
  assert.equal(normalizeProductQuery('  ＴＲ１０  '), 'tr10');
  assert.equal(normalizeProductQuery('BPC — 157'), 'bpc-157');
  assert.equal(normalizeProductQuery(' NAD ＋ '), 'nad+');
  assert.notEqual(normalizeProductQuery('CJC-1295 No DAC'), normalizeProductQuery('CJC-1295 with DAC'));
  assert.notEqual(normalizeProductQuery('Oxytocin Acetate'), normalizeProductQuery('Oxytocin'));
  assert.deepEqual(names(''), products.map(row => row.name).sort());
});

test('full quote SKUs are exact, including explicit numeric/standalone codes and actual units', () => {
  const expected = {
    TR10: 'Tirzepatide 10mg', 'tr 10': 'Tirzepatide 10mg', 'ＴＲ１０': 'Tirzepatide 10mg', TR10mg: 'Tirzepatide 10mg',
    SM10: 'Semaglutide 10mg', BC10: 'BPC-157 10mg', G5k: 'HCG 5000IU', G5kIU: 'HCG 5000IU', H24: 'HGH Somatropin 24IU',
    NJ500: 'NAD+ 500mg', KLOW80: 'KLOW 80mg', GLOW70: 'GLOW 70mg', BB20: 'BPC-157 10mg + TB-500 10mg', BB20mg: 'BPC-157 10mg + TB-500 10mg',
    CP10: 'CJC-1295 No DAC 5mg + Ipamorelin 5mg', TI: 'Tesamorelin 10mg + Ipamorelin 5mg', BA3: '0.9% Benzyl Alcohol 3ml', BA10: '0.9% Benzyl Alcohol 10ml',
    '2S50': 'SS-31 50mg', 375: 'LL-37 5mg', PMF: 'PE-22-28 10mg', HN: 'Humanin 10mg', PEG: 'PEG MGF 2mg', '5AD': 'AOD-9604 5mg',
    'TB10(BT)': 'TB-500 10mg', 'MT-1': 'Melanotan-1 10mg', ML10: 'Melanotan-1 10mg', KS5: 'Kisspeptin-10 5mg', OT2: 'Oxytocin Acetate 2mg', NP810: 'SNAP-8 10mg'
  };
  for (const [query, name] of Object.entries(expected)) assert.deepEqual(names(query), [name], query);
  const target = products.find(row => row.name === 'Tirzepatide 10mg'); assert.equal(matchesProduct(target, 'TR10', products), true); assert.equal(matchesProduct(target, 'TR100', products), false);
});

test('families precede text search and stay within exact product/identity variants', () => {
  for (const [family, name] of [['TR', 'Tirzepatide'], ['RT', 'Retatrutide']]) assert.deepEqual(names(family), [5, 10, 15, 20, 30, 40, 50, 60].map(dose => name + ' ' + dose + 'mg').sort());
  assert.deepEqual(names('SM'), [5, 10, 15, 20, 30].map(dose => 'Semaglutide ' + dose + 'mg').sort());
  assert.deepEqual(names('BC'), [5, 10, 20].map(dose => 'BPC-157 ' + dose + 'mg').sort());
  assert.deepEqual(names('BB'), [5, 10, 15].map(dose => `BPC-157 ${dose}mg + TB-500 ${dose}mg`).sort());
  assert.deepEqual(names('KS'), ['Kisspeptin-10 5mg']); assert.deepEqual(names('OT'), ['Oxytocin Acetate 2mg']); assert.deepEqual(names('G'), []);
  assert.deepEqual(names('CU'), ['GHK-Cu 100mg', 'GHK-Cu 50mg']);
});

test('unknown/missing doses, unit mismatches and excluded source ambiguities never pick nearby photos', () => {
  for (const query of ['SM2', 'SM40', 'TR5', 'RT5', 'TR100', 'TR120', 'RT80', 'H10', 'H15', 'IG01', 'TB5(BT)', 'KS10', 'OT10', '2S20', 'KLOW8', 'GLOW7', 'SM10ml', 'G5kmg', 'MT2', 'MT-2', 'BBG70', 'CS10', '`', 'TR20/RT40', 'Semaglutide 2', 'Retatrutide 1', 'SS-31 20mg', 'HCG 5000mg', 'NAD+ 50mg', 'Cagriliintide 20mg']) assert.deepEqual(names(query), [], query);
});

test('all canonical full names/doses and controlled spellings remain searchable before SKU rejection', () => {
  for (const product of products) assert.deepEqual(names(product.name), [product.name], product.name);
  for (const [query, expected] of [
    ['BPC157 10mg', ['BPC-157 10mg']], ['DSIP 10mg', ['DSIP 10mg']], ['HCG 5000IU', ['HCG 5000IU']], ['SS-31 10mg', ['SS-31 10mg']], ['AHK-Cu 100mg', ['AHK-Cu 100mg']],
    ['LYSINE-PROLINE-VALINE(KPV) 10mg', ['KPV 10mg']], ['HGH191AA(Somatropin) 24IU', ['HGH Somatropin 24IU']], ['Benzyl Alcohol 0.9% 3ml', ['0.9% Benzyl Alcohol 3ml']],
    ['Cagriliintide', ['Cagrilintide 10mg', 'Cagrilintide 5mg']], ['IGF-1LR3', ['IGF-1 LR3 1mg']], ['LL37', ['LL-37 5mg']], ['TB500(Thymosin B4 Acetate)', ['TB-500 10mg']], ['AOD9604', ['AOD-9604 10mg', 'AOD-9604 5mg']], ['ARA290', ['ARA-290 10mg', 'ARA-290 16mg']]
  ]) assert.deepEqual(names(query), expected.sort(), query);
  assert.equal(names('bpc157').length, 6); assert.equal(names('NAD+').length, 3); assert.ok(names('sema').includes('Semaglutide 10mg'));
  assert.ok(names('CJC-1295 No DAC').every(name => !name.includes('with DAC'))); assert.equal(names('CJC-1295 with DAC').length, 2); assert.equal(names('CJC-1295 DAC').length, 2);
  assert.deepEqual(names('Oxytocin Acetate'), ['Oxytocin Acetate 2mg']);
});

test('existing chemical-name plus exact dose searches work without units and preserve labelled blends', () => {
  assert.deepEqual(names('Kisspeptin-10'), ['Kisspeptin-10 5mg']);
  assert.deepEqual(names('KissPeptin-10'), ['Kisspeptin-10 5mg']);
  assert.deepEqual(names('Kisspeptin 10mg'), ['Kisspeptin 10mg']);
  assert.equal(names('BPC157').length, 6);
  for (const [query, expected] of [
    ['DSIP 10', ['DSIP 10mg']], ['GHK-Cu 50', ['GHK-Cu 50mg']], ['HCG 5000', ['HCG 5000IU']], ['KPV 10', ['KPV 10mg']],
    ['VIP10', ['VIP 10mg']], ['SS-31 10', ['SS-31 10mg']], ['AHK-Cu100', ['AHK-Cu 100mg']], ['MOTS-C10', ['MOTS-C 10mg']],
    ['BPC15710', ['BPC-157 10mg', 'BPC-157 10mg + TB-500 10mg']], ['Cagriliintide 10', ['Cagrilintide 10mg']]
  ]) assert.deepEqual(names(query), expected.sort(), query);
  for (const query of ['TR5', 'RT5', 'SM2', 'TR100', 'DSIP 1', 'HCG 500', 'SS-31 20', 'DSIP 10IU', 'GHK-Cu 50ml']) assert.deepEqual(names(query), [], query);
});

test('curated data are unique, price-free and additive without changing catalog identity or components', () => {
  assert.equal(data.length, 108); assert.equal(data.filter(row => row.skus.length).length, 106); assert.equal(data.reduce((sum, row) => sum + row.skus.length, 0), 107);
  const rows = data.flatMap(row => row.sourceRows); assert.equal(rows.length, 107); assert.equal(new Set(rows).size, 107);
  for (const excluded of [97, 129, 148, 157, 161, 178, 179, 186, 193, 196]) assert.equal(rows.includes(excluded), false);
  for (const item of data) for (const sku of item.skus) assert.deepEqual(names(sku), [item.canonicalName], sku);
  assert.doesNotMatch(JSON.stringify(data), /price|售价|原价|xlsx|[A-Z]:\\/i);
  for (const product of products) {
    const dto = catalogDTO(product), { aliases, ...original } = dto;
    assert.deepEqual(original, { id: product.id, name: product.name, components: product.components, unit: product.unit, imageURL: '/images/' + product.id });
    assert.ok(Array.isArray(aliases.skus)); assert.doesNotMatch(JSON.stringify(dto), /price|sourceRows|imagePath|xlsx/i);
  }
  const duplicate = { ...products.find(row => row.name === 'Tirzepatide 10mg') }; assert.deepEqual(filterProducts([duplicate, { ...duplicate, id: 'duplicate' }], 'TR10'), []);
});

const operatorSource = await readFile(new URL('../conference/operator.js', import.meta.url), 'utf8');
function selectionUI() {
  const nodes = new Map(), buttons = [{ disabled: false }, { disabled: false }];
  function node(id) {
    if (nodes.has(id)) return nodes.get(id);
    const value = { id, value: '', hidden: false, textContent: '', html: '', events: new Map(), classList: { toggle() {} },
      addEventListener(type, fn) { this.events.set(type, fn); }, removeAttribute(key) { delete this[key]; }, replaceWith(next) { nodes.set(this.id, next); },
      get innerHTML() { return this.html; }, set innerHTML(text) { this.html = text; }, get options() { return [...this.html.matchAll(/<option\b/g)]; },
      elements: { namedItem(name) { return node(name); } } };
    nodes.set(id, value); return value;
  }
  const document = { getElementById: node, createElement: () => ({ ...node('new-image-' + nodes.size), events: new Map() }), querySelectorAll: () => buttons };
  const prefix = operatorSource.slice(operatorSource.indexOf('const $='), operatorSource.indexOf('function showResult'));
  const context = { document, filterProducts, Date };
  // Capture actual UI functions in a persistent object shared with the VM.
  const holder = { ...context, catalog: products }; runInNewContext(prefix + '\nsession={products:catalog};globalThis.ui={filter,selectProduct,selected:()=>selected,setBusy:value=>{busy=value}};', holder);
  return { nodes, node, buttons, ui: holder.ui };
}
test('actual selection handlers preserve exact recipes, no-results/busy guards and the last report', () => {
  const app = selectionUI(), search = value => { app.node('search').value = value; app.ui.filter(); };
  app.node('paper').src = '/admin/bundles/published/AN-OLD0-0001/report.svg';
  search('TR10'); assert.equal(app.ui.selected().name, 'Tirzepatide 10mg'); assert.equal(app.node('selected-name').textContent, 'Tirzepatide 10mg'); assert.match(app.node('components').innerHTML, /Tirzepatide/); assert.ok(app.buttons.every(button => !button.disabled));
  search('TR'); assert.equal(app.ui.selected().name, 'Tirzepatide 10mg');
  search('SM'); assert.equal(app.ui.selected(), undefined); assert.equal(app.node('components').innerHTML, ''); assert.ok(app.buttons.every(button => button.disabled));
  app.node('product').value = products.find(row => row.name === 'Semaglutide 10mg').id; app.ui.selectProduct(); assert.match(app.node('components').innerHTML, /Semaglutide/); assert.doesNotMatch(app.node('components').innerHTML, /Tirzepatide/);
  app.ui.setBusy(true); app.ui.selectProduct(); assert.ok(app.buttons.every(button => button.disabled)); app.ui.setBusy(false); app.ui.selectProduct(); assert.ok(app.buttons.every(button => !button.disabled));
  search('SM2'); assert.equal(app.ui.selected(), undefined); assert.equal(app.node('components').innerHTML, ''); assert.match(app.node('status').textContent, /No matching product or dose/); assert.ok(app.buttons.every(button => button.disabled));
  assert.equal(app.node('paper').src, '/admin/bundles/published/AN-OLD0-0001/report.svg'); assert.equal(app.nodes.has('photo'), false);
  search(''); assert.equal(app.ui.selected(), undefined); assert.match(app.node('product').innerHTML, /Choose a matching product/);
});

test('explicit actual catalog QA validates all 110 names/IDs, every alias target and all 107 exact quote SKUs', { skip: process.env.ASSAYNOVA_CATALOG_QA !== '1' }, async () => {
  const catalog = await loadCatalog(DEFAULT_IMAGES), dto = catalog.map(catalogDTO); assert.equal(catalog.length, 110);
  for (const product of catalog) { assert.equal(product.id, createHash('sha256').update(product.name).digest('hex').slice(0, 20)); assert.deepEqual(product.components, parseProduct(product.name).components); }
  for (const row of data) { assert.ok(catalog.some(product => product.name === row.canonicalName), row.canonicalName); for (const sku of row.skus) assert.deepEqual(filterProducts(dto, sku).map(product => product.name), [row.canonicalName]); }
  for (const product of dto) assert.deepEqual(filterProducts(dto, product.name).map(row => row.name), [product.name]);
});
