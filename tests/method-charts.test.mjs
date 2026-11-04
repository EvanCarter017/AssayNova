import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { METHOD_ANALYTES, PROTON_MASS, CARBON13_SPACING, ROTATION_MS, generateMethodSamples, renderMethodPlot, createMethodCharts } from '../dist/method-charts.js';

class Target {
  constructor() { this.listeners = new Map(); this.attributes = new Map(); this.textContent = ''; this.innerHTML = ''; this.disabled = true; this.hidden = false; this.clientWidth = 520; }
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
    const elements = Object.fromEntries(['.methods-chart', '.methods-run-name', '.methods-run-stats', '.methods-chart-frame', '.methods-carousel-controls', '.methods-run-count', '.methods-announcement', '[data-chart-action="play"]', '[data-chart-action="previous"]', '[data-chart-action="next"]'].map(selector => [selector, new Target()]));
    elements['.methods-chart'].clientWidth = width;
    for (const element of Object.values(elements)) element.focus = () => { document.activeElement = element; figure.fire('focusin'); };
    figure.querySelector = selector => elements[selector]; figure.nodes = elements; return figure;
  });
  root.querySelectorAll = () => figures;
  const controller = createMethodCharts(root, { seed: 51, scheduler });
  const button = (action, figure = 0) => figures[figure].nodes[`[data-chart-action="${action}"]`];
  const visible = (active = true, figure = figures[0]) => observation.intersection?.emit([{ target: figure, isIntersecting: active }]);
  const route = hidden => { root.hidden = hidden; observation.mutation?.emit([]); };
  const tab = hidden => { document.hidden = hidden; document.fire('visibilitychange'); };
  return { root, document, media, figures, controller, button, observation, tasks, advance, visible, route, tab };
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
  for (const width of [218, 300, 520, 680]) for (const kind of ['hplc', 'mass']) {
    const sample = generateMethodSamples(92)[0], svg = renderMethodPlot(kind, sample, width);
    assert.ok(svg.includes(`viewBox="0 0 ${width} 236"`)); assert.ok(svg.includes('font-size="11"')); assert.ok(svg.includes('<title>') && svg.includes('<desc>')); assert.ok(!/NaN|Infinity|undefined/.test(svg)); assert.ok(svg.includes(kind === 'hplc' ? 'Response (mAU)' : 'Intensity (counts)'));
  }
  const hostile = structuredClone(generateMethodSamples(2)[0]); hostile.analyte.name = '<img onerror="bad">';
  assert.ok(renderMethodPlot('hplc', hostile).includes('&lt;img')); assert.ok(!renderMethodPlot('mass', hostile).includes('<img'));
  hostile.analyte.charge = '1><script>'; assert.throws(() => renderMethodPlot('mass', hostile), /charge/);
  const invalid = structuredClone(generateMethodSamples(2)[0]); invalid.hplc.trace[0][1] = Infinity; assert.throws(() => renderMethodPlot('hplc', invalid), /Non-finite/);
  for (const field of ['mz', 'counts']) { const badIon = structuredClone(generateMethodSamples(2)[0]); badIon.mass.ions[0][field] = NaN; assert.throws(() => renderMethodPlot('mass', badIon), /Non-finite ion/); }
  assert.throws(() => renderMethodPlot('unknown', invalid), /Unknown/);
});

