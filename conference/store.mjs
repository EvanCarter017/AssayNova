import { mkdir, mkdtemp, writeFile, readFile, rename, rm, readdir, lstat, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdminOnlyReport, isReservedSampleCode, publicBundle, validCode } from './reader.mjs';

export const PYTHON = 'C:\\Users\\Administrator\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe';
export function validateFields(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['client','lot','received','reported','purity1','purity2'].includes(key))) throw new Error('Unsupported report fields.');
  const result = {};
  for (const key of ['client','lot']) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > (key === 'client' ? 64 : 40) || /[^\x20-\x7e]/.test(value)) throw new Error(key + ' must be short printable ASCII text.');
    result[key] = value.trim();
  }
  for (const key of ['received','reported']) {
    const value = input[key] || '';
    if (typeof value !== 'string' || (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value))) throw new Error('Use a valid ISO date.');
    result[key] = value;
  }
  if (result.received && result.reported && result.received > result.reported) throw new Error('Reported date must be on or after received date.');
  for (const key of ['purity1','purity2']) if (input[key] !== undefined && input[key] !== '') {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 99.05 || value > 99.95 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) throw new Error('Purity must be 99.05-99.95 with at most two decimal places.');
    result[key] = value;
  }
  return result;
}
export function validateComponents(value, original) {
  if (value === undefined) return original;
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error('Use one to four components.');
  return value.map(row => {
    if (!row || Object.keys(row).some(key => !['name','nominal','unit'].includes(key)) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 64 || /[^\x20-\x7e]/.test(row.name) || typeof row.nominal !== 'number' || !Number.isFinite(row.nominal) || row.nominal <= 0 || row.nominal > 100000 || !['mg','ml','IU'].includes(row.unit)) throw new Error('Invalid component name, nominal content or unit.');
    return { name: row.name.trim(), nominal: row.nominal, unit: row.unit };
  });
}
export async function runRenderer(requestPath, output, { python = process.env.ASSAYNOVA_PYTHON || (process.platform === 'win32' ? PYTHON : 'python3'), renderer = fileURLToPath(new URL('./render_report.py', import.meta.url)), timeout = 45000 } = {}) {
  await new Promise((resolve,reject) => {
    const child = spawn(python, ['-B', renderer, '--request', requestPath, '--output', output], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Report renderer timed out.')); }, timeout);
    child.stderr.on('data', bytes => { if (stderr.length < 2048) stderr += bytes.toString().slice(0,2048-stderr.length); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Report renderer could not start.')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Report renderer failed; no report was published.')); });
  });
}

