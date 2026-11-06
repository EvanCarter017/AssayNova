// Browser-only controller; importing this module does not touch DOM or storage.
import { boundedJSON, catalogIssueText } from './catalog-correction-ui.mjs';
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function createImportUI({ document, request, context, setPending, onConfirmed, language, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), chunkSize = 256 * 1024, timeout = 15000, pageSize = 40 }) {
  const $ = id => document.getElementById('import-' + id), t = (key, values) => language.t(key, values);
  let job, captured, preview, phase = '', epoch = 0, controller, creating, hasSheet = false, forcedNew = false, page = 0, pendingJobs = [], listing = 0, feedback = { key: 'importIdle' };
  function render() {
    $('status').textContent = feedback.message !== undefined ? language.error(feedback.message, 'importError') : t(feedback.key, feedback.values);
    $('status').classList.toggle('error', Boolean(feedback.error));
    $('name-label').hidden = $('target').value !== 'new';
    if (preview) {
      $('counts').textContent = t(preview.entries ? 'importRetainedCounts' : 'importCounts', preview.counts) + (preview.imageCounts ? ' ' + t('importImageCount', preview.imageCounts) : '');
      const records = preview.entries ? preview.entries.map(row => ({ label: t('catalogSourceLine', row.source) + ' · ' + (row.values?.sku || row.raw?.sku || '') + ' · ' + (row.values?.product || row.raw?.product || ''), status: row.status, reason: (row.issues || []).map(issue => catalogIssueText(issue, language)).join(' ') })) : (preview.rows || []).map(row => ({ ...row, label: t('importRow', { row: row.row }) + ' · ' + row.sku + ' · ' + row.product, reason: row.reason ? language.error(row.reason, 'importRowError') : '' }));
      const rows = [...records, ...(preview.imageRows || []).map(row => ({ ...row, label: row.path, reason: row.reason ? language.error(row.reason, 'importRowError') : '' }))], pages = Math.max(1, Math.ceil(rows.length / pageSize));
      page = Math.min(page, pages - 1);
      $('rows').innerHTML = rows.slice(page * pageSize, (page + 1) * pageSize).map(row => '<li class="' + (row.status === 'blocked' ? 'is-blocked' : '') + '"><strong>' + escape(row.label) + '</strong><br>' + escape(row.reason || t(row.status === 'blocked' ? 'importRetained' : 'importValid')) + '</li>').join('');
      $('pages').hidden = pages <= 1; $('page').textContent = t('catalogPage', { page: page + 1, pages }); $('prev').disabled = page === 0; $('next').disabled = page + 1 === pages;
    } else { $('counts').textContent = ''; $('rows').innerHTML = ''; $('pages').hidden = true; }
    $('confirm-reason').textContent = preview && !preview.canConfirm ? (preview.confirmReason ? language.error(preview.confirmReason, 'importNoRows') : t('importNoRows')) : '';
    $('pending').hidden = !pendingJobs.length;
    $('pending-list').innerHTML = pendingJobs.map(row => '<button type="button" data-import-id="' + escape(row.id) + '"' + (job || phase ? ' disabled' : '') + '>' + escape(t('resumeUpload', { name: row.name || row.target?.name || row.customerId || row.id })) + '</button>').join('');
  }
  function update() {
    const pending = Boolean(job || creating), working = Boolean(phase), current = context(), ready = Boolean(current?.token), empty = ready && !current.customerId;
    for (const option of $('target').options) if (option.value === 'current') option.disabled = empty;
    if (empty) { $('target').value = 'new'; forcedNew = true; }
    else if (ready && forcedNew && !pending && !working) { $('target').value = 'current'; forcedNew = false; }
    for (const id of ['target', 'name', 'folder', 'sheet', 'upload']) $(id).disabled = pending || working || !ready;
    for (const id of ['sheet-name', 'header', 'sku', 'product', 'dose', 'read']) $(id).disabled = !job || !hasSheet || working;
    $('preview').disabled = !job || working;
    $('confirm').disabled = !preview?.canConfirm || working;
    $('cancel').disabled = !pending || ['confirming', 'cancelling'].includes(phase);
    $('mapping').hidden = !hasSheet || !job;
    $('form').setAttribute?.('aria-busy', String(working)); $('progress').hidden = !working; $('status').setAttribute?.('aria-busy', String(working));
    render();
  }
  function status(key, values = {}) { feedback = { key, values }; render(); }
  function failed(error) { feedback = { message: error.message || '', error: true }; render(); $('status').focus(); }
  function sameContext() { return context()?.customerId === captured?.customerId && context()?.token === captured?.token; }
  async function call(suffix, { method = 'POST', input = {}, body, binary = false, signal = controller?.signal } = {}) {
    return boundedJSON(request, '/admin/api/imports' + suffix, { method, headers: { 'Content-Type': binary ? 'application/octet-stream' : 'application/json', 'X-Studio-Token': captured.token }, ...(method === 'GET' ? {} : { body: body ?? JSON.stringify(input) }), signal }, timeout);
  }
  function options() {
    return { sheet: $('sheet-name').value, headerRow: Number($('header').value), columns: { sku: $('sku').value, product: $('product').value, ...($('dose').value ? { dose: $('dose').value } : {}) } };
  }
  function columns(value) {
    $('sheet-name').innerHTML = value.sheets.map(name => '<option value="' + escape(name) + '">' + escape(name) + '</option>').join('');
    $('sheet-name').value = value.sheet; $('header').value = String(value.headerRow);
    const choices = value.columns.map(column => '<option value="' + column.id + '">' + column.id + ' · ' + escape(column.label || column.id) + '</option>').join('');
    for (const id of ['sku', 'product', 'dose']) {
      $(id).innerHTML = '<option value="" data-i18n="importChooseColumn">' + escape(t('importChooseColumn')) + '</option>' + choices;
      const pattern = id === 'sku' ? /^(?:sku|code|short\s*code|简称|编号|shortcode)$/i : id === 'product' ? /^(?:product(?:\s*name)?|name|名称|品名|全称)$/i : /^(?:dose|spec|strength|规格|剂量)$/i;
      $(id).value = value.columns.find(column => pattern.test(column.label.trim()))?.id || '';
    }
  }
  async function start(event) {
    event?.preventDefault(); if (job || creating || phase) return;
    const files = [...($('folder').files || [])].map(file => ({ file, kind: 'image', path: file.webkitRelativePath || file.name })), sheet = $('sheet').files?.[0];
    if (sheet) files.push({ file: sheet, kind: 'sheet', path: sheet.name });
    const isNew = $('target').value === 'new';
    if (!files.length || (isNew && !sheet) || files.some(item => item.file.size < 1 || item.file.size > 8 * 1024 * 1024) || files.filter(item => item.kind === 'image').length > 500 || files.filter(item => item.kind === 'image').reduce((sum, item) => sum + item.file.size, 0) > 512 * 1024 * 1024) { status('importChooseFiles'); return; }
    const current = context(); if (!current?.token || (!isNew && !current.customerId)) return;
    captured = { ...current }; hasSheet = Boolean(sheet); preview = null; phase = 'uploading'; controller = new AbortController(); const version = ++epoch;
    setPending(true); status('importStarting');
    try {
      creating = call('', { input: isNew ? { name: $('name').value } : { customerId: current.customerId }, signal: null }); update();
      job = await creating; creating = null; if (version !== epoch) return;
      let sent = 0; const total = files.reduce((sum, item) => sum + item.file.size, 0); $('progress').max = total; $('progress').value = 0;
      for (const item of files) {
        const file = await call('/' + job.id + '/files', { input: { kind: item.kind, path: item.path, size: item.file.size } });
        for (let offset = 0; offset < item.file.size;) {
          const end = Math.min(offset + chunkSize, item.file.size);
          await call('/' + job.id + '/files/' + file.id + '?offset=' + offset, { method: 'PUT', binary: true, body: item.file.slice(offset, end) });
          if (version !== epoch) return;
          sent += end - offset; offset = end; $('progress').value = sent; status('importUploading', { done: sent, total, file: item.file.name });
        }
      }
      if (hasSheet) columns(await call('/' + job.id + '/inspect', { input: {} }));
      if (version === epoch) status('importUploaded');
    } catch (error) { if (version === epoch) failed(error); }
    finally { creating = null; if (version === epoch) { phase = ''; if (!job) setPending(false); update(); } }
  }
  async function perform(action) {
    if (!job || phase) return;
    const version = epoch; phase = action === 'confirm' ? 'confirming' : 'reading'; controller = new AbortController();
    if (action !== 'confirm') preview = null;
    status(action === 'confirm' ? 'importConfirming' : 'importReading'); update();
    try {
      let input = {};
      if (hasSheet && action === 'inspect') input = { sheet: $('sheet-name').value, headerRow: Number($('header').value) };
      if (hasSheet && action === 'preview') input = options();
      if (action === 'confirm') { if (!preview?.canConfirm) return; input = preview.previewId ? { previewId: preview.previewId } : {}; }
      const value = await call('/' + job.id + '/' + action, { input });
      if (version !== epoch) return;
      if (!sameContext()) { if (action === 'confirm') { job = null; setPending(false); } status('importContextChanged'); return; }
      if (action === 'inspect') { columns(value); status('importUploaded'); }
      if (action === 'preview') { preview = value; page = 0; status(value.canConfirm ? 'importPreviewReady' : 'importNeedsFix'); }
      if (action === 'confirm') { onConfirmed(value); pendingJobs = pendingJobs.filter(row => row.id !== job.id); job = null; preview = null; $('folder').value = ''; $('sheet').value = ''; setPending(false); status('importComplete'); }
    } catch (error) { if (version === epoch) failed(error); }
    finally { if (version === epoch) { phase = ''; update(); } }
  }
  async function loadPending() {
    const now = context(); if (!now?.token) return;
    const version = ++listing;
    try {
      const value = await boundedJSON(request, '/admin/api/imports', { method: 'GET', cache: 'no-store', headers: { 'X-Studio-Token': now.token } }, timeout);
      if (version !== listing || context()?.token !== now.token) return;
      pendingJobs = (value.imports || []).filter(row => row.purpose !== 'correction'); render();
    } catch (reason) { if (version === listing && context()?.token === now.token) failed(reason); }
  }
  async function resume(id) {
    if (job || creating || phase) return;
    const now = context(); if (!now?.token) return;
    captured = { ...now }; const version = ++epoch; controller = new AbortController(); phase = 'reading'; update();
    try {
      const value = await call('/' + encodeURIComponent(id), { method: 'GET' });
      if (version !== epoch || !sameContext()) return;
      if (value.purpose === 'correction') throw new Error('Import job is unavailable or expired.');
      const target = value.customerId || value.target?.customerId;
      if (target && target !== now.customerId) { status('importResumeContext'); return; }
      job = value; hasSheet = (value.files || []).some(row => row.kind === 'sheet'); preview = value.preview; page = 0;
      $('target').value = target ? 'current' : 'new'; $('name').value = value.name || value.target?.name || ''; setPending(true);
      if (hasSheet) {
        columns(await call('/' + value.id + '/inspect', { input: value.mapping ? { sheet: value.mapping.sheet, headerRow: value.mapping.headerRow } : {} }));
        if (version !== epoch || !sameContext()) return;
        if (value.mapping) for (const field of ['sku', 'product', 'dose']) $(field).value = value.mapping.columns[field] || '';
      }
      if (version === epoch) status(preview ? 'importPreviewReady' : 'importUploaded');
    } catch (reason) { if (version === epoch) failed(reason); }
    finally { if (version === epoch) { phase = ''; update(); } }
  }
  async function cancel() {
    if ((!job && !creating) || ['confirming', 'cancelling'].includes(phase)) return;
    const version = ++epoch; phase = 'cancelling'; controller?.abort(); status('importCancelling'); update();
    try {
      if (creating) { try { job = await creating; } catch {} }
      if (job) {
        for (let attempt = 0; ; attempt++) {
          try { await call('/' + job.id, { method: 'DELETE', signal: null }); break; }
          catch (error) { if (error.status !== 409 || attempt >= 124) throw error; await wait(250); }
        }
      }
      if (version === epoch) { pendingJobs = pendingJobs.filter(row => row.id !== job?.id); job = null; preview = null; creating = null; setPending(false); status('importCancelled'); }
    } catch (error) { if (version === epoch) failed(error); }
    finally { if (version === epoch) { phase = ''; update(); } }
  }
  $('form').addEventListener('submit', start); $('cancel').addEventListener('click', cancel);
  $('read').addEventListener('click', () => perform('inspect')); $('preview').addEventListener('click', () => perform('preview')); $('confirm').addEventListener('click', () => perform('confirm'));
  $('target').addEventListener('change', render);
  $('prev').addEventListener('click', () => { page = Math.max(0, page - 1); render(); }); $('next').addEventListener('click', () => { page++; render(); });
  $('pending-list').addEventListener('click', event => { const button = event.target.closest?.('[data-import-id]'); if (button) resume(button.dataset.importId); }); $('refresh-pending').addEventListener('click', loadPending);
  for (const id of ['sheet-name', 'header', 'sku', 'product', 'dose']) $(id).addEventListener('change', () => { preview = null; update(); });
  update();
  return { applyLanguage: render, refresh: update, owns: control => typeof control.id === 'string' && control.id.startsWith('import-'), start, cancel, perform, loadPending, resume };
}