test('paired controls wrap both ways, preserve exact data and focused button nodes across resize', () => {
  const f = fixture(), start = f.controller.getState().sample, play = f.button('play');
  assert.equal(createMethodCharts(f.root), f.controller); assert.equal(f.button('next').listeners.get('click').size, 1);
  f.button('previous', 1).focus(); f.button('previous', 1).fire('click'); assert.equal(f.controller.getState().index, 2);
  for (const figure of f.figures) { assert.ok(figure.nodes['.methods-run-name'].textContent.includes('Thymosin Beta-4')); assert.equal(figure.nodes['.methods-run-count'].textContent, '03 / 03'); assert.ok(figure.nodes['.methods-announcement'].textContent.includes('Both method views updated')); }
  f.button('next').fire('click'); assert.equal(f.controller.getState().sample, start);
  f.figures[0].nodes['.methods-chart'].clientWidth = 218; f.observation.resize.emit([]);
  assert.equal(f.controller.getState().sample, start); assert.equal(f.button('play'), play); assert.equal(f.document.activeElement, f.button('previous', 1)); assert.ok(f.figures[0].nodes['.methods-chart'].innerHTML.includes('0 0 218 236'));
});

test('one paired 7.5-second timer starts only after visible intersection and pauses manually', () => {
  const f = fixture(); assert.equal(f.tasks.size, 0); f.advance(30000); assert.equal(f.controller.getState().index, 0);
  f.visible(); assert.equal(f.tasks.size, 1); assert.equal([...f.tasks.values()][0].delay, ROTATION_MS);
  f.advance(7499); assert.equal(f.controller.getState().index, 0); f.advance(1); assert.equal(f.controller.getState().index, 1); assert.equal(f.tasks.size, 1);
  f.figures.forEach(figure => assert.equal(figure.nodes['.methods-announcement'].textContent, ''));
  f.button('play').fire('click'); assert.equal(f.tasks.size, 0); f.advance(15000); assert.equal(f.controller.getState().index, 1);
  f.button('play', 1).fire('click'); assert.equal(f.tasks.size, 1); f.advance(7500); assert.equal(f.controller.getState().index, 2);
});

test('focus entry requires explicit restart; hover release alone resumes only requested playback', () => {
  const f = fixture(); f.visible(); f.button('next').focus(); assert.equal(f.tasks.size, 0); f.figures[0].fire('focusout'); assert.equal(f.tasks.size, 0);
  f.figures[0].fire('pointerenter'); f.button('play').fire('click'); assert.equal(f.controller.getState().wanted, true); assert.equal(f.tasks.size, 0); assert.equal(f.button('play').textContent, 'Pause rotation');
  f.figures[0].fire('pointerleave'); assert.equal(f.tasks.size, 1); f.figures[1].fire('pointerenter'); assert.equal(f.tasks.size, 0); f.figures[1].fire('pointerleave'); assert.equal(f.tasks.size, 1);
  f.button('play').fire('click'); f.figures[0].fire('pointerenter'); f.figures[0].fire('pointerleave'); assert.equal(f.tasks.size, 0);
});

test('pointerdown then focusin then click pauses the requested rotation; keyboard restart still works', () => {
  const f = fixture(); f.visible(); const play = f.button('play');
  f.figures[0].fire('pointerenter'); play.fire('pointerdown'); play.focus(); play.fire('pointerup'); play.fire('click', { detail: 1 });
  assert.equal(f.controller.getState().wanted, false); assert.equal(play.textContent, 'Start rotation'); f.figures[0].fire('pointerleave'); assert.equal(f.tasks.size, 0);
  f.figures[0].fire('pointerenter'); play.fire('pointerdown'); play.focus(); play.fire('click', { detail: 1 }); assert.equal(f.controller.getState().wanted, true); f.figures[0].fire('pointerleave'); assert.equal(f.tasks.size, 1);
  play.focus(); assert.equal(f.controller.getState().wanted, false); play.fire('click', { detail: 0 }); assert.equal(f.controller.getState().wanted, true);
  play.fire('pointerdown'); play.fire('pointercancel'); play.focus(); play.fire('click', { detail: 0 }); assert.equal(f.controller.getState().wanted, true);
});

