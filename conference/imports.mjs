import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, open, rename, rm, readdir, realpath, stat, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PYTHON } from './store.mjs';
import { IMPORT_LIMITS, importChunkRoute } from './import-limits.mjs';
import { previewIndex, savedRows } from './import-match.mjs';

const nonce = () => randomBytes(16).toString('hex');
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const problem = (status, message) => Object.assign(new Error(message), { status });
const failure = () => problem(400, 'Import could not be completed. The current customer catalog is unchanged.');
export function importPath(value) {
  if (typeof value === 'string') value = value.normalize('NFKC');
  if (typeof value !== 'string' || !value || value.length > 512 || /^[a-z]:|^\//i.test(value) || /[\\\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw problem(400, 'Use a safe relative file path.');
  return value;
}
function optionsOnly(input, names) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !names.includes(key))) throw problem(400, 'Invalid import options.');
}
async function boundedJSON(filename, limit) {
  const info = await stat(filename); if (!info.isFile() || info.size > limit || info.size < 1) throw failure();
  return JSON.parse(await readFile(filename, 'utf8'));
}

export async function createImports({ store, customers, clock = Date.now, parserTimeout = 30000, python = process.env.ASSAYNOVA_PYTHON || (process.platform === 'win32' ? PYTHON : 'python3') } = {}) {
  const root = path.join(path.resolve(store), 'customer-imports'), staging = path.join(root, 'staging'), revisions = path.join(root, 'revisions');
  await Promise.all([staging, revisions].map(folder => mkdir(folder, { recursive: true })));
  const base = await realpath(store), importsRoot = await realpath(root), revisionRoot = await realpath(revisions);
  if (path.dirname(importsRoot) !== base || path.basename(importsRoot) !== 'customer-imports' || path.dirname(revisionRoot) !== importsRoot || path.basename(revisionRoot) !== 'revisions') throw failure();
  const stagingRoot = await realpath(staging), jobs = new Map(); let parsing = false;
  if (path.dirname(stagingRoot) !== importsRoot || path.basename(stagingRoot) !== 'staging') throw failure();
  const stage = id => path.join(stagingRoot, id);
  async function safeStage(id) {
    if (!validId(id)) throw problem(404, 'Import job is unavailable or expired.');
    const folder = await realpath(stage(id));
    if (path.dirname(folder) !== stagingRoot || path.basename(folder) !== id) throw failure();
    return folder;
  }
  async function removeStage(id) {
    try { await rm(await safeStage(id), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function rawFile(job, file) {
    const folder = await safeStage(job.id), filename = await realpath(path.join(folder, file.id + '.raw'));
    if (path.dirname(filename) !== folder || path.basename(filename) !== file.id + '.raw') throw failure();
    return filename;
  }
  async function persist(job) {
    const folder = await safeStage(job.id), temporary = path.join(folder, nonce() + '.json');
    const data = JSON.stringify({ id: job.id, target: job.target, touched: job.touched, files: job.files });
    try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await rename(temporary, path.join(folder, 'job.json')); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  const describe = job => ({ id: job.id, target: job.target.customerId ? { customerId: job.target.customerId, name: job.target.name } : { name: job.target.name }, files: job.files.map(({ id, kind, path, size, offset }) => ({ id, kind, path, size, offset })), expiresAt: job.touched + IMPORT_LIMITS.idleMs });
  async function cleanup() {
    for (const job of jobs.values()) if (clock() - job.touched >= IMPORT_LIMITS.idleMs && ['idle', 'complete', 'orphan'].includes(job.phase)) {
      job.phase = 'cleaning';
      try { await removeStage(job.id); jobs.delete(job.id); } catch { job.phase = 'idle'; }
    }
  }
  for (const entry of await readdir(stagingRoot, { withFileTypes: true })) if (entry.isDirectory() && validId(entry.name)) {
    try {
      const folder = await safeStage(entry.name), data = await boundedJSON(path.join(folder, 'job.json'), 1024 * 1024);
      if (Object.keys(data).sort().join(',') !== 'files,id,target,touched' || data.id !== entry.name || !Array.isArray(data.files) || data.files.length > 501 || !Number.isFinite(data.touched) || !data.target || typeof data.target.name !== 'string' || !data.target.name.trim() || data.target.name.length > 64 || /[^\x20-\x7e]/.test(data.target.name) || (data.target.customerId ? !/^[a-f0-9]{20}$/.test(data.target.customerId) || !/^[a-f0-9]{64}$/.test(data.target.fingerprint || '') || Object.keys(data.target).sort().join(',') !== 'customerId,fingerprint,name' : Object.keys(data.target).join(',') !== 'name')) throw failure();
      if (data.files.filter(file => file.kind === 'image').length > IMPORT_LIMITS.images || data.files.filter(file => file.kind === 'image').reduce((sum, file) => sum + file.size, 0) > IMPORT_LIMITS.folder || data.files.filter(file => file.kind === 'sheet').length > 1) throw failure();
      const used = new Set(), paths = new Set();
      for (const file of data.files) {
        if (Object.keys(file).sort().join(',') !== 'id,kind,offset,path,size' || !validId(file.id) || used.has(file.id) || !['image', 'sheet'].includes(file.kind) || importPath(file.path) !== file.path || paths.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > IMPORT_LIMITS.file || !Number.isSafeInteger(file.offset) || file.offset < 0 || file.offset > file.size || (await stat(await rawFile(data, file))).size !== file.offset) throw failure();
        used.add(file.id); paths.add(file.path.toLowerCase());
      }
      jobs.set(data.id, { ...data, phase: 'idle' });
    } catch { const info = await stat(stage(entry.name)); jobs.set(entry.name, { id: entry.name, touched: info.mtimeMs, phase: 'orphan' }); }
  }
  await cleanup();
  async function critical(id, phase, operation) {
    const job = jobs.get(id);
    if (!job || job.phase === 'orphan') throw problem(404, 'Import job is unavailable or expired.');
    if (job.phase !== 'idle') throw problem(409, 'Import is busy. Wait for the current operation.');
    if (clock() - job.touched >= IMPORT_LIMITS.idleMs) { await cleanup(); throw problem(404, 'Import job is unavailable or expired.'); }
    job.phase = phase; job.touched = clock();
    try { await safeStage(job.id); return await operation(job); }
    finally { if (job.phase === phase) { job.phase = 'idle'; job.touched = clock(); } }
  }
  async function create(input) {
    optionsOnly(input, ['customerId', 'name']);
    if (Object.keys(input).length !== 1 || Boolean(input.customerId) === Boolean(input.name)) throw problem(400, 'Choose the current customer or enter a new customer name.');
    let target;
    if (input.customerId) { const snapshot = await customers.snapshot(input.customerId); target = { customerId: input.customerId, name: snapshot.customer.name, fingerprint: snapshot.fingerprint }; }
    else {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 64 || /[^\x20-\x7e]/.test(input.name)) throw problem(400, 'Use a customer name with 1 to 64 printable ASCII characters.');
      if ((await customers.list()).some(row => row.name.toLowerCase() === input.name.trim().toLowerCase())) throw problem(409, 'A customer with that name already exists.');
      target = { name: input.name.trim() };
    }
    await cleanup();
    const completed = [...jobs.values()].filter(job => job.phase === 'complete').sort((a, b) => a.touched - b.touched);
    while (completed.length > 32) jobs.delete(completed.shift().id);
    if ([...jobs.values()].filter(job => job.phase !== 'complete').length >= IMPORT_LIMITS.jobs) throw problem(409, 'Four imports are already pending. Cancel one or wait for expiry.');
    const job = { id: nonce(), target, files: [], touched: clock(), phase: 'creating' }; jobs.set(job.id, job);
    try { await mkdir(stage(job.id)); await persist(job); job.phase = 'idle'; return describe(job); }
    catch { jobs.delete(job.id); await removeStage(job.id).catch(() => {}); throw failure(); }
  }
  const register = (id, input) => critical(id, 'registering', async job => {
    optionsOnly(input, ['kind', 'path', 'size']);
    const filename = importPath(input.path);
    if (!['image', 'sheet'].includes(input.kind) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > IMPORT_LIMITS.file) throw problem(400, 'Files must be between 1 byte and 8 MiB.');
    if (job.files.some(file => file.path.toLowerCase() === filename.toLowerCase())) throw problem(409, 'That relative file path is already registered.');
    if (input.kind === 'sheet' && (job.files.some(file => file.kind === 'sheet') || !/\.(xlsx|csv|tsv)$/i.test(filename))) throw problem(400, 'Choose one XLSX, CSV or TSV table.');
    if (input.kind === 'image' && (!/\.(png|jpe?g|webp)$/i.test(filename) || job.files.filter(file => file.kind === 'image').length >= IMPORT_LIMITS.images || job.files.filter(file => file.kind === 'image').reduce((sum, file) => sum + file.size, input.size) > IMPORT_LIMITS.folder)) throw problem(400, 'Use at most 500 PNG/JPEG/WebP images and 512 MiB per folder.');
    const file = { id: nonce(), kind: input.kind, path: filename, size: input.size, offset: 0 };
    await writeFile(path.join(await safeStage(job.id), file.id + '.raw'), '', { flag: 'wx', mode: 0o600 });
    job.files.push(file); job.preview = null; job.prepared = null;
    try { await persist(job); } catch { job.files.pop(); throw failure(); }
    return { ...file };
  });
  const put = request => {
    const route = importChunkRoute(request.method, request.url);
    if (!route) throw problem(400, 'Use an exact upload chunk URL and offset.');
    return critical(route.jobId, 'uploading', async job => {
      if (request.headers['content-type'] !== 'application/octet-stream') throw problem(415, 'Use application/octet-stream for upload chunks.');
      const file = job.files.find(file => file.id === route.fileId);
      if (!file || route.offset !== file.offset) throw problem(409, 'Upload offset does not match. Start the file again.');
      const chunks = []; let length = 0, oversized = false;
      try {
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          length += chunk.length;
          if (length > IMPORT_LIMITS.chunk || file.offset + length > file.size) { oversized = true; break; }
          chunks.push(chunk);
        }
      } catch (error) { throw error.status ? error : problem(400, 'Upload was interrupted; no chunk was appended.'); }
      if (oversized) { request.resume(); throw problem(413, 'Upload chunk exceeds its allowed size.'); }
      if (!length || request.aborted || request.complete === false) throw problem(400, 'Upload was interrupted; no chunk was appended.');
      const handle = await open(await rawFile(job, file), 'r+'), previous = file.offset;
      try {
        if ((await handle.stat()).size !== previous) throw failure();
        const bytes = Buffer.concat(chunks, length); let written = 0;
        while (written < length) { const result = await handle.write(bytes, written, length - written, previous + written); if (!result.bytesWritten) throw failure(); written += result.bytesWritten; }
        await handle.sync(); file.offset += length; job.preview = null; job.prepared = null; await persist(job);
      } catch (error) { file.offset = previous; await handle.truncate(previous); throw error.status ? error : failure(); }
      finally { await handle.close(); }
      return { offset: file.offset, complete: file.offset === file.size };
    });
  };
  async function parse(job, input) {
    if (parsing) throw problem(409, 'Another import is being parsed. Try again shortly.');
    parsing = true;
    let requestFile, output;
    try {
      const folder = await safeStage(job.id), id = nonce(); requestFile = path.join(folder, id + '-request.json'); output = path.join(folder, id + '-result.json');
      await writeFile(requestFile, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
      await new Promise((resolve, reject) => {
        const child = spawn(python, ['-B', fileURLToPath(new URL('./import_parser.py', import.meta.url)), '--request', requestFile, '--output', output], { windowsHide: true, stdio: 'ignore' });
        let settled = false;
        const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
        const timer = setTimeout(() => { child.kill(); finish(problem(400, 'Import parsing timed out.')); }, parserTimeout);
        child.once('error', () => finish(failure())); child.once('exit', code => finish(code === 0 ? null : failure()));
      });
      const result = await boundedJSON(output, 16 * 1024 * 1024);
      if (result.error) throw problem(400, result.error);
      return result;
    } finally { parsing = false; await Promise.all([requestFile, output].filter(Boolean).map(file => rm(file, { force: true }).catch(() => {}))); }
  }
  async function tableInput(job, input, action) {
    optionsOnly(input, ['sheet', 'headerRow', ...(action === 'table' ? ['columns'] : [])]);
    const file = job.files.find(file => file.kind === 'sheet');
    if (!file || file.offset !== file.size) throw problem(400, 'Upload a complete table first.');
    return { ...input, action, input: await rawFile(job, file), format: file.path.split('.').at(-1).toLowerCase() };
  }
  const inspect = (id, input) => critical(id, 'inspecting', async job => parse(job, await tableInput(job, input, 'inspect')));
  const preview = (id, input) => critical(id, 'previewing', async job => {
    job.preview = null; job.prepared = null;
    if (!job.files.length || job.files.some(file => file.offset !== file.size)) throw problem(400, 'Finish uploading every file before preview.');
    let existing = [];
    if (job.target.customerId) { try { existing = (await customers.scan(job.target.customerId)).products; } catch {} }
    const table = job.files.find(file => file.kind === 'sheet'), rawImages = job.files.filter(file => file.kind === 'image');
    const rows = table ? (await parse(job, await tableInput(job, input, 'table'))).rows : savedRows(existing);
    if (!table) optionsOnly(input, []);
    let images = [];
    if (rawImages.length) {
      const destination = path.join(await safeStage(job.id), 'normalized'); await mkdir(destination, { recursive: true });
      const canonical = await realpath(destination);
      if (path.dirname(canonical) !== await safeStage(job.id) || path.basename(canonical) !== 'normalized') throw failure();
      images = (await parse(job, { action: 'images', outputDirectory: canonical, files: await Promise.all(rawImages.map(async file => ({ id: file.id, input: await rawFile(job, file), name: file.path }))) })).images;
    }
    const value = previewIndex(rows, images, existing, rawImages.length > 0); job.preview = value;
    return { rows: value.rows, imageRows: value.imageRows, counts: value.counts, blocking: value.blocking, canConfirm: !value.blocking && value.aliases.length > 0 && (!rawImages.length || value.products.length > 0) };
  });
  async function durableJSON(filename, value) {
    const handle = await open(filename, 'wx', 0o600); try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  }
  async function confirm(id) {
    const previous = jobs.get(id); if (previous?.phase === 'complete') return previous.result;
    return critical(id, 'committing', async job => {
      const preview = job.preview, folder = job.files.some(file => file.kind === 'image');
      if (!preview || preview.blocking || !preview.aliases.length || (folder && !preview.products.length)) throw problem(400, 'Preview valid matches before confirming.');
      if (!job.prepared) {
        const revision = nonce(), destination = path.join(revisions, revision); await mkdir(destination);
        if (folder) {
          await mkdir(path.join(destination, 'images'));
          for (const product of preview.products) {
            if (!/^[a-f0-9]{32}\.png$/.test(product.preparedFile)) throw failure();
            const normalized = path.join(await safeStage(job.id), 'normalized'), source = await realpath(path.join(normalized, product.preparedFile));
            if (path.dirname(source) !== normalized) throw failure();
            await copyFile(source, path.join(destination, 'images', product.imageFile), constants.COPYFILE_EXCL);
            const handle = await open(path.join(destination, 'images', product.imageFile), 'r+'); try { await handle.sync(); } finally { await handle.close(); }
          }
          await durableJSON(path.join(destination, 'catalog.json'), { version: 1, products: preview.products.map(({ id, name, imageCode, imageFile, sha256 }) => ({ id, name, imageCode, imageFile, sha256 })) });
        }
        await durableJSON(path.join(destination, 'aliases.json'), { version: 1, aliases: preview.aliases }); job.prepared = revision;
      }
      const result = await customers.activate({ customerId: job.target.customerId, name: job.target.name, fingerprint: job.target.fingerprint, ...(folder ? { imageRevision: job.prepared } : {}), aliasRevision: job.prepared });
      job.result = result; job.phase = 'complete'; job.touched = clock(); await removeStage(job.id).catch(() => {}); return result;
    });
  }
  const cancel = id => critical(id, 'cancelling', async job => { await removeStage(job.id); job.phase = 'cancelled'; jobs.delete(id); return { ok: true }; });
  const timer = setInterval(() => { cleanup().catch(() => {}); }, 60000); timer.unref();
  return { create, register, put, inspect, preview, confirm, cancel, cleanup, close: () => clearInterval(timer) };
}
