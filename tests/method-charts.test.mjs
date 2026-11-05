import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { METHOD_ANALYTES, PROTON_MASS, CARBON13_SPACING, ROTATION_MS, generateMethodSamples, renderMethodPlot, createMethodCharts } from '../dist/method-charts.js';

class Target {
  constructor() { this.listeners = new Map(); this.attributes = new Map(); this.dataset = {}; this.innerHTML = ''; this.hidden = false; this.clientWidth = 520; this.classes = new Set(); this.classList = { toggle: (name, active) => active ? this.classes.add(name) : this.classes.delete(name), contains: name => this.classes.has(name) }; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  fire(type, values = {}) { for (const listener of [...(this.listeners.get(type) || [])]) listener({ target: this, ...values }); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
}
function fixture({ reduced = false, missing = false, width = 520 } = {}) {
  const document = new Target(), root = new Target(), media = new Target(); media.matches = reduced; document.hidden = false; document.activeElement = null; root.ownerDocument = document;
  let time = 0, sequence = 0; const tasks = new Map(), observation = {};
  const scheduler = { setTimeout(callback, delay) { const id = ++sequence; tasks.set(id, { callback, at: time + delay, delay }); return id; }, clearTimeout(id) { tasks.delete(id); } };
  const advance = milliseconds => { const end = time + milliseconds; for (;;) { const due = [...tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (!due || due[1].at > end) break; time = due[1].at; tasks.delete(due[0]); due[1].callback(); } time = end; };
  const observer = kind => class { constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observation[kind] = this; } observe(target) { this.targets.push(target); } disconnect() { this.disconnected = true; } emit(entries) { this.callback(entries); } };
  document.defaultView = { setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout, matchMedia: () => media, ...(missing ? {} : { IntersectionObserver: observer('intersection'), MutationObserver: observer('mutation'), ResizeObserver: observer('resize') }) };
  const figures = ['hplc', 'mass'].map(kind => {
    const figure = new Target(); figure.dataset = { methodChart: kind };
    const elements = Object.fromEntries(['.methods-chart', '.methods-chart-frame'].map(selector => [selector, new Target()]));
    const layers = [new Target(), new Target()];
    elements['.methods-chart'].clientWidth = width;
    elements['.methods-chart'].querySelectorAll = () => layers;
    figure.layers = layers;
    figure.querySelector = selector => elements[selector]; figure.nodes = elements; return figure;
  });
  root.querySelectorAll = () => figures;
  const controller = createMethodCharts(root, { seed: 51, scheduler });
  const visible = (active = true, figure = figures[0]) => observation.intersection?.emit([{ target: figure, isIntersecting: active }]);
  const route = hidden => { root.hidden = hidden; observation.mutation?.emit([]); };
  const tab = hidden => { document.hidden = hidden; document.fire('visibilitychange'); };
  return { root, document, media, figures, controller, observation, tasks, advance, visible, route, tab };
}

test('method model is deterministic, immutable, seed-variable and area/retention consistent', () => {
  const first = generateMethodSamples(194), again = generateMethodSamples(194);
  assert.deepEqual(first, again); assert.notDeepEqual(first, generateMethodSamples(195)); assert.ok(Object.isFrozen(first[0].hplc.trace[0]));
  for (let seed = 0; seed < 100; seed++) for (const sample of generateMethodSamples(seed)) {
    const h = sample.hplc; assert.ok(h.rt >= 4.2 && h.rt <= 9.8); assert.ok(h.purity >= 96.5 && h.purity <= 99.8);
    assert.ok(h.peaks.length >= 3 && h.peaks.length <= 7); assert.ok(Math.abs(h.peaks.reduce((sum, peak) => sum + peak.area, 0) - 100) < 1e-10); assert.equal(h.peaks.find(peak => peak.main).area, h.purity);
    assert.equal(h.trace.length, 901); assert.equal(h.trace[0][0], 0); assert.equal(h.trace.at(-1)[0], 15);
    h.trace.forEach(([x, y], i) => { assert.ok(Number.isFinite(x) && Number.isFinite(y) && y >= 0 && y <= h.max); if (i) assert.ok(x > h.trace[i - 1][0]); });
    h.peaks.forEach((peak, i) => { assert.ok(peak.area > 0); if (i) assert.ok(peak.rt - h.peaks[i - 1].rt > 0.65); });
  }
});

test('ion model matches local primary chemistry, charge spacing, ppm and natural envelopes', () => {
  const reference = JSON.parse(readFileSync(new URL('../templates/coa/analytical-references.json', import.meta.url)));
  assert.equal(PROTON_MASS, reference.protonMassU); assert.equal(CARBON13_SPACING, reference.carbon13SpacingU);
  for (const sample of generateMethodSamples(923)) {
    const a = sample.analyte, ref = reference.analytes.find(item => item.cid === a.cid), m = sample.mass;
    assert.equal(a.mass, ref.neutralMonoisotopicMass); assert.deepEqual([...a.envelope], reference.isotopeEnvelopes[a.cid]); assert.ok(ref.charges.includes(a.charge)); assert.ok(Math.abs(m.ppm) <= 3);
    m.ions.forEach((ion, i) => {
      const expected = (a.mass / a.charge + PROTON_MASS + i * CARBON13_SPACING / a.charge) * (1 + m.ppm / 1e6);
      assert.ok(Math.abs(ion.mz - expected) < 1e-10); assert.ok(Math.abs(ion.counts / m.amplitude * 100 - a.envelope[i]) < 1e-10);
      assert.ok(ion.mz > m.min && ion.mz < m.max); if (i) assert.ok(ion.mz > m.ions[i - 1].mz);
    });
  }
  const tb4 = generateMethodSamples(1)[2]; assert.equal(tb4.analyte.charge, 5); assert.equal(tb4.mass.ions.indexOf(tb4.mass.ions.reduce((a, b) => a.counts > b.counts ? a : b)), 2);
});

test('responsive instrument renderer keeps pixel labels, units, safe text and finite coordinates', () => {
  for (const [width, height] of [[218, 161], [300, 198], [520, 297], [680, 370]]) for (const kind of ['hplc', 'mass']) {
    const sample = generateMethodSamples(92)[0], svg = renderMethodPlot(kind, sample, width);
    assert.ok(svg.includes(`viewBox="0 0 ${width} ${height}"`)); assert.ok(svg.includes('font-size="11"')); assert.ok(svg.includes('<title>') && svg.includes('<desc>')); assert.ok(!/NaN|Infinity|undefined/.test(svg)); assert.ok(svg.includes(kind === 'hplc' ? 'Response (mAU)' : 'Intensity (counts)'));
  }
  const hostile = structuredClone(generateMethodSamples(2)[0]); hostile.analyte.name = '<img onerror="bad">';
  assert.ok(renderMethodPlot('hplc', hostile).includes('&lt;img')); assert.ok(!renderMethodPlot('mass', hostile).includes('<img'));
  hostile.analyte.charge = '1><script>'; assert.throws(() => renderMethodPlot('mass', hostile), /charge/);
  const invalid = structuredClone(generateMethodSamples(2)[0]); invalid.hplc.trace[0][1] = Infinity; assert.throws(() => renderMethodPlot('hplc', invalid), /Non-finite/);
  for (const field of ['mz', 'counts']) { const badIon = structuredClone(generateMethodSamples(2)[0]); badIon.mass.ions[0][field] = NaN; assert.throws(() => renderMethodPlot('mass', badIon), /Non-finite ion/); }
  assert.throws(() => renderMethodPlot('unknown', invalid), /Unknown/);
});

test('paired crossfade cycles three stable samples and retains outgoing SVG until the next turn', () => {
  const f = fixture(), start = f.controller.getState().sample;
  assert.equal(createMethodCharts(f.root), f.controller);
  const initial = f.figures.map(figure => figure.layers[0].innerHTML);
  for (const figure of f.figures) { assert.equal(figure.layers[0].innerHTML, figure.layers[1].innerHTML); assert.ok(figure.layers[0].classList.contains('is-active')); }
  f.visible(); f.advance(7500);
  assert.equal(f.controller.getState().index, 1); assert.equal(f.controller.getState().activeLayer, 1);
  for (const [i, figure] of f.figures.entries()) {
    assert.equal(figure.layers[0].innerHTML, initial[i]); assert.notEqual(figure.layers[1].innerHTML, initial[i]);
    assert.equal(figure.layers[0].getAttribute('aria-hidden'), 'true'); assert.equal(figure.layers[1].getAttribute('aria-hidden'), 'false');
    assert.ok(!figure.layers[0].classList.contains('is-active')); assert.ok(figure.layers[1].classList.contains('is-active'));
    assert.equal(figure.nodes['.methods-chart-frame'].getAttribute('aria-label'), 'BPC-157, 2 of 3');
  }
  const outgoing = f.figures.map(figure => figure.layers[1].innerHTML); f.advance(7499);
  assert.deepEqual(f.figures.map(figure => figure.layers[1].innerHTML), outgoing);
  f.advance(1); assert.equal(f.controller.getState().index, 2); assert.equal(f.controller.getState().activeLayer, 0);
  assert.deepEqual(f.figures.map(figure => figure.layers[1].innerHTML), outgoing);
  f.advance(7500); assert.equal(f.controller.getState().sample, start); assert.deepEqual(f.figures.map(figure => figure.layers[1].innerHTML), initial);
});

test('HPLC response units and retention annotation occupy separate header lines at narrow widths', () => {
  for (const width of [245, 300, 520]) for (const sample of generateMethodSamples(194)) {
    const svg = renderMethodPlot('hplc', sample, width);
    const units = Number(svg.match(/<text x="47" y="([\d.]+)">Response \(mAU\)<\/text>/)[1]);
    const retention = Number(svg.match(/<text x="[\d.]+" y="([\d.]+)" text-anchor="middle">[\d.]+ min<\/text>/)[1]);
    assert.ok(retention - units >= 14, '11px labels have separate rows with a gap');
    assert.ok(retention + 3 <= 33, 'retention label stays above the plot boundary');
  }
});

test('one 7.5-second paired timer starts only after intersection and never adds a fade-completion timer', () => {
  const f = fixture(); assert.equal(f.tasks.size, 0); f.advance(30000); assert.equal(f.controller.getState().index, 0);
  f.visible(); assert.equal(f.tasks.size, 1); assert.equal([...f.tasks.values()][0].delay, ROTATION_MS);
  f.advance(7499); assert.equal(f.controller.getState().index, 0); f.advance(1); assert.equal(f.controller.getState().index, 1); assert.equal(f.tasks.size, 1);
  f.figures.forEach(figure => assert.equal(figure.nodes['.methods-chart-frame'].getAttribute('aria-live'), 'off'));
});

test('resize redraws both layers from the current immutable sample without changing active layer or focus', () => {
  const f = fixture(); f.visible(); f.advance(7500); const current = f.controller.getState().sample, active = f.controller.getState().activeLayer;
  const focused = new Target(); f.document.activeElement = focused;
  f.figures.forEach(figure => { figure.nodes['.methods-chart'].clientWidth = 218; }); f.observation.resize.emit([]);
  assert.equal(f.controller.getState().sample, current); assert.equal(f.controller.getState().activeLayer, active); assert.equal(f.document.activeElement, focused);
  for (const figure of f.figures) { assert.equal(figure.layers[0].innerHTML, figure.layers[1].innerHTML); assert.ok(figure.layers[active].classList.contains('is-active')); assert.ok(figure.layers[0].innerHTML.includes('0 0 218 161')); }
  assert.equal(f.tasks.size, 1);
});

test('noninteractive plots have no focus or hover controls and keep rotating when those events occur', () => {
  const f = fixture(); f.visible();
  for (const figure of f.figures) { figure.fire('focusin'); figure.fire('pointerenter'); assert.equal(figure.listeners.size, 0); }
  f.advance(7500); assert.equal(f.controller.getState().index, 1);
  const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
  const figures = [...html.matchAll(/<figure class="methods-figure" data-method-chart="[^"]+"[\s\S]*?<\/figure>/g)]; assert.equal(figures.length, 2);
  figures.forEach(([figure]) => { assert.ok(!/<button|tabindex=|methods-carousel-controls/.test(figure)); assert.ok(figure.includes('<figcaption class="sr-only">')); });
});

test('route, document and offscreen gates stop rotation and resume only when visible again', () => {
  const f = fixture(); f.visible(); f.route(true); f.advance(30000); assert.equal(f.controller.getState().index, 0); assert.equal(f.tasks.size, 0);
  f.route(false); assert.equal(f.tasks.size, 1); f.tab(true); assert.equal(f.tasks.size, 0); f.tab(false); assert.equal(f.tasks.size, 1);
  f.visible(false); assert.equal(f.tasks.size, 0); f.visible(true, f.figures[1]); assert.equal(f.tasks.size, 1);
  f.advance(7500); assert.equal(f.controller.getState().index, 1);
  const hidden = fixture(); hidden.root.hidden = true; hidden.visible(); assert.equal(hidden.tasks.size, 0);
});

test('reduced motion starts static, changing back resumes, and a later reduce event cancels rotation', () => {
  const f = fixture({ reduced: true }); f.visible(); assert.equal(f.tasks.size, 0); f.advance(30000); assert.equal(f.controller.getState().index, 0);
  f.media.fire('change', { matches: false }); assert.equal(f.tasks.size, 1); f.advance(7500); assert.equal(f.controller.getState().index, 1);
  f.media.fire('change', { matches: true }); assert.equal(f.tasks.size, 0); f.advance(30000); assert.equal(f.controller.getState().index, 1);
  f.media.fire('change', { matches: false }); assert.equal(f.tasks.size, 1);
});

test('missing observers leave a static accessible initial plot without timers', () => {
  const f = fixture({ missing: true }); f.advance(30000); assert.equal(f.tasks.size, 0); assert.equal(f.controller.getState().index, 0);
  for (const figure of f.figures) { assert.ok(figure.layers[0].innerHTML.includes('role="img"')); assert.equal(figure.layers[0].getAttribute('aria-hidden'), 'false'); }
});

test('destroy cleans callbacks and queued old observers cannot overwrite a rebound paired controller', () => {
  const f = fixture(); f.visible(); const oldObservers = { ...f.observation }, oldMotion = [...f.media.listeners.get('change')][0];
  f.controller.destroy(); f.controller.destroy(); assert.equal(f.tasks.size, 0); assert.ok(Object.values(oldObservers).every(observer => observer.disconnected));
  assert.equal(f.media.listeners.get('change').size, 0); assert.equal(f.document.listeners.get('visibilitychange').size, 0);
  const rebound = createMethodCharts(f.root, { seed: 752 }); f.visible(); f.advance(15000);
  const before = f.figures.map(figure => figure.layers.map(layer => layer.innerHTML)), state = rebound.getState();
  oldObservers.intersection.emit([{ target: f.figures[0], isIntersecting: true }]); oldObservers.mutation.emit([]); oldObservers.resize.emit([]); oldMotion({ matches: true });
  assert.deepEqual(f.figures.map(figure => figure.layers.map(layer => layer.innerHTML)), before); assert.equal(rebound.getState().sample, state.sample); assert.equal(rebound.getState().activeLayer, state.activeLayer); assert.equal(f.tasks.size, 1);
});

test('pure import performs no DOM, timers, storage, network or clipboard work', () => {
  const source = readFileSync(new URL('../dist/method-charts.js', import.meta.url), 'utf8').replace(/\bexport\s+/g, '');
  const context = {};
  for (const name of ['window', 'document', 'localStorage', 'navigator', 'fetch', 'setTimeout', 'setInterval']) Object.defineProperty(context, name, { get() { throw Error('Import touched ' + name); } });
  assert.doesNotThrow(() => vm.runInNewContext(source, context));
});