test('route, document and intersection gates stop hidden rotation and preserve manual pause', () => {
  const f = fixture(); f.visible(); f.route(true); f.advance(30000); assert.equal(f.controller.getState().index, 0); assert.equal(f.tasks.size, 0);
  f.route(false); assert.equal(f.tasks.size, 1); f.tab(true); assert.equal(f.tasks.size, 0); f.tab(false); assert.equal(f.tasks.size, 1);
  f.visible(false); assert.equal(f.tasks.size, 0); f.visible(true, f.figures[1]); assert.equal(f.tasks.size, 1);
  f.button('play').fire('click'); f.route(true); f.route(false); f.tab(true); f.tab(false); assert.equal(f.tasks.size, 0);
  const hidden = fixture(); hidden.root.hidden = true; hidden.visible(); assert.equal(hidden.tasks.size, 0);
});

test('reduced motion defaults manual, changes pause, explicit Play permits static rotation', () => {
  const f = fixture({ reduced: true }); f.visible(); assert.equal(f.tasks.size, 0); f.button('play').fire('click'); assert.equal(f.tasks.size, 1);
  f.media.fire('change', { matches: true }); assert.equal(f.tasks.size, 0); f.media.fire('change', { matches: false }); assert.equal(f.tasks.size, 0); f.button('play').fire('click'); f.advance(7500); assert.equal(f.controller.getState().index, 1);
});

test('missing observers fail safe to usable manual controls, destroy cleans every callback', () => {
  const missing = fixture({ missing: true }); missing.button('play').fire('click'); missing.advance(30000); assert.equal(missing.tasks.size, 0); missing.button('next').fire('click'); assert.equal(missing.controller.getState().index, 1);
  const f = fixture(); f.visible(); f.controller.destroy(); f.controller.destroy(); assert.equal(f.tasks.size, 0); assert.ok(Object.values(f.observation).every(observer => observer.disconnected)); assert.equal(f.media.listeners.get('change').size, 0); assert.equal(f.document.listeners.get('visibilitychange').size, 0);
  for (const figure of f.figures) { assert.equal(figure.listeners.get('focusin').size, 0); assert.equal(figure.nodes['.methods-carousel-controls'].hidden, true); }
  assert.equal(f.button('next').listeners.get('click').size, 0); const before = f.controller.getState().index; f.advance(30000); assert.equal(f.controller.getState().index, before);
});

test('queued old observers and media callbacks cannot overwrite a rebound controller', () => {
  const f = fixture(); f.visible();
  const oldObservers = { ...f.observation }, oldMotion = [...f.media.listeners.get('change')][0];
  f.controller.destroy();
  const rebound = createMethodCharts(f.root, { seed: 752 });
  f.button('play').focus();
  assert.equal(f.button('play').textContent, 'Start rotation');
  const plot = f.figures[0].nodes['.methods-chart'].innerHTML;
  oldObservers.intersection.emit([{ target: f.figures[0], isIntersecting: true }]); oldObservers.mutation.emit([]); oldObservers.resize.emit([]);
  assert.equal(f.button('play').textContent, 'Start rotation'); assert.equal(f.figures[0].nodes['.methods-chart'].innerHTML, plot); assert.equal(f.tasks.size, 0);
  f.visible(); f.button('play').fire('click'); assert.equal(f.tasks.size, 1); assert.equal(rebound.getState().wanted, true);
  oldMotion({ matches: true }); oldObservers.mutation.emit([]);
  assert.equal(f.button('play').textContent, 'Pause rotation'); assert.equal(f.tasks.size, 1); assert.equal(rebound.getState().wanted, true);
});

test('pure import performs no DOM, timers, storage, network or clipboard work', () => {
  const source = readFileSync(new URL('../dist/method-charts.js', import.meta.url), 'utf8').replace(/\bexport\s+/g, '');
  const context = {};
  for (const name of ['window', 'document', 'localStorage', 'navigator', 'fetch', 'setTimeout', 'setInterval']) Object.defineProperty(context, name, { get() { throw Error('Import touched ' + name); } });
  assert.doesNotThrow(() => vm.runInNewContext(source, context));
});
