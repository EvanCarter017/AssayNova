// Catalog administration only. No storage, network or DOM work at import time.
import { filterProducts, normalizeProductQuery } from './product-search.mjs';
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const key = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
// Same browser-safe normalization as import-match codeKey, without importing Node code.
const skuKey = value => normalizeProductQuery(value).replace(/[\s-]/g, '');
export function filterCatalogEntries(entries = [], query = '') {
  const parts = key(query).split(/\s+/).filter(Boolean);
  return entries.filter(entry => Boolean(skuKey(query)) && [entry.values?.sku, entry.raw?.sku].some(sku => skuKey(sku) === skuKey(query)) || parts.every(part => key(Object.values(entry.values || {}).join(' ') + ' ' + Object.values(entry.raw || {}).join(' ')).includes(part)));
}
export function catalogPickerState(products = [], entries = [], query = '', preferred = '') {
  const blocked = filterCatalogEntries(entries.filter(row => row.status !== 'ready'), query);
  const reserved = skuKey(query) && blocked.some(row => !row.hold && skuKey(row.values?.sku) === skuKey(query));
  const ready = reserved ? [] : filterProducts(products.filter(row => !row.status || row.status === 'ready'), query);
  const chosen = ready.some(row => row.id === preferred) ? preferred : ready.length === 1 && !blocked.some(row => !row.hold) ? ready[0].id : '';
  return { ready, blocked, chosen };
}
export function catalogIssueText(issue, language) {
  const codes = { HELD: 'issueHeld', MISSING_SKU: 'issueMissingSKU', INVALID_SKU: 'issueInvalidSKU', INVALID_IDENTITY: 'importFullIdentity', MISSING_IMAGE: 'issueMissingImage', IMAGE_CONFLICT: 'issueImageConflict', DUPLICATE_SKU: 'issueDuplicateSKU', SEARCH_COLLISION: 'importSearchConflict', SOURCE_FORMULA: 'importFormula', SOURCE_MERGE: 'importMerge', SOURCE_MISSING_IDENTITY: 'importMissingIdentity', SOURCE_REVIEW_REQUIRED: 'issueSourceReview' };
  return language.t(codes[issue?.code] || 'issueUnknown');
}
// Race the entire request and JSON read, including adapters that ignore AbortSignal.
export async function boundedJSON(request, url, options = {}, timeout = 15000, onValue) {
  const controller = new AbortController(), outer = options.signal;
  let timer, abort;
  const stop = new Promise((_, reject) => {
    abort = () => { controller.abort(); const error = new Error('Request cancelled.'); error.name = 'AbortError'; reject(error); };
    if (outer?.aborted) abort(); else outer?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { controller.abort(); const error = new Error('Request timed out. Try again.'); error.code = 'TIMEOUT'; reject(error); }, timeout);
  });
  try {
    return await Promise.race([stop, (async () => {
      const response = await request(url, { ...options, signal: controller.signal });
      const value = await response.json();
      if (!response.ok) { const error = new Error(value.error || ''); error.status = response.status; throw error; }
      onValue?.(value);
      return value;
    })()]);
  } finally { clearTimeout(timer); outer?.removeEventListener('abort', abort); }
}
function readImage(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Image preview is unavailable.')); reader.readAsDataURL(file); });
}
function randomUploadIntent() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); }
export function createCatalogCorrectionUI({ document, request, language, context, onSaved, readFile = readImage, timeout = 15000, pageSize = 20, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), cleanupAttempts = 3 }) {
  const $ = id => document.getElementById('catalog-' + id), t = (id, values) => language.t(id, values), esc = escapeHTML;
  let opened = false, capture, entries = [], revision, entry, images = [], page = 0, busy = false, epoch = 0, controller, trigger, file, fileURL = '', imageIntent, upload, retryBody, backup, feedback = { key: 'catalogChooseEntry' };
  const retiredUploads = new Set(), pendingSaves = new Map(); let cleaning = false;
  const saveKey = (customerId, entryId) => customerId + '/' + entryId;
  const current = () => { const now = context(); return opened && now?.customerId === capture?.customerId && now?.token === capture?.token; };
  function message(id, values) { feedback = { key: id, values }; renderMessage(); }
  function renderMessage() { $('message').textContent = feedback.error ? language.error(feedback.error, 'catalogFailure') : t(feedback.key, feedback.values); }
  function renderBrand() {
    const name = capture?.customerName || capture?.customerId || '', count = entries.filter(row => row.status !== 'ready').length;
    $('dialog-title').textContent = t('catalogBrandTitle', { name });
    $('dialog-intro').textContent = t(count ? 'catalogBrandIntro' : 'catalogBrandReady', { name, count });
  }
  function error(error) { feedback = { error: error.message }; renderMessage(); $('message').focus(); }
  function update() {
    $('dialog').setAttribute?.('aria-busy', String(busy));
    $('fields').disabled = busy || Boolean(retryBody); $('save').disabled = busy || !entry;
    $('reload').disabled = busy; $('close').disabled = false;
    $('cleanup').hidden = !retiredUploads.size; $('cleanup').disabled = cleaning;
    for (const id of ['search', 'filter', 'prev', 'next']) $(id).disabled = busy;
    $('clear-upload').disabled = busy || !file; $('remove-image').disabled = busy;
    renderList();
  }
  function renderList() {
    renderBrand();
    const matched = filterCatalogEntries(entries, $('search').value).filter(row => $('filter').value === 'all' || !$('filter').value || ($('filter').value === 'ready' ? row.status === 'ready' : row.status !== 'ready'));
    const pages = Math.max(1, Math.ceil(matched.length / pageSize)); page = Math.min(page, pages - 1);
    $('record-count').textContent = t('catalogEntryCount', { total: entries.length, count: matched.length });
    $('record-list').innerHTML = matched.slice(page * pageSize, (page + 1) * pageSize).map(row => '<li><button type="button" data-entry-id="' + esc(row.id) + '" class="catalog-record ' + (row.status === 'ready' ? 'is-ready' : 'is-blocked') + '"' + (busy ? ' disabled' : '') + (entry?.id === row.id ? ' aria-current="true"' : '') + '><strong>' + esc(row.values?.sku || row.raw?.sku || t('catalogUnnamed')) + '</strong><span>' + esc(row.values?.product || row.raw?.product || t('catalogUnnamed')) + '</span><small>' + esc(t(row.status === 'ready' ? 'catalogReady' : 'catalogBlocked')) + '</small></button></li>').join('') || '<li class="hint">' + esc(t($('filter').value === 'blocked' && !$('search').value ? 'catalogNoIssues' : 'catalogNoMatches')) + '</li>';
    $('page').textContent = t('catalogPage', { page: page + 1, pages }); $('prev').disabled = busy || page === 0; $('next').disabled = busy || page + 1 === pages;
  }
  function renderIssues() {
    if (!entry) return;
    $('entry-state').textContent = t(entry.status === 'ready' ? 'catalogReady' : 'catalogBlocked'); $('entry-state').classList.toggle('is-blocked', entry.status !== 'ready');
    $('issues').innerHTML = (entry.issues || []).map(issue => '<li>' + esc(catalogIssueText(issue, language)) + '</li>').join('');
    const related = entries.filter(row => row.id !== entry.id && skuKey(row.values?.sku) && skuKey(row.values.sku) === skuKey(entry.values?.sku));
    $('related').hidden = !related.length;
    $('related').innerHTML = '<strong>' + esc(t('catalogRelated')) + '</strong>' + related.map(row => '<button type="button" data-entry-id="' + esc(row.id) + '">' + esc((row.values?.sku || '') + ' · ' + (row.values?.product || '') + ' · ' + t('catalogSourceLine', row.source)) + '</button>').join('');
  }
  function showImage() {
    const picked = file ? { url: fileURL, filename: file.name } : images.find(row => row.id === $('image').value);
    $('image-preview').hidden = !picked?.url; if (picked?.url) $('image-preview').src = picked.url; else $('image-preview').removeAttribute?.('src');
    $('image-name').textContent = picked?.filename || t('catalogNoImage');
  }
  function fill(value) {
    entry = value.entry; revision = value.catalogRevision; images = value.images || images;
    $('choose').hidden = true; $('form').hidden = false;
    for (const name of ['sku', 'product', 'dose']) { $('raw-' + name).textContent = entry.raw?.[name] || '—'; $(name).value = entry.values?.[name] || ''; }
    $('source-line').textContent = t('catalogSourceLine', entry.source); $('hold').checked = Boolean(entry.hold);
    $('image').innerHTML = '<option value="">' + esc(t('catalogNoImage')) + '</option>' + images.map(row => '<option value="' + esc(row.id) + '">' + esc(row.filename) + '</option>').join('');
    $('image').value = entry.image?.id || ''; imageIntent = undefined; file = undefined; fileURL = ''; upload = undefined; retryBody = undefined; $('image-upload').value = '';
    const uncertain = pendingSaves.get(saveKey(capture.customerId, entry.id));
    if (uncertain) { retryBody = uncertain.payload; upload = uncertain.upload; for (const name of ['sku', 'product', 'dose']) $(name).value = retryBody.changes[name]; $('hold').checked = retryBody.changes.hold; $('reload').hidden = false; }
    showImage(); renderIssues(); renderList(); update();
  }
  async function call(url, method = 'GET', body, signal = controller?.signal) {
    return boundedJSON(request, url, { method, cache: 'no-store', headers: { 'X-Studio-Token': capture.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal }, timeout);
  }
  const endpoint = id => '/admin/api/catalog/' + encodeURIComponent(capture.customerId) + '/entries/' + encodeURIComponent(id);
  async function ensureUploadJob(state) {
    if (state.jobId) return;
    if (state.creating) return state.creating;
    const creating = boundedJSON(request, '/admin/api/imports', { method: 'POST', headers: { 'X-Studio-Token': state.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'correction', customerId: state.customerId, entryId: state.entryId, expectedRevision: state.revision, uploadIntent: state.uploadIntent }) }, timeout, value => { state.jobId = value.id; if (state.disposed) void cleanupUpload(state); });
    state.creating = creating;
    try { await creating; } finally { if (state.creating === creating) state.creating = undefined; }
  }
  async function cleanupUpload(state) {
    if (!state || state.patchMayComplete || state.complete) return true;
    state.disposed = true; retiredUploads.add(state);
    if (state.cleanup) return state.cleanup;
    state.cleanup = (async () => {
      for (let attempt = 0; attempt < cleanupAttempts; attempt++) {
        if (state.patchMayComplete) { retiredUploads.delete(state); return true; }
        try { await ensureUploadJob(state); await boundedJSON(request, '/admin/api/imports/' + state.jobId, { method: 'DELETE', headers: { 'X-Studio-Token': state.token } }, timeout); retiredUploads.delete(state); return true; }
        catch (reason) { if (reason.status === 404 || reason.message === 'Correction upload is unavailable. Choose the image again.') { retiredUploads.delete(state); return true; } if (attempt + 1 === cleanupAttempts || reason.status && reason.status !== 409) return false; await wait(100); }
      }
      return false;
    })();
    try { return await state.cleanup; } finally { state.cleanup = undefined; if (opened) update(); }
  }
  async function drainCleanup() {
    if (cleaning) return false; cleaning = true; if (opened) update();
    try { await Promise.all([...retiredUploads].map(cleanupUpload)); return retiredUploads.size === 0; }
    finally { cleaning = false; if (opened) update(); }
  }
  function discardUpload() { const previous = upload; upload = undefined; if (previous) void cleanupUpload(previous); }
  async function select(id) {
    if (!current() || busy) return;
    const version = ++epoch; controller?.abort(); controller = new AbortController(); busy = true; message('catalogReading'); update();
    discardUpload();
    try { const value = await call(endpoint(id)); if (version !== epoch || !current()) return; fill(value); backup = undefined; $('unsaved').hidden = true; $('reload').hidden = !retryBody; message(retryBody ? 'catalogUncertain' : 'catalogReview'); }
    catch (reason) { if (version === epoch && current()) error(reason); }
    finally { if (version === epoch) { busy = false; update(); } }
  }
  function close() {
    if (!opened) return;
    discardUpload(); opened = false; ++epoch; controller?.abort(); busy = false; entry = undefined; capture = undefined; entries = []; images = []; file = undefined; fileURL = ''; retryBody = undefined; backup = undefined;
    $('form').reset?.(); $('form').hidden = true; $('choose').hidden = false; $('record-list').innerHTML = ''; $('issues').innerHTML = ''; $('raw-sku').textContent = ''; $('raw-product').textContent = ''; $('raw-dose').textContent = ''; $('image-preview').removeAttribute?.('src'); $('image-preview').hidden = true; $('image-upload').value = ''; $('unsaved-values').textContent = ''; $('dialog').setAttribute?.('aria-busy', 'false');
    if ($('dialog').open) $('dialog').close();
    const target = trigger?.isConnected !== false && !trigger?.hidden ? trigger : document.getElementById('catalog-manage'); target?.focus();
  }
  async function open(id, from) {
    const now = context(); if (!now?.customerId || !now.token || busy) return;
    if (opened) close(); capture = { customerId: now.customerId, customerName: now.customerName || now.customerId, token: now.token }; entries = now.entries || []; revision = now.catalogRevision; opened = true; trigger = from || document.activeElement; $('search').value = ''; $('filter').value = 'blocked'; $('language').value = language.locale; page = 0; feedback = { key: 'catalogChooseEntry' }; renderMessage(); renderList(); $('dialog').showModal(); $('search').focus();
    void drainCleanup(); if (id) await select(id);
  }
  function edits() { return { values: Object.fromEntries(['sku', 'product', 'dose'].map(name => [name, $(name).value])), hold: $('hold').checked, image: imageIntent, imageId: $('image').value, file, fileURL }; }
  async function uploadImage(version) {
    if (!upload || upload.file !== file || upload.revision !== revision || upload.disposed) {
      discardUpload(); if (!await drainCleanup()) throw new Error('Clean up the previous image upload before starting another.');
      if (version !== epoch || !current()) return;
      upload = { file, revision, entryId: entry.id, customerId: capture.customerId, token: capture.token, uploadIntent: randomUploadIntent(), offset: 0, disposed: false };
    }
    const state = upload;
    if (version !== epoch || !current()) return;
    await ensureUploadJob(state);
    if (version !== epoch || !current()) return;
    if (state.reconcile) {
      const value = await call('/admin/api/imports/' + state.jobId); if (version !== epoch || !current()) return;
      const registered = (value.files || []).find(row => row.kind === 'image');
      if (registered) { state.fileId = registered.id; state.offset = registered.offset; }
      state.reconcile = false;
    }
    if (!state.fileId) { const registered = await call('/admin/api/imports/' + state.jobId + '/files', 'POST', { kind: 'image', path: state.file.name, size: state.file.size }); state.fileId = registered.id; state.offset = registered.offset || 0; }
    if (version !== epoch || !current()) return;
    for (let offset = state.offset; offset < state.file.size;) {
      const end = Math.min(offset + 256 * 1024, state.file.size);
      await boundedJSON(request, '/admin/api/imports/' + state.jobId + '/files/' + state.fileId + '?offset=' + offset, { method: 'PUT', headers: { 'X-Studio-Token': state.token, 'Content-Type': 'application/octet-stream' }, body: state.file.slice(offset, end), signal: controller.signal }, timeout);
      state.offset = end; offset = end;
      if (version !== epoch || !current()) return;
    }
    return { jobId: state.jobId, fileId: state.fileId };
  }
  async function save(event) {
    event?.preventDefault(); if (!current() || busy || !entry) return;
    const version = ++epoch; controller = new AbortController(); busy = true; message('catalogSaving'); update();
    let payload, patchStarted = false, saveUpload, previousUncertain = Boolean(retryBody), receiptKey = saveKey(capture.customerId, entry.id);
    try {
      payload = retryBody || { expectedRevision: revision, changes: { ...edits().values, hold: $('hold').checked }, ...(imageIntent !== undefined ? { image: imageIntent } : {}) };
      if (!retryBody && file) { const reference = await uploadImage(version); if (version !== epoch || !current()) return; payload.image = reference; }
      patchStarted = true; saveUpload = upload; if (saveUpload) saveUpload.patchMayComplete = true;
      pendingSaves.set(receiptKey, { payload, upload: saveUpload });
      const value = await call(endpoint(entry.id), 'PATCH', payload);
      pendingSaves.delete(receiptKey); if (saveUpload) { saveUpload.complete = true; retiredUploads.delete(saveUpload); }
      if (version !== epoch || !current()) return;
      entries = value.entries; revision = value.catalogRevision; onSaved(value); fill({ ...value, images: value.images || (value.entry.image && !images.some(row => row.id === value.entry.image.id) ? [...images, value.entry.image] : images) }); $('reload').hidden = true; $('unsaved').hidden = true; backup = undefined; message(value.entry.status === 'ready' ? 'catalogSavedReady' : 'catalogSavedBlocked');
    } catch (reason) {
      if (!patchStarted && upload) upload.reconcile = true;
      if (!patchStarted && reason.message === 'Correction upload is unavailable. Choose the image again.') discardUpload();
      if (patchStarted && reason.status && reason.status >= 400 && reason.status < 500 && !previousUncertain) { pendingSaves.delete(receiptKey); if (saveUpload) { saveUpload.patchMayComplete = false; if (saveUpload.disposed) void cleanupUpload(saveUpload); } }
      if (version !== epoch || !current()) return;
      if (reason.status === 409 && reason.message === 'Catalog changed. Reload products before saving corrections.') { retryBody = undefined; $('reload').hidden = false; message('catalogChanged'); }
      else if (!reason.status && patchStarted) { retryBody = payload; $('reload').hidden = false; message('catalogUncertain'); }
      else if (patchStarted && pendingSaves.has(receiptKey)) { retryBody = payload; $('reload').hidden = false; message('catalogUncertain'); }
      else error(reason);
    } finally { if (version === epoch) { busy = false; update(); } }
  }
  async function reload() {
    if (!current() || busy || !entry) return;
    backup = edits(); const id = entry.id, version = ++epoch; controller = new AbortController(); busy = true; update();
    try {
      const value = await call(endpoint(id)); if (version !== epoch || !current()) return; discardUpload(); fill(value); $('reload').hidden = !retryBody; $('unsaved').hidden = false; $('unsaved-values').textContent = JSON.stringify({ ...backup.values, hold: backup.hold, image: backup.file?.name || backup.imageId || t('catalogNoImage') }, null, 2); message(retryBody ? 'catalogUncertain' : 'catalogLatestRead');
    } catch (reason) { if (version === epoch && current()) error(reason); }
    finally { if (version === epoch) { busy = false; update(); } }
  }
  async function chooseFile() {
    const chosen = $('image-upload').files?.[0]; if (!chosen || busy || retryBody) return;
    if (chosen.size < 1 || chosen.size > 8 * 1024 * 1024 || !/\.(png|jpe?g|webp)$/i.test(chosen.name)) { message('catalogImageInvalid'); return; }
    const version = epoch; discardUpload(); file = chosen; retryBody = undefined;
    try { const url = await readFile(chosen); if (version === epoch && current() && chosen === file) { fileURL = url; showImage(); update(); } }
    catch (reason) { if (version === epoch && current()) error(reason); }
  }
  function listClick(event) { const target = event.target.closest?.('[data-entry-id]'); if (target) select(target.dataset.entryId); }
  $('record-list').addEventListener('click', listClick); $('related').addEventListener('click', listClick);
  $('search').addEventListener('input', () => { page = 0; renderList(); }); $('filter').addEventListener('change', () => { page = 0; renderList(); });
  $('prev').addEventListener('click', () => { page = Math.max(0, page - 1); renderList(); }); $('next').addEventListener('click', () => { page++; renderList(); });
  $('close').addEventListener('click', close); $('dialog').addEventListener('cancel', event => { event.preventDefault(); close(); }); $('dialog').addEventListener('close', close);
  $('language').addEventListener('change', event => language.setLocale(event.target.value));
  $('cleanup').addEventListener('click', async () => { const complete = await drainCleanup(); if (opened) message(complete ? 'catalogCleanupComplete' : 'catalogCleanupPending'); });
  $('form').addEventListener('submit', save); $('reload').addEventListener('click', reload); $('image-upload').addEventListener('change', chooseFile);
  $('image').addEventListener('change', () => { if (busy || retryBody) return; discardUpload(); file = undefined; fileURL = ''; $('image-upload').value = ''; imageIntent = $('image').value ? { assetId: $('image').value } : null; showImage(); update(); });
  $('clear-upload').addEventListener('click', () => { if (busy || retryBody) return; discardUpload(); file = undefined; fileURL = ''; $('image-upload').value = ''; showImage(); update(); });
  $('remove-image').addEventListener('click', () => { if (busy || retryBody) return; discardUpload(); file = undefined; fileURL = ''; $('image-upload').value = ''; $('image').value = ''; imageIntent = null; showImage(); update(); });
  $('restore-edits').addEventListener('click', () => { if (!backup || busy || retryBody) return; for (const name of ['sku', 'product', 'dose']) $(name).value = backup.values[name]; $('hold').checked = backup.hold; $('image').value = backup.imageId; imageIntent = backup.image; file = backup.file; fileURL = backup.fileURL; showImage(); $('unsaved').hidden = true; update(); message('catalogReview'); });
  return { open, close, select, save, reload, chooseFile, cleanup: drainCleanup, refresh() { if (opened && !current()) close(); }, applyLanguage() { if (!opened) return; $('language').value = language.locale; if (entry) $('source-line').textContent = t('catalogSourceLine', entry.source); const emptyImage = $('image').options?.[0]; if (emptyImage) emptyImage.textContent = t('catalogNoImage'); renderMessage(); renderList(); renderIssues(); if (!file) showImage(); }, owns: control => control.id?.startsWith('catalog-') };
}
