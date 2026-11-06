// Browser-only controller; importing this module does not touch DOM or storage.
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function createImportUI({ document, request, context, setPending, onConfirmed, language, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), chunkSize = 256 * 1024 }) {
  const $ = id => document.getElementById('import-' + id), t = (key, values) => language.t(key, values);
  let job, captured, preview, phase = '', epoch = 0, controller, creating, hasSheet = false, feedback = { key: 'importIdle' };
  function render() {
    $('status').textContent = feedback.message !== undefined ? language.error(feedback.message, 'importError') : t(feedback.key, feedback.values);
    $('status').classList.toggle('error', Boolean(feedback.error));
    $('name-label').hidden = $('target').value !== 'new';
    if (preview) {
      $('counts').textContent = t('importCounts', preview.counts);
      const rows = [...preview.rows.map(row => ({ ...row, label: t('importRow', { row: row.row }) + ' · ' + row.sku + ' · ' + row.product })), ...preview.imageRows.map(row => ({ ...row, label: row.path }))];
      $('rows').innerHTML = rows.slice(0, 500).map(row => '<li><strong>' + escape(row.label) + '</strong><br>' + escape(row.reason ? language.error(row.reason, 'importRowError') : t('importValid')) + '</li>').join('') + (rows.length > 500 ? '<li>' + escape(t('importMore', { total: rows.length })) + '</li>' : '');
    } else { $('counts').textContent = ''; $('rows').innerHTML = ''; }
  }
  function update() {
    const pending = Boolean(job || creating), working = Boolean(phase);
    for (const id of ['target', 'name', 'folder', 'sheet', 'upload']) $(id).disabled = pending || working;
    for (const id of ['sheet-name', 'header', 'sku', 'product', 'dose', 'read']) $(id).disabled = !job || !hasSheet || working;
    $('preview').disabled = !job || working;
    $('confirm').disabled = !preview?.canConfirm || working;
    $('cancel').disabled = !pending || ['confirming', 'cancelling'].includes(phase);
    $('mapping').hidden = !hasSheet || !job;
    render();
  }
  function status(key, values = {}) { feedback = { key, values }; render(); }
  function failed(error) { feedback = { message: error.message || '', error: true }; render(); $('status').focus(); }
  function sameContext() { return context()?.customerId === captured?.customerId && context()?.token === captured?.token; }
  async function call(suffix, { method = 'POST', input = {}, body, binary = false, signal = controller?.signal } = {}) {
    const response = await request('/admin/api/imports' + suffix, { method, headers: { 'Content-Type': binary ? 'application/octet-stream' : 'application/json', 'X-Studio-Token': captured.token }, body: body ?? JSON.stringify(input), signal });
    const value = await response.json();
    if (!response.ok) { const error = new Error(value.error || ''); error.status = response.status; throw error; }
    return value;
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
    if (!files.length || (isNew && (!sheet || !files.some(item => item.kind === 'image'))) || files.some(item => item.file.size < 1 || item.file.size > 8 * 1024 * 1024) || files.filter(item => item.kind === 'image').length > 500 || files.filter(item => item.kind === 'image').reduce((sum, item) => sum + item.file.size, 0) > 512 * 1024 * 1024) { status('importChooseFiles'); return; }
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
      const value = await call('/' + job.id + '/' + action, { input });
      if (version !== epoch) return;
      if (!sameContext()) { if (action === 'confirm') { job = null; setPending(false); } status('importContextChanged'); return; }
      if (action === 'inspect') { columns(value); status('importUploaded'); }
      if (action === 'preview') { preview = value; status(value.canConfirm ? 'importPreviewReady' : 'importNeedsFix'); }
      if (action === 'confirm') { onConfirmed(value); job = null; preview = null; $('folder').value = ''; $('sheet').value = ''; setPending(false); status('importComplete'); }
    } catch (error) { if (version === epoch) failed(error); }
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
      if (version === epoch) { job = null; preview = null; creating = null; setPending(false); status('importCancelled'); }
    } catch (error) { if (version === epoch) failed(error); }
    finally { if (version === epoch) { phase = ''; update(); } }
  }
  $('form').addEventListener('submit', start); $('cancel').addEventListener('click', cancel);
  $('read').addEventListener('click', () => perform('inspect')); $('preview').addEventListener('click', () => perform('preview')); $('confirm').addEventListener('click', () => perform('confirm'));
  $('target').addEventListener('change', render);
  for (const id of ['sheet-name', 'header', 'sku', 'product', 'dose']) $(id).addEventListener('change', () => { preview = null; update(); });
  update();
  return { applyLanguage: render, owns: control => typeof control.id === 'string' && control.id.startsWith('import-'), start, cancel, perform };
}
