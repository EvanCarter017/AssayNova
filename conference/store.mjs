import { mkdir, mkdtemp, writeFile, readFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicBundle, validCode } from './reader.mjs';

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
export async function runRenderer(requestPath, output, { python = PYTHON, renderer = fileURLToPath(new URL('./render_report.py', import.meta.url)), timeout = 45000 } = {}) {
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
  const published = path.join(root, 'published'), previews = path.join(root, 'previews'), staging = path.join(root, 'staging');
  await Promise.all([published, previews, staging].map(directory => mkdir(directory,{recursive:true})));
  let busy = false;
  async function generate(product, fields, publish) {
    if (busy) { const error = new Error('Another report is being generated. Wait for it to finish.'); error.status = 409; throw error; }
    busy = true;
    let job;
    try {
      let code;
      for (let attempt=0;attempt<10;attempt++) {
        const candidate = codeFactory();
        if (!validCode(candidate) || ['AN-7K9Q-2M4X','AN-8P6R-3N5Y'].includes(candidate)) continue;
        const exists = await Promise.all([published,previews].map(dir => stat(path.join(dir,candidate)).then(()=>true,()=>false)));
        if (!exists.some(Boolean)) { code = candidate; break; }
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
      return { ...bundle, published:publish, previewURL:'/bundles/' + (publish ? 'published/' : 'previews/') + code + '/report.svg', pdfURL:'/bundles/' + (publish ? 'published/' : 'previews/') + code + '/report.pdf' };
    } finally { busy = false; if (job) await rm(job,{recursive:true,force:true}); }
  }
  async function history() {
    const rows = [];
    for (const code of await readdir(published)) if (validCode(code)) {
      try { const bundle = publicBundle(JSON.parse(await readFile(path.join(published,code,'bundle.json'),'utf8')),code); rows.push({lookupCode:code,label:bundle.label,reported:bundle.report.issued}); } catch {}
    }
    return rows.sort((a,b) => b.reported.localeCompare(a.reported)).slice(0,100);
  }
  return { generate, history, get busy(){return busy;}, root };
}