export async function createStore(root, { render = runRenderer, codeFactory = () => { const value = randomBytes(4).toString('hex').toUpperCase(); return 'AN-' + value.slice(0,4) + '-' + value.slice(4); } } = {}) {
  root = path.resolve(root);
  const published = path.join(root, 'published'), previews = path.join(root, 'previews'), staging = path.join(root, 'staging'), removed = path.join(root, 'removed');
  await Promise.all([published, previews, staging, removed].map(directory => mkdir(directory,{recursive:true})));
  let busy = false;
  const fail = (status, message) => Object.assign(new Error(message), { status });
  async function exists(filename) {
    try { await lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function snapshot(directory, code) {
    const base = path.join(root, directory), folder = path.join(base, code);
    const rootPath = await realpath(root);
    const baseEntry = await lstat(base);
    if (!baseEntry.isDirectory() || baseEntry.isSymbolicLink() || await realpath(base) !== path.join(rootPath, directory)) throw fail(409, 'Report snapshot is unavailable.');
    async function check(filename) {
      const entry = await lstat(filename);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw fail(409, 'Report snapshot is unavailable.');
      if (entry.isDirectory()) for (const name of await readdir(filename)) await check(path.join(filename, name));
    }
    await check(folder);
    if (!(await lstat(folder)).isDirectory() || await realpath(folder) !== path.join(rootPath, directory, code)) throw fail(409, 'Report snapshot is unavailable.');
    for (const name of ['bundle.json', 'report.pdf', 'report.svg']) if (!(await lstat(path.join(folder, name))).isFile()) throw fail(409, 'Report snapshot is unavailable.');
    try { return publicBundle(JSON.parse(await readFile(path.join(folder, 'bundle.json'), 'utf8')), code); }
    catch { throw fail(409, 'Report snapshot is unavailable.'); }
  }
  async function changeState(code, state) {
    if (!validCode(code) || isReservedSampleCode(code)) throw fail(400, 'Choose a generated report Lookup Code.');
    if (busy) throw fail(409, 'Another report is being generated. Wait for it to finish.');
    busy = true;
    try {
      const from = state === 'removed' ? 'published' : 'removed', to = state;
      const source = path.join(root, from, code), destination = path.join(root, to, code);
      const [hasSource, hasDestination] = await Promise.all([exists(source), exists(destination)]);
      if (hasSource && hasDestination) throw fail(409, 'Report exists in both states. Ask the local owner to check it.');
      if (!hasSource && !hasDestination) throw fail(404, 'Generated report was not found.');
      const bundle = await snapshot(hasSource ? from : to, code);
      // Validate the destination parent too, including idempotent retries. Never overwrite a snapshot.
      const targetBase = path.join(root, to);
      const targetEntry = await lstat(targetBase);
      if (!targetEntry.isDirectory() || targetEntry.isSymbolicLink() || await realpath(targetBase) !== path.join(await realpath(root), to)) throw fail(409, 'Report snapshot is unavailable.');
      if (hasSource) await rename(source, destination);
      return { lookupCode: code, state, label: bundle.label, adminOnly: await isAdminOnlyReport(destination) };
    } finally { busy = false; }
  }
  async function generate(product, fields, publish) {
    if (busy) { const error = new Error('Another report is being generated. Wait for it to finish.'); error.status = 409; throw error; }
    busy = true;
    let job;
    try {
      let code;
      for (let attempt=0;attempt<10;attempt++) {
        const candidate = codeFactory();
        if (!validCode(candidate) || isReservedSampleCode(candidate)) continue;
        const reserved = await Promise.all([published,previews,removed].map(dir => exists(path.join(dir,candidate))));
        if (!reserved.some(Boolean)) { code = candidate; break; }
      }
      if (!code) throw new Error('Could not allocate a unique Lookup Code.');
      job = await mkdtemp(path.join(staging,'job-'));
      const request = { lookupCode: code, seed: randomBytes(24).toString('hex'), product, fields };
      const requestPath = path.join(job,'request.json'), output = path.join(job,'output');
      await mkdir(output);
      await writeFile(requestPath, JSON.stringify(request), {flag:'wx'});
      await render(requestPath, output);
      const [raw, pdf, svg] = await Promise.all(['bundle.json','report.pdf','report.svg'].map(name => readFile(path.join(output,name))));
      if (pdf.subarray(0,5).toString() !== '%PDF-' || !svg.toString().includes('<svg')) throw new Error('Incomplete renderer output.');
      const bundle = publicBundle(JSON.parse(raw), code);
      await writeFile(path.join(output,'bundle.json'), JSON.stringify({report:bundle.report,record:bundle.record,label:bundle.label}));
      await writeFile(path.join(output,'private.json'), JSON.stringify({synthetic:true, purpose:'temporary private report studio', seed:request.seed, productId:product.id, createdAt:new Date().toISOString(), fields}));
      const destination = path.join(publish ? published : previews,code);
      // Only this process writes the store. A directory rename exposes the complete snapshot at once.
      await rename(output,destination);
      return { ...bundle, published:publish, adminOnly: true, previewURL:'/bundles/' + (publish ? 'published/' : 'previews/') + code + '/report.svg', pdfURL:'/bundles/' + (publish ? 'published/' : 'previews/') + code + '/report.pdf' };
    } finally { busy = false; if (job) await rm(job,{recursive:true,force:true}); }
  }
  async function preview(product, fields, { seed, deadline = Date.now() + 60000 } = {}) {
    if (typeof seed !== 'string' || !/^[a-f0-9]{48}$/i.test(seed)) throw fail(400, 'Use a valid preview seed.');
    if (busy) throw fail(409, 'Another report is being generated. Wait for it to finish.');
    busy = true;
    let job;
    try {
      const stagingRoot = await realpath(staging);
      if ((await lstat(staging)).isSymbolicLink() || stagingRoot !== path.join(await realpath(root), 'staging')) throw fail(409, 'Report staging is unavailable.');
      job = await mkdtemp(path.join(staging, 'preview-'));
      const code = 'AN-PREV-IEW0', requestPath = path.join(job, 'request.json'), output = path.join(job, 'output');
      await mkdir(output);
      await writeFile(requestPath, JSON.stringify({ lookupCode: code, seed: seed.toLowerCase(), product, fields }), { flag: 'wx' });
      const timeout = Math.min(45000, deadline - Date.now() - 1000);
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Report renderer timed out.');
      await render(requestPath, output, { timeout });
      if (Date.now() >= deadline) throw new Error('Report renderer timed out.');
      const [raw, pdf, svg] = await Promise.all(['bundle.json', 'report.pdf', 'report.svg'].map(name => readFile(path.join(output, name))));
      if (pdf.subarray(0, 5).toString() !== '%PDF-' || !svg.toString().includes('<svg')) throw new Error('Incomplete renderer output.');
      const bundle = publicBundle(JSON.parse(raw), code);
      return { label: bundle.label, svg: svg.toString() };
    } finally {
      try {
        if (job) {
          const stagingRoot = await realpath(staging), owned = await realpath(job), relative = path.relative(stagingRoot, owned);
          if ((await lstat(staging)).isSymbolicLink() || stagingRoot !== path.join(await realpath(root), 'staging') || (await lstat(job)).isSymbolicLink() || !relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(owned) !== stagingRoot) throw fail(409, 'Report staging is unavailable.');
          await rm(owned, { recursive: true, force: true });
        }
      } finally { busy = false; }
    }
  }
  async function history(state = 'published') {
    if (!['published', 'removed'].includes(state)) throw fail(400, 'Choose Published or Removed reports.');
    const rows = [];
    for (const code of await readdir(path.join(root, state))) if (validCode(code)) {
      try { const bundle = await snapshot(state, code); rows.push({lookupCode:code,label:bundle.label,reported:bundle.report.issued,adminOnly:await isAdminOnlyReport(path.join(root,state,code))}); } catch {}
    }
    return rows.sort((a,b) => b.reported.localeCompare(a.reported)).slice(0,100);
  }
  return { generate, preview, history, remove: code => changeState(code, 'removed'), restore: code => changeState(code, 'published'), get busy(){return busy;}, root };
}
