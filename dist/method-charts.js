// Instrument-style illustrative data. Constants mirror analytical-references.json.
export const METHOD_ANALYTES = Object.freeze([
  Object.freeze({ name: 'KPV', mass: 342.22670545, charge: 2, envelope: Object.freeze([100, 19.264, 2.581]), cid: 125672 }),
  Object.freeze({ name: 'BPC-157', mass: 1418.70415882, charge: 2, envelope: Object.freeze([100, 74.868, 32.174, 10.1, 2.553]), cid: 9941957 }),
  Object.freeze({ name: 'Thymosin Beta-4', mass: 4960.4863169, charge: 5, envelope: Object.freeze([28.502, 73.404, 100, 95.243, 70.885, 43.753]), cid: 16132341 })
]);
export const PROTON_MASS = 1.0072764665789;
export const CARBON13_SPACING = 1.00335483507;
export const ROTATION_MS = 7500;
const bindings = new WeakMap();
const round = (value, places = 2) => Number(value.toFixed(places));
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
function randomGenerator(seed) {
  let state = Number(seed) >>> 0;
  return () => { state += 0x6D2B79F5; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
const gaussian = (x, mean, sigma) => Math.exp(-0.5 * ((x - mean) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
const profile = (x, peak) => 0.86 * gaussian(x, peak.rt, peak.sigma) + 0.14 * gaussian(x, peak.rt + peak.sigma * 1.7, peak.sigma * 2.1);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

export function generateMethodSamples(seed) {
  const random = randomGenerator(seed);
  return freeze(METHOD_ANALYTES.map((analyte, index) => {
    const purity = round(96.5 + random() * 3.3), rt = round(4.2 + random() * 5.6), minorCount = 2 + Math.floor(random() * 5);
    const locations = [];
    // A shuffled, well-spaced lattice avoids rejection-loop and tail overlaps.
    const candidates = Array.from({ length: 16 }, (_, i) => round(0.85 + i * 0.86 + random() * 0.12)).filter(value => Math.abs(value - rt) > 0.85);
    while (locations.length < minorCount) locations.push(candidates.splice(Math.floor(random() * candidates.length), 1)[0]);
    const weights = locations.map(() => 0.3 + random()), totalWeight = weights.reduce((a, b) => a + b, 0);
    const main = { rt, sigma: 0.045 + random() * 0.025, area: purity, main: true };
    const peaks = [main, ...locations.map((value, i) => ({ rt: value, sigma: 0.04 + random() * 0.025, area: (100 - purity) * weights[i] / totalWeight, main: false }))].sort((a, b) => a.rt - b.rt);
    const response = 120 + random() * 760, scale = response / (purity * profile(rt, main));
    const trace = Array.from({ length: 901 }, (_, i) => {
      const x = i / 60, fitted = peaks.reduce((sum, peak) => sum + peak.area * profile(x, peak), 0) * scale;
      return [x, fitted + 1.4 + 0.045 * x + 0.3 * Math.sin(x * 2.8) + random() * 0.55];
    });
    const ppm = round((random() * 6 - 3), 4), monoisotopic = analyte.mass / analyte.charge + PROTON_MASS;
    const amplitude = Math.round(18000 + random() * 102000);
    const ions = analyte.envelope.map((relative, isotope) => ({ mz: (monoisotopic + isotope * CARBON13_SPACING / analyte.charge) * (1 + ppm / 1e6), counts: amplitude * relative / 100, isotope }));
    const massMin = ions[0].mz - 0.32, massMax = ions.at(-1).mz + 0.32;
    const background = Array.from({ length: 321 }, (_, i) => [massMin + i / 320 * (massMax - massMin), random() * amplitude * 0.003]);
    return { id: index + 1, run: 'RUN ' + String(index + 1).padStart(2, '0'), analyte, hplc: { purity, rt, peaks, trace, max: Math.ceil(Math.max(...trace.map(point => point[1])) / 100) * 100 }, mass: { ppm, monoisotopic, ions, amplitude, min: massMin, max: massMax, background, maxCounts: Math.ceil(amplitude / 20000) * 20000 } };
  }));
}

export function renderMethodPlot(kind, sample, measuredWidth = 520) {
  if (!['hplc', 'mass'].includes(kind)) throw new TypeError('Unknown method chart');
  if (!Number.isInteger(sample.analyte.charge) || sample.analyte.charge < 1) throw new TypeError('Invalid ion charge');
  const width = Math.max(160, Math.round(Number(measuredWidth) || 520)), height = 236;
  const left = 47, right = width - 13, top = 33, bottom = height - 40;
  const data = kind === 'hplc' ? sample.hplc : sample.mass;
  const minX = kind === 'hplc' ? 0 : data.min, maxX = kind === 'hplc' ? 15 : data.max, maxY = kind === 'hplc' ? data.max : data.maxCounts;
  if (![minX, maxX, maxY, width].every(Number.isFinite) || maxX <= minX || maxY <= 0) throw new TypeError('Invalid chart bounds');
  if (kind === 'mass' && data.ions.some(ion => !Number.isFinite(ion.mz) || !Number.isFinite(ion.counts) || ion.counts < 0)) throw new TypeError('Non-finite ion data');
  const x = value => left + (value - minX) / (maxX - minX) * (right - left), y = value => bottom - value / maxY * (bottom - top);
  const line = points => points.map(([a, b], i) => { if (![a, b].every(Number.isFinite)) throw new TypeError('Non-finite chart point'); return `${i ? 'L' : 'M'}${x(a).toFixed(2)},${y(b).toFixed(2)}`; }).join('');
  const xTicks = Array.from({ length: 4 }, (_, i) => minX + (maxX - minX) * i / 3);
  const yTicks = [0, maxY / 2, maxY];
  const tick = (value, mass = false) => mass ? value.toFixed(1) : Number(value.toFixed(1)).toString();
  const yLabel = kind === 'hplc' ? 'Response (mAU)' : 'Intensity (counts)';
  const title = kind === 'hplc' ? `${sample.analyte.name}: chromatographic profile` : `${sample.analyte.name}: selected-ion region`;
  const description = kind === 'hplc' ? `Illustrative run ${sample.id}. Main retention time ${data.rt.toFixed(2)} minutes; fitted main peak area ${data.purity.toFixed(2)} percent; ${data.peaks.length} fitted peaks.` : `Illustrative run ${sample.id}. Charge ${sample.analyte.charge}+; monoisotopic m/z ${data.ions[0].mz.toFixed(4)}; natural isotope envelope with a ${data.ppm.toFixed(2)} ppm shift.`;
  const grid = yTicks.map(value => `<path d="M${left} ${y(value).toFixed(2)}H${right}" stroke="#e0e8e4"/><text x="${left - 7}" y="${(y(value) + 4).toFixed(2)}" text-anchor="end">${value >= 1000 ? Math.round(value / 1000) + 'k' : Math.round(value)}</text>`).join('');
  const ticks = xTicks.map((value, i) => `<path d="M${x(value).toFixed(2)} ${bottom}v4" stroke="#354b51"/><text x="${x(value).toFixed(2)}" y="${bottom + 19}" text-anchor="${i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}">${tick(value, kind === 'mass')}</text>`).join('');
  const ink = kind === 'hplc' ? `<path d="${line(data.trace)}" fill="none" stroke="#263d44" stroke-width="1.15"/><text x="${Math.max(left + 20, Math.min(right - 20, x(data.rt))).toFixed(2)}" y="23" text-anchor="middle">${data.rt.toFixed(2)} min</text>` : `<path d="${line(data.background)}" fill="none" stroke="#62766f" stroke-width=".7"/>${data.ions.map(ion => `<path d="M${x(ion.mz).toFixed(2)} ${bottom}V${y(ion.counts).toFixed(2)}" stroke="#263d44" stroke-width="1.25"/>`).join('')}<text x="${right}" y="23" text-anchor="end">[M+${sample.analyte.charge}H]${sample.analyte.charge}+</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" focusable="false" aria-label="${escape(title)}"><title>${escape(title)}</title><desc>${escape(description)}</desc><rect width="${width}" height="${height}" fill="white"/><g fill="#354b51" font-family="Segoe UI,Arial,sans-serif" font-size="11"><text x="${left}" y="14">${yLabel}</text>${grid}<path d="M${left} ${top}V${bottom}H${right}" stroke="#354b51" fill="none"/>${ticks}${ink}<text x="${(left + right) / 2}" y="${height - 3}" text-anchor="middle">${kind === 'hplc' ? 'Retention time (min)' : 'm/z'}</text></g></svg>`;
}

export function createMethodCharts(root, options = {}) {
  if (!root) return null;
  if (bindings.has(root)) return bindings.get(root);
  const document = root.ownerDocument, window = document.defaultView;
  const samples = options.samples || generateMethodSamples(options.seed ?? Math.floor(Math.random() * 4294967296));
  if (!samples.length) throw new TypeError('Chart samples are required');
  const figures = [...root.querySelectorAll('.methods-figure[data-method-chart]')];
  if (figures.length !== 2) return null;
  const nodes = figures.map(figure => ({ figure, kind: figure.dataset.methodChart, plot: figure.querySelector('.methods-chart'), name: figure.querySelector('.methods-run-name'), stats: figure.querySelector('.methods-run-stats'), frame: figure.querySelector('.methods-chart-frame'), controls: figure.querySelector('.methods-carousel-controls'), counter: figure.querySelector('.methods-run-count'), live: figure.querySelector('.methods-announcement'), play: figure.querySelector('[data-chart-action="play"]'), previous: figure.querySelector('[data-chart-action="previous"]'), next: figure.querySelector('[data-chart-action="next"]') }));
  if (nodes.some(node => Object.values(node).some(value => !value))) throw new TypeError('Method chart controls are incomplete');
  const scheduler = options.scheduler || { setTimeout: (callback, delay) => window.setTimeout(callback, delay), clearTimeout: id => window.clearTimeout(id) };
  const IO = options.IntersectionObserver ?? window.IntersectionObserver, MO = options.MutationObserver ?? window.MutationObserver, RO = options.ResizeObserver ?? window.ResizeObserver;
  const media = options.media || window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let index = 0, timer = null, wanted = !media?.matches, destroyed = false;
  const hovering = new Set(), intersecting = new Set(), cleanups = [], observers = [];
  const canObserve = Boolean(IO && MO && RO && media);
  const eligible = () => !destroyed && wanted && canObserve && !root.hidden && !document.hidden && intersecting.size > 0 && hovering.size === 0;
  const listen = (target, event, handler) => { target.addEventListener(event, handler); cleanups.push(() => target.removeEventListener(event, handler)); };
  function paint(announce = false) {
    if (destroyed) return;
    const sample = samples[index];
    for (const node of nodes) {
      node.plot.innerHTML = renderMethodPlot(node.kind, sample, node.plot.clientWidth || 520);
      node.name.textContent = `${sample.run} / ${sample.analyte.name}`;
      node.stats.textContent = node.kind === 'hplc' ? `${sample.hplc.purity.toFixed(2)}% area · ${sample.hplc.rt.toFixed(2)} min · ${sample.hplc.peaks.length} peaks` : `Selected-ion region · ${sample.analyte.charge}+ · mono m/z ${sample.mass.ions[0].mz.toFixed(4)}`;
      node.frame.setAttribute('aria-label', `${sample.analyte.name}, ${index + 1} of ${samples.length}`);
      node.frame.setAttribute('aria-live', wanted ? 'off' : 'polite');
      node.counter.textContent = `${String(index + 1).padStart(2, '0')} / ${String(samples.length).padStart(2, '0')}`;
      node.live.textContent = announce ? `${sample.analyte.name}, run ${index + 1} of ${samples.length}. Both method views updated.` : '';
    }
  }
  function schedule() {
    if (timer !== null) { scheduler.clearTimeout(timer); timer = null; }
    for (const node of nodes) { node.play.textContent = wanted ? 'Pause rotation' : 'Start rotation'; node.frame.setAttribute('aria-live', 'off'); }
    if (eligible()) timer = scheduler.setTimeout(() => { timer = null; if (eligible()) { index = (index + 1) % samples.length; paint(); } schedule(); }, ROTATION_MS);
  }
  const change = direction => { wanted = false; index = (index + direction + samples.length) % samples.length; paint(true); schedule(); };
  for (const node of nodes) {
    // Pointer focus pauses first; retain the rotation action the pointer selected.
    let pointerIntent = null;
    listen(node.play, 'pointerdown', () => { pointerIntent = !wanted; });
    listen(node.play, 'pointercancel', () => { pointerIntent = null; });
    listen(node.play, 'click', event => { wanted = event.detail > 0 && pointerIntent !== null ? pointerIntent : !wanted; pointerIntent = null; schedule(); });
    listen(node.previous, 'click', () => change(-1)); listen(node.next, 'click', () => change(1));
    listen(node.figure, 'focusin', () => { wanted = false; schedule(); });
    listen(node.figure, 'pointerenter', () => { hovering.add(node.figure); schedule(); });
    listen(node.figure, 'pointerleave', () => { hovering.delete(node.figure); schedule(); });
  }
  listen(document, 'visibilitychange', schedule);
  const onMotion = event => { if (event.matches) wanted = false; schedule(); };
  if (media?.addEventListener) listen(media, 'change', onMotion);
  else if (media?.addListener) { media.addListener(onMotion); cleanups.push(() => media.removeListener(onMotion)); }
  if (canObserve) {
    const intersection = new IO(entries => { for (const entry of entries) { if (entry.isIntersecting) intersecting.add(entry.target); else intersecting.delete(entry.target); } schedule(); });
    figures.forEach(figure => intersection.observe(figure)); observers.push(intersection);
    const mutation = new MO(schedule); mutation.observe(root, { attributes: true, attributeFilter: ['hidden'] }); observers.push(mutation);
    const resize = new RO(() => paint()); nodes.forEach(node => resize.observe(node.plot)); observers.push(resize);
  }
  paint();
  for (const node of nodes) { node.controls.hidden = false; for (const control of [node.play, node.previous, node.next]) control.disabled = false; }
  schedule();
  const controller = Object.freeze({ getState: () => ({ index, wanted, timerActive: timer !== null, sample: samples[index] }), destroy() { if (destroyed) return; destroyed = true; if (timer !== null) scheduler.clearTimeout(timer); timer = null; cleanups.forEach(cleanup => cleanup()); observers.forEach(observer => observer.disconnect()); for (const node of nodes) { node.controls.hidden = true; for (const control of [node.play, node.previous, node.next]) control.disabled = true; } bindings.delete(root); } });
  bindings.set(root, controller);
  return controller;
}
