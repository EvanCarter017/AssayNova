import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, open, rename, rm, readdir, realpath, stat, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PYTHON } from './store.mjs';
import { IMPORT_LIMITS, importChunkRoute } from './import-limits.mjs';
import { codeKey, productIdentity } from './import-match.mjs';
import { makeEntries, recordsDTO, readCatalogRecords, writeCatalogRecords, legacyRecords, applyCorrection, assetId, entryId } from './catalog-records.mjs';

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
  const root = path.join(path.resolve(store), 'customer-imports'), staging = path.join(root, 'staging'), revisions = path.join(root, 'revisions'), receipts = path.join(root, 'receipts');
  await Promise.all([staging, revisions, receipts].map(folder => mkdir(folder, { recursive: true })));
  const base = await realpath(store), importsRoot = await realpath(root), revisionRoot = await realpath(revisions);
  if (path.dirname(importsRoot) !== base || path.basename(importsRoot) !== 'customer-imports' || path.dirname(revisionRoot) !== importsRoot || path.basename(revisionRoot) !== 'revisions') throw failure();
  const stagingRoot = await realpath(staging), receiptRoot = await realpath(receipts), jobs = new Map(), activeCorrections = new Set(), creatingIntents = new Map(); let parsing = false;
  if (path.dirname(stagingRoot) !== importsRoot || path.basename(stagingRoot) !== 'staging' || path.dirname(receiptRoot) !== importsRoot || path.basename(receiptRoot) !== 'receipts') throw failure();
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
    const data = JSON.stringify({ version: 2, id: job.id, target: job.target, touched: job.touched, files: job.files,
      purpose: job.purpose || 'import', preallocatedCustomerId: job.preallocatedCustomerId,
      entryId: job.entryId ?? null, expectedRevision: job.expectedRevision ?? null,
      uploadIntent: job.uploadIntent ?? null,
      mapping: job.mapping ?? null, previewId: job.previewId ?? null, candidateRevision: job.candidateRevision ?? null, commit: job.commit ?? null });
    let handle;
    try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null; await rename(temporary, path.join(folder, 'job.json')); }
    finally { await handle?.close(); await rm(temporary, { force: true }).catch(() => {}); }
  }
  const fileCounts = job => ({ images: job.files.filter(file => file.kind === 'image').length, sheets: job.files.filter(file => file.kind === 'sheet').length });
  const summary = job => ({ id: job.id, customerId: job.target.customerId ?? null, name: job.target.name, purpose: job.purpose || 'import', phase: job.phase,
    updatedAt: job.touched, expiresAt: job.touched + IMPORT_LIMITS.idleMs, files: fileCounts(job), mapping: job.mapping ?? null, previewId: job.previewId ?? null });
  const describe = job => ({ ...summary(job), target: job.target.customerId ? { customerId: job.target.customerId, name: job.target.name } : { name: job.target.name },
    fileCounts: fileCounts(job), files: job.files.map(({ id, kind, path, size, offset }) => ({ id, kind, path, size, offset })) });
  async function cleanup() {
    for (const job of jobs.values()) if (clock() - job.touched >= IMPORT_LIMITS.idleMs && ['idle', 'complete', 'orphan'].includes(job.phase)) {
      job.phase = 'cleaning';
      try { await removeStage(job.id); jobs.delete(job.id); } catch { job.phase = 'idle'; }
    }
  }
  for (const entry of await readdir(stagingRoot, { withFileTypes: true })) if (entry.isDirectory() && validId(entry.name)) {
    try {
      const folder = await safeStage(entry.name), data = await boundedJSON(path.join(folder, 'job.json'), 2 * 1024 * 1024);
      const legacy = data.version === undefined;
      if ((legacy ? Object.keys(data).sort().join(',') !== 'files,id,target,touched' : data.version !== 2 || Object.keys(data).some(key => !['version','id','target','touched','files','purpose','preallocatedCustomerId','entryId','expectedRevision','uploadIntent','mapping','previewId','candidateRevision','commit'].includes(key))) || data.id !== entry.name || !Array.isArray(data.files) || data.files.length > 501 || !Number.isFinite(data.touched) || !data.target || typeof data.target.name !== 'string' || !data.target.name.trim() || data.target.name.length > 64 || /[^\x20-\x7e]/.test(data.target.name) || (data.target.customerId ? !/^[a-f0-9]{20}$/.test(data.target.customerId) || !/^[a-f0-9]{64}$/.test(data.target.fingerprint || '') || Object.keys(data.target).sort().join(',') !== 'customerId,fingerprint,name' : Object.keys(data.target).join(',') !== 'name')) throw failure();
      if (data.files.filter(file => file.kind === 'image').length > IMPORT_LIMITS.images || data.files.filter(file => file.kind === 'image').reduce((sum, file) => sum + file.size, 0) > IMPORT_LIMITS.folder || data.files.filter(file => file.kind === 'sheet').length > 1) throw failure();
      const used = new Set(), paths = new Set();
      for (const file of data.files) {
        if (Object.keys(file).sort().join(',') !== 'id,kind,offset,path,size' || !validId(file.id) || used.has(file.id) || !['image', 'sheet'].includes(file.kind) || importPath(file.path) !== file.path || paths.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > IMPORT_LIMITS.file || !Number.isSafeInteger(file.offset) || file.offset < 0 || file.offset > file.size || (await stat(await rawFile(data, file))).size !== file.offset) throw failure();
        used.add(file.id); paths.add(file.path.toLowerCase());
      }
      if (!legacy && (!['import', 'correction'].includes(data.purpose) || !entryId(data.preallocatedCustomerId) || (data.purpose === 'correction' && (!entryId(data.entryId) || !assetId(data.expectedRevision))) || (data.previewId !== null && !assetId(data.previewId)) || (data.candidateRevision !== null && !assetId(data.candidateRevision)) || (data.commit !== null && (!data.commit || Object.keys(data.commit).sort().join(',') !== 'customerId,isNew,previewId,revision' || !entryId(data.commit.customerId) || !assetId(data.commit.previewId) || !assetId(data.commit.revision) || typeof data.commit.isNew !== 'boolean')))) throw failure();
      if (!legacy) {
        if (data.uploadIntent != null && (!assetId(data.uploadIntent) || data.purpose !== 'correction')) throw failure();
        if (Boolean(data.previewId) !== Boolean(data.candidateRevision) || data.target.customerId && data.preallocatedCustomerId !== data.target.customerId || data.purpose === 'correction' && (!data.target.customerId || data.files.length > 1 || data.files.some(file => file.kind !== 'image')) || data.purpose === 'import' && (data.entryId !== null || data.expectedRevision !== null)) throw failure();
        if (data.mapping !== null && (!data.mapping || Object.keys(data.mapping).sort().join(',') !== 'columns,headerRow,sheet' || typeof data.mapping.sheet !== 'string' || data.mapping.sheet.length > 128 || !Number.isSafeInteger(data.mapping.headerRow) || data.mapping.headerRow < 1 || data.mapping.headerRow > 10000 || !data.mapping.columns || Object.keys(data.mapping.columns).some(key => !['sku','product','dose'].includes(key)) || !['sku','product'].every(key => typeof data.mapping.columns[key] === 'string' && /^[A-Z]{1,3}$/.test(data.mapping.columns[key])) || Object.hasOwn(data.mapping.columns, 'dose') && !/^[A-Z]{1,3}$/.test(data.mapping.columns.dose))) throw failure();
        if (data.commit && (data.commit.customerId !== data.preallocatedCustomerId || data.commit.previewId !== data.previewId || data.commit.revision !== data.candidateRevision || data.commit.isNew !== !data.target.customerId)) throw failure();
      }
      jobs.set(data.id, { ...data, purpose: data.purpose || 'import', preallocatedCustomerId: data.preallocatedCustomerId || data.target.customerId || randomBytes(10).toString('hex'), phase: 'idle' });
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
    finally { if (job.phase === phase) { job.phase = 'idle'; job.touched = clock(); await persist(job); } }
  }
  const intentFile = id => path.join(receiptRoot, 'upload-intent-' + id + '.json');
  async function savedIntent(input) {
    if (!input.uploadIntent) return null;
    let saved;
    try { saved = await boundedJSON(intentFile(input.uploadIntent), 8192); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const pending = [...jobs.values()].find(job => job.uploadIntent === input.uploadIntent);
    if (saved) {
      if (Object.keys(saved).sort().join(',') !== 'customerId,entryId,expectedRevision,jobId,uploadIntent' || saved.uploadIntent !== input.uploadIntent || !assetId(saved.jobId) || !entryId(saved.customerId) || !entryId(saved.entryId) || !assetId(saved.expectedRevision)) throw failure();
    } else if (pending) saved = { uploadIntent: input.uploadIntent, jobId: pending.id, customerId: pending.target.customerId, entryId: pending.entryId, expectedRevision: pending.expectedRevision };
    if (!saved) return null;
    if (saved.customerId !== input.customerId || saved.entryId !== input.entryId || saved.expectedRevision !== input.expectedRevision) throw problem(409, 'Upload intent belongs to a different correction.');
    const job = jobs.get(saved.jobId);
    if (!job || job.purpose !== 'correction' || job.uploadIntent !== input.uploadIntent || job.target.customerId !== saved.customerId || job.entryId !== saved.entryId || job.expectedRevision !== saved.expectedRevision || ['complete','cancelled','orphan'].includes(job.phase) || clock() - job.touched >= IMPORT_LIMITS.idleMs) throw problem(409, 'Correction upload is unavailable. Choose the image again.');
    if (job.phase !== 'idle') throw problem(409, 'Import is busy. Wait for the current operation.');
    job.touched = clock(); await persist(job); await durableJSON(intentFile(input.uploadIntent), saved); return describe(job);
  }
  async function createJob(input) {
    const correction = input?.purpose === 'correction';
    optionsOnly(input, correction ? ['purpose', 'customerId', 'entryId', 'expectedRevision', 'uploadIntent'] : ['customerId', 'name']);
    if (correction && (!entryId(input.customerId) || !entryId(input.entryId) || !assetId(input.expectedRevision) || Object.hasOwn(input, 'uploadIntent') && !assetId(input.uploadIntent))) throw problem(400, 'Choose an entry and the current catalog revision.');
    if (!correction && (Object.keys(input).length !== 1 || Boolean(input.customerId) === Boolean(input.name))) throw problem(400, 'Choose the current customer or enter a new customer name.');
    const replay = correction ? await savedIntent(input) : null; if (replay) return replay;
    let target;
    if (input.customerId) { const snapshot = await customers.snapshot(input.customerId); target = { customerId: input.customerId, name: snapshot.customer.name, fingerprint: snapshot.fingerprint };
      if (correction) { const catalog = await customers.scan(input.customerId); if (catalog.customer.catalogRevision !== input.expectedRevision) throw problem(409, 'Catalog changed. Reload products before saving corrections.'); if (!catalog.entries?.some(entry => entry.id === input.entryId)) throw problem(404, 'Catalog entry is unavailable.'); } }
    else {
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 64 || /[^\x20-\x7e]/.test(input.name)) throw problem(400, 'Use a customer name with 1 to 64 printable ASCII characters.');
      if ((await customers.list()).some(row => row.name.toLowerCase() === input.name.trim().toLowerCase())) throw problem(409, 'A customer with that name already exists.');
      target = { name: input.name.trim() };
    }
    await cleanup();
    const completed = [...jobs.values()].filter(job => job.phase === 'complete').sort((a, b) => a.touched - b.touched);
    while (completed.length > 32) jobs.delete(completed.shift().id);
    if ([...jobs.values()].filter(job => job.phase !== 'complete').length >= IMPORT_LIMITS.jobs) throw problem(409, 'Four imports are already pending. Cancel one or wait for expiry.');
    const job = { id: nonce(), target, files: [], touched: clock(), phase: 'creating', purpose: correction ? 'correction' : 'import', preallocatedCustomerId: target.customerId || randomBytes(10).toString('hex'), ...(correction ? { entryId: input.entryId, expectedRevision: input.expectedRevision, uploadIntent: input.uploadIntent ?? null } : {}) }; jobs.set(job.id, job);
    try {
      await mkdir(stage(job.id)); await persist(job);
      if (job.uploadIntent) await durableJSON(intentFile(job.uploadIntent), { uploadIntent: job.uploadIntent, jobId: job.id, customerId: target.customerId, entryId: job.entryId, expectedRevision: job.expectedRevision });
      job.phase = 'idle'; return describe(job);
    }
    catch { jobs.delete(job.id); await removeStage(job.id).catch(() => {}); throw failure(); }
  }
  async function create(input) {
    if (input?.purpose !== 'correction' || !assetId(input.uploadIntent)) return createJob(input);
    optionsOnly(input, ['purpose', 'customerId', 'entryId', 'expectedRevision', 'uploadIntent']);
    const tuple = JSON.stringify([input.customerId, input.entryId, input.expectedRevision]), active = creatingIntents.get(input.uploadIntent);
    if (active) { if (active.tuple !== tuple) return Promise.reject(problem(409, 'Upload intent belongs to a different correction.')); return active.operation; }
    const operation = createJob(input).finally(() => creatingIntents.delete(input.uploadIntent));
    creatingIntents.set(input.uploadIntent, { tuple, operation }); return operation;
  }
  const register = (id, input) => critical(id, 'registering', async job => {
    if (job.commit) throw problem(409, 'Confirmation has started. Retry confirmation before changing this import.');
    optionsOnly(input, ['kind', 'path', 'size']);
    const filename = importPath(input.path);
    if (job.purpose === 'correction' && (input.kind !== 'image' || job.files.length)) throw problem(400, 'A correction upload accepts one product image.');
    if (!['image', 'sheet'].includes(input.kind) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > IMPORT_LIMITS.file) throw problem(400, 'Files must be between 1 byte and 8 MiB.');
    if (job.files.some(file => file.path.toLowerCase() === filename.toLowerCase())) throw problem(409, 'That relative file path is already registered.');
    if (input.kind === 'sheet' && (job.files.some(file => file.kind === 'sheet') || !/\.(xlsx|csv|tsv)$/i.test(filename))) throw problem(400, 'Choose one XLSX, CSV or TSV table.');
    if (input.kind === 'image' && (!/\.(png|jpe?g|webp)$/i.test(filename) || job.files.filter(file => file.kind === 'image').length >= IMPORT_LIMITS.images || job.files.filter(file => file.kind === 'image').reduce((sum, file) => sum + file.size, input.size) > IMPORT_LIMITS.folder)) throw problem(400, 'Use at most 500 PNG/JPEG/WebP images and 512 MiB per folder.');
    const file = { id: nonce(), kind: input.kind, path: filename, size: input.size, offset: 0 };
    await writeFile(path.join(await safeStage(job.id), file.id + '.raw'), '', { flag: 'wx', mode: 0o600 });
    job.files.push(file); job.previewId = null; job.candidateRevision = null;
    try { await persist(job); } catch { job.files.pop(); throw failure(); }
    return { ...file };
  });
  const put = request => {
    const route = importChunkRoute(request.method, request.url);
    if (!route) throw problem(400, 'Use an exact upload chunk URL and offset.');
    return critical(route.jobId, 'uploading', async job => {
      if (job.commit) throw problem(409, 'Confirmation has started. Retry confirmation before changing this import.');
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
        await handle.sync(); file.offset += length; job.previewId = null; job.candidateRevision = null; await persist(job);
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
  const inspect = (id, input) => critical(id, 'inspecting', async job => {
    if (job.purpose === 'correction') throw problem(400, 'Choose an image for the product correction.');
    return parse(job, await tableInput(job, input, 'inspect'));
  });
  async function normalizedImages(job, selected = job.files.filter(file => file.kind === 'image')) {
    if (!selected.length) return [];
    const destination = path.join(await safeStage(job.id), 'normalized'); await mkdir(destination, { recursive: true });
    const canonical = await realpath(destination); if (path.dirname(canonical) !== await safeStage(job.id) || path.basename(canonical) !== 'normalized') throw failure();
    const result = (await parse(job, { action: 'images', outputDirectory: canonical, files: await Promise.all(selected.map(async file => ({ id: file.id, input: await rawFile(job, file), name: file.path }))) })).images;
    return Promise.all(result.map(async image => ({ id: image.id, filename: image.name, sha256: image.sha256, bytes: (await stat(path.join(canonical, image.file))).size, path: path.join(canonical, image.file), immutable: false })));
  }
  const stripImage = ({ id, filename, sha256, bytes }) => ({ id, filename, sha256, bytes });
  async function previewResponse(job) {
    if (!job.candidateRevision || !job.previewId) return null;
    const catalog = await readCatalogRecords(store, job.candidateRevision);
    if (catalog.records.origin.importId !== job.id || catalog.records.origin.previewId !== job.previewId || catalog.records.origin.customerId !== job.preallocatedCustomerId) throw failure();
    const display = recordsDTO({ ...catalog, customer: { id: job.preallocatedCustomerId, catalogRevision: job.candidateRevision } });
    const used = new Set(catalog.entries.map(entry => entry.imageId).filter(Boolean));
    const imageRows = catalog.records.images.map(image => ({ id: image.id, path: image.filename, status: used.has(image.id) ? 'matched' : 'unmatched', reason: used.has(image.id) ? '' : 'Picture retained for manual assignment.' }));
    return { previewId: job.previewId, entries: display.entries, imageRows, counts: display.counts, imageCounts: { total: imageRows.length, unmatched: imageRows.filter(row => row.status === 'unmatched').length }, canConfirm: display.counts.total > 0, confirmReason: display.counts.total ? '' : 'The mapped table contains no product rows.' };
  }
  const preview = (id, input) => critical(id, 'previewing', async job => {
    if (job.commit) throw problem(409, 'Confirmation has started. Retry confirmation before changing this import.');
    if (job.purpose === 'correction') throw problem(400, 'Save this image through the product correction.');
    if (!job.files.length || job.files.some(file => file.offset !== file.size)) throw problem(400, 'Finish uploading every file before preview.');
    const table = job.files.find(file => file.kind === 'sheet'), incoming = await normalizedImages(job);
    let existing;
    if (job.target.customerId) existing = await customers.scan(job.target.customerId);
    if (!table && !existing) throw problem(400, 'A new customer needs a SKU table.');
    if (!table) optionsOnly(input, []);
    const previewId = nonce(), origin = { importId: job.id, previewId, customerId: job.preallocatedCustomerId };
    let base = existing?.records ? { records: structuredClone(existing.records), sources: existing.sources } : existing ? await legacyRecords(existing, origin) : { records: { version: 2, entries: [], images: [], origin }, sources: [] };
    if (existing && !existing.records && base.sources.length) {
      const destination = path.join(await safeStage(job.id), 'legacy-normalized'); await mkdir(destination, { recursive: true });
      const canonical = await realpath(destination); if (path.dirname(canonical) !== await safeStage(job.id)) throw failure();
      const converted = (await parse(job, { action: 'images', outputDirectory: canonical, files: base.sources.map(image => ({ id: image.id, input: image.path, name: image.filename })) })).images;
      base.sources = await Promise.all(converted.map(async image => ({ id: image.id, filename: image.name, sha256: image.sha256, bytes: (await stat(path.join(canonical, image.file))).size, path: path.join(canonical, image.file), immutable: false })));
      base.records.images = base.sources.map(stripImage);
    }
    const images = [...base.records.images], sources = [...base.sources];
    for (const image of incoming) {
      const same = images.find(item => item.sha256 === image.sha256 && item.filename === image.filename);
      if (same) image.id = same.id;
      else if (!images.some(item => item.id === image.id)) { images.push(stripImage(image)); sources.push(image); }
    }
    if (images.length > 500) throw problem(400, 'This customer image pool already has 500 images.');
    let entries;
    if (table) {
      const parsed = await parse(job, await tableInput(job, input, 'table'));
      const rows = parsed.rows, incomingEntries = makeEntries(rows, images, { jobId: job.id, sheet: parsed.sheet });
      const claimed = new Set(incomingEntries.map(entry => codeKey(entry.values.sku)));
      const priorStatus = existing?.entries ? new Map(existing.entries.map(entry => [entry.id, entry.status])) : new Map();
      entries = base.records.entries.filter(entry => !claimed.has(codeKey(entry.values.sku)) || priorStatus.get(entry.id) === 'blocked').concat(incomingEntries);
      // Table-only alias mapping may reuse one exact existing identity picture;
      // it does not guess a nearby dose or attach pictures by family.
      if (!incoming.length && existing) for (const entry of incomingEntries) if (!entry.imageId && !entry.imageConflict) {
        let identity; try { identity = productIdentity(entry.values.product, entry.values.dose); } catch { continue; }
        const matches = existing.products.filter(product => codeKey(product.name) === codeKey(identity.name));
        const assetIds = new Set(matches.map(product => product.imageId || base.records.entries.find(old => old.values.product === product.name)?.imageId).filter(Boolean));
        if (assetIds.size && new Set([...assetIds].map(id => images.find(image => image.id === id)?.sha256)).size === 1) entry.imageId = [...assetIds][0];
      }
      job.mapping = { sheet: parsed.sheet, headerRow: parsed.headerRow, columns: { ...input.columns } };
    } else {
      entries = structuredClone(base.records.entries);
      for (const entry of entries) {
        const selected = makeEntries([{ row: entry.source.row, ...entry.values }], incoming.map(stripImage), { jobId: job.id, sheet: entry.source.sheet })[0];
        if (selected.imageId || selected.imageConflict) { entry.imageId = selected.imageId; entry.imageConflict = selected.imageConflict; }
      }
    }
    if (entries.length > 10000) throw problem(400, 'This catalog exceeds 10000 retained rows.');
    const records = { version: 2, entries, images, origin }, revision = nonce();
    // Reuse only our own previously immutable copies, never mutable raw uploads.
    if (job.candidateRevision) { const previous = await readCatalogRecords(store, job.candidateRevision); for (let i = 0; i < sources.length; i++) { const old = previous.sources.find(old => old.id === sources[i].id && old.sha256 === sources[i].sha256); if (old) sources[i] = old; } }
    await writeCatalogRecords(store, revision, records, sources);
    job.previewId = previewId; job.candidateRevision = revision; job.commit = null;
    await persist(job); return previewResponse(job);
  });
  async function durableJSON(filename, value) {
    const temporary = filename + '.' + nonce() + '.tmp'; let file;
    try { file = await open(temporary, 'wx', 0o600); await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close(); file = null; await rename(temporary, filename); }
    finally { await file?.close(); await rm(temporary, { force: true }).catch(() => {}); }
  }
  const receiptFile = id => path.join(receiptRoot, id + '.json');
  async function receipt(id) {
    if (!validId(id)) throw problem(404, 'Import job is unavailable or expired.');
    try { const value = await boundedJSON(receiptFile(id), 8192); if (Object.keys(value).sort().join(',') !== 'customerId,id,previewId,revision,touched' || value.id !== id || !entryId(value.customerId) || !assetId(value.previewId) || !assetId(value.revision) || !Number.isFinite(value.touched)) throw failure(); return value; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function complete(job, catalog) {
    await durableJSON(receiptFile(job.id), { id: job.id, customerId: catalog.customer.id, previewId: job.previewId, revision: job.commit.revision, touched: clock() });
    job.phase = 'complete'; job.touched = clock(); job.result = catalog;
    await removeStage(job.id).catch(() => {}); return catalog;
  }
  async function confirmedResult(id, supplied) {
    const saved = await receipt(id); if (!saved) return null;
    if (supplied && supplied !== saved.previewId) throw problem(409, 'Import preview changed. Preview the matches again.');
    return { ...await customers.scan(saved.customerId), customers: await customers.list() };
  }
  async function confirm(id, input = {}) {
    optionsOnly(input, ['previewId']);
    if (Object.hasOwn(input, 'previewId') && !assetId(input.previewId)) throw problem(400, 'Choose the current import preview.');
    const prior = await confirmedResult(id, input.previewId); if (prior) return prior;
    return critical(id, 'committing', async job => {
      if (job.purpose === 'correction' || !job.previewId || !job.candidateRevision || (input.previewId && input.previewId !== job.previewId)) throw problem(400, 'Preview the retained product rows before confirming.');
      const candidate = await readCatalogRecords(store, job.candidateRevision);
      if (candidate.records.origin.importId !== job.id || candidate.records.origin.previewId !== job.previewId || candidate.records.origin.customerId !== job.preallocatedCustomerId) throw failure();
      if (!candidate.entries.length) throw problem(400, 'The mapped table contains no product rows.');
      if (!job.commit) { job.commit = { customerId: job.preallocatedCustomerId, isNew: !job.target.customerId, previewId: job.previewId, revision: job.candidateRevision }; await persist(job); }
      if (job.commit.customerId !== job.preallocatedCustomerId || job.commit.previewId !== job.previewId || job.commit.revision !== job.candidateRevision || job.commit.isNew !== !job.target.customerId) throw failure();
      let current;
      try { current = await customers.scan(job.commit.customerId); } catch (error) { if (error.status !== 400) throw error; }
      if (current?.records?.origin.importId === job.id) return complete(job, { ...current, customers: await customers.list() });
      const result = await customers.activateRecords({ customerId: job.commit.customerId, isNew: job.commit.isNew, name: job.target.name, fingerprint: job.target.fingerprint, catalogRevision: job.commit.revision });
      return complete(job, result);
    });
  }
  const list = async () => { await cleanup(); return { imports: [...jobs.values()].filter(job => ['idle', 'uploading', 'registering', 'previewing', 'inspecting'].includes(job.phase) && job.purpose !== 'correction').map(summary).sort((a, b) => b.updatedAt - a.updatedAt) }; };
  const detail = id => critical(id, 'reading', async job => ({ ...describe(job), phase: 'idle', preview: await previewResponse(job) }));
  async function entry(customerId, id) {
    const catalog = await customers.scan(customerId), selected = catalog.entries?.find(entry => entry.id === id);
    if (!selected) throw problem(404, 'Catalog entry is unavailable.');
    const display = recordsDTO(catalog);
    return { catalogRevision: catalog.customer.catalogRevision, entry: display.entries.find(entry => entry.id === id), images: catalog.records.images.map(image => ({ id: image.id, url: '/admin/catalog-assets/' + customerId + '/' + image.id, filename: image.filename })) };
  }
  async function correct(customerId, id, input) {
    optionsOnly(input, ['expectedRevision', 'changes', 'image']);
    if (!assetId(input.expectedRevision) || !input.changes || Array.isArray(input.changes)) throw problem(400, 'Supply correction fields and the current catalog revision.');
    optionsOnly(input.changes, ['sku', 'product', 'dose', 'hold']);
    if (input.image !== undefined && input.image !== null) {
      optionsOnly(input.image, Object.hasOwn(input.image, 'jobId') ? ['jobId', 'fileId'] : ['assetId']);
      if (Object.hasOwn(input.image, 'jobId') ? Object.keys(input.image).length !== 2 || !assetId(input.image.jobId) || !assetId(input.image.fileId) : Object.keys(input.image).length !== 1 || !assetId(input.image.assetId)) throw problem(400, 'Choose a complete correction image upload or saved picture.');
    }
    const normalized = { customerId, entryId: id, expectedRevision: input.expectedRevision, changes: Object.fromEntries(Object.entries(input.changes).sort(([a], [b]) => a.localeCompare(b))), ...(Object.hasOwn(input, 'image') ? { image: input.image === null ? null : Object.fromEntries(Object.entries(input.image).sort(([a], [b]) => a.localeCompare(b))) } : {}) };
    const operationId = createHash('sha256').update(JSON.stringify(normalized)).digest('hex'), operationFile = path.join(receiptRoot, 'correction-' + operationId + '.json');
    let prior;
    try {
      prior = await boundedJSON(operationFile, 8192);
      if (Object.keys(prior).sort().join(',') !== 'customerId,entryId,expectedRevision,id,revision,state,touched' || prior.id !== operationId || prior.customerId !== customerId || prior.entryId !== id || prior.expectedRevision !== input.expectedRevision || !assetId(prior.revision) || !['prepared', 'complete'].includes(prior.state) || !Number.isFinite(prior.touched)) throw failure();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const snapshot = await customers.snapshot(customerId), catalog = await customers.scan(customerId);
    const currentResult = async () => ({ ...catalog, customers: await customers.list(), entry: catalog.entries.find(entry => entry.id === id) });
    if (prior?.state === 'complete' || prior && catalog.records?.origin.correctionId === operationId) {
      if (!catalog.entries?.some(entry => entry.id === id)) throw problem(404, 'Catalog entry is unavailable.');
      if (prior.state !== 'complete') await durableJSON(operationFile, { ...prior, state: 'complete', touched: clock() });
      const completedUpload = jobs.get(input.image?.jobId);
      if (completedUpload?.purpose === 'correction' && completedUpload.target.customerId === customerId && completedUpload.entryId === id && completedUpload.expectedRevision === input.expectedRevision && completedUpload.files.some(file => file.id === input.image.fileId)) {
        completedUpload.phase = 'complete'; completedUpload.touched = clock(); await removeStage(completedUpload.id).catch(() => {});
      }
      return currentResult();
    }
    if (catalog.customer.catalogRevision !== input.expectedRevision) throw problem(409, 'Catalog changed. Reload products before saving corrections.');
    if (!catalog.entries?.some(entry => entry.id === id)) throw problem(404, 'Catalog entry is unavailable.');
    if (activeCorrections.has(operationId)) throw problem(409, 'This correction is busy. Retry after the current save.');
    activeCorrections.add(operationId);
    try {
    const operation = async (uploadJob, image) => {
      let records = structuredClone(catalog.records), sources = catalog.sources.slice(), imageInput = input.image;
      if (image) {
        const owned = records.images.find(saved => saved.filename === image.filename && saved.sha256 === image.sha256);
        if (owned) imageInput = { assetId: owned.id };
        else {
          if (!records.images.some(saved => saved.id === image.id)) { records.images.push(stripImage(image)); sources.push(image); }
          imageInput = { assetId: image.id };
        }
        if (records.images.length > 500) throw problem(400, 'This customer image pool already has 500 images.');
      }
      records = applyCorrection(records, id, { ...input, ...(Object.hasOwn(input, 'image') ? { image: imageInput } : {}) });
      records.origin.correctionId = operationId;
      const revision = nonce(); await writeCatalogRecords(store, revision, records, sources);
      const intent = { id: operationId, customerId, entryId: id, expectedRevision: input.expectedRevision, revision, state: 'prepared', touched: clock() };
      await durableJSON(operationFile, intent);
      const result = await customers.activateRecords({ customerId, fingerprint: snapshot.fingerprint, catalogRevision: revision });
      await durableJSON(operationFile, { ...intent, state: 'complete', touched: clock() });
      if (uploadJob) { uploadJob.phase = 'complete'; uploadJob.touched = clock(); await removeStage(uploadJob.id).catch(() => {}); }
      return { ...result, entry: result.entries.find(entry => entry.id === id) };
    };
    if (input.image && Object.hasOwn(input.image, 'jobId')) {
      if (Object.keys(input.image).sort().join(',') !== 'fileId,jobId' || !validId(input.image.jobId) || !validId(input.image.fileId)) throw problem(400, 'Choose a complete correction image upload.');
      return await critical(input.image.jobId, 'correcting', async job => {
        if (job.purpose !== 'correction' || job.target.customerId !== customerId || job.entryId !== id || job.expectedRevision !== input.expectedRevision || job.files.length !== 1) throw problem(400, 'The image upload belongs to a different correction.');
        const file = job.files.find(file => file.id === input.image.fileId); if (!file || file.offset !== file.size) throw problem(400, 'Finish uploading the correction image.');
        const image = (await normalizedImages(job, [file]))[0]; return operation(job, image);
      });
    }
    return await operation(null, null);
    } finally { activeCorrections.delete(operationId); }
  }
  const cancel = id => critical(id, 'cancelling', async job => { await removeStage(job.id); job.phase = 'cancelled'; jobs.delete(id); return { ok: true }; });
  const timer = setInterval(() => { cleanup().catch(() => {}); }, 60000); timer.unref();
  return { create, register, put, inspect, preview, confirm, cancel, cleanup, list, detail, entry, correct, close: () => clearInterval(timer) };
}
