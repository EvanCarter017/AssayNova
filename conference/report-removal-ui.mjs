const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// The library has its own read revision; mutations use the operator's shared busy lock.
export function createReportRemovalUI({ document, request, language, context, setPending, onPreview, onChanged, onUncertain, timeout = 15000 }) {
  const $ = id => document.getElementById(id), t = (key, values) => language.t(key, values);
  let rows = [], state = 'published', revision = 0, loading = false, pending = false, operation = null;
  const uncertainCodes = new Set();
  let message = '', failure = false;
  const dialog = $('report-dialog');
  async function json(url, options = {}) {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([
        (async () => { const response = await request(url, { ...options, signal: controller.signal }); return { response, value: await response.json() }; })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeout); })
      ]);
    } finally { clearTimeout(timer); }
  }
  function status(key, error = false) { message = key; failure = error; applyLanguage(); }
  function refresh() {
    const blocked = pending || loading || !context();
    $('report-state').disabled = blocked; $('report-refresh').disabled = blocked;
    for (const button of $('history').querySelectorAll('button')) button.disabled = blocked;
    $('report-confirm').disabled = pending || !context(); $('report-cancel').disabled = pending;
    dialog.setAttribute('aria-busy', String(pending));
  }
  function applyLanguage() {
    $('report-message').textContent = message ? t(message) : '';
    $('report-message').classList.toggle('error', failure);
    for (const button of $('history').querySelectorAll('[data-code]')) {
      const row = rows.find(row => row.lookupCode === button.dataset.code);
      if (!row) continue;
      if (button.dataset.reportAction) { button.textContent = t(state === 'published' ? 'removeReport' : 'restoreReport'); button.setAttribute('aria-label', t(state === 'published' ? 'removeNamedReport' : 'restoreNamedReport', { name: row.label, code: row.lookupCode })); }
      else button.setAttribute('aria-label', t('openHistory', { name: row.label, code: row.lookupCode }));
    }
    const empty = $('history').querySelectorAll('[data-report-empty]')[0];
    if (empty) empty.textContent = t(state === 'published' ? 'historyEmpty' : 'removedEmpty');
    if (operation) {
      $('report-dialog-title').textContent = t(operation.action === 'remove' ? 'removeReport' : 'restoreReport');
      $('report-dialog-identity').textContent = operation.row.label + ' · ' + operation.row.lookupCode;
      $('report-dialog-description').textContent = t(operation.action === 'remove' ? 'removeExplanation' : 'restoreExplanation');
      $('report-confirm').textContent = t(pending ? 'reportChanging' : operation.action === 'remove' ? 'removeReport' : 'restoreReport');
      $('report-dialog-status').textContent = operation.error ? t('reportChangeUncertain') : '';
    }
  }
  function render() {
    $('history').innerHTML = rows.map(row => `<div class="report-row"><button type="button" data-code="${escape(row.lookupCode)}">${escape(row.label)}<br><strong>${escape(row.lookupCode)}</strong> · ${escape(row.reported)}</button><button type="button" data-code="${escape(row.lookupCode)}" data-report-action="${state === 'published' ? 'remove' : 'restore'}"></button></div>`).join('') || '<p class="hint" data-report-empty></p>';
    applyLanguage(); refresh();
  }
  async function load() {
    const ticket = ++revision, requestedState = state;
    loading = true; status('reportLibraryLoading'); refresh();
    try {
      const { response, value } = await json('/admin/api/history' + (state === 'removed' ? '?state=removed' : ''), { cache: 'no-store' });
      if (ticket !== revision || requestedState !== state) return false;
      if (!response.ok || !Array.isArray(value)) throw new Error();
      rows = value;
      // A returned row confirms its state. Absence from capped history proves nothing.
      for (const row of rows) uncertainCodes.delete(row.lookupCode);
      message = ''; failure = false; render(); return true;
    } catch {
      if (ticket === revision) { rows = []; render(); status('reportLibraryError', true); }
      return false;
    } finally { if (ticket === revision) { loading = false; refresh(); } }
  }
  function close() {
    if (pending) return;
    const trigger = operation?.trigger; operation = null;
    if (dialog.open) dialog.close();
    if (trigger?.isConnected) trigger.focus(); else $('report-state').focus();
  }
  function open(row, action, trigger) {
    if (pending || loading || !context()) return;
    operation = { row, action, trigger, error: false }; applyLanguage(); refresh();
    dialog.showModal(); $('report-cancel').focus();
  }
  async function confirm() {
    const session = context();
    if (pending || !operation || !session) return;
    const current = operation;
    pending = true; current.error = false; setPending(true); applyLanguage(); refresh();
    try {
      const { response, value } = await json('/admin/api/reports/' + current.row.lookupCode + '/' + current.action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': session.token }, body: '{}' });
      const target = current.action === 'remove' ? 'removed' : 'published';
      if (!response.ok || value.lookupCode !== current.row.lookupCode || value.state !== target) throw new Error();
      uncertainCodes.delete(value.lookupCode); onChanged(value); const loaded = await load();
      pending = false; setPending(false); close();
      status(loaded ? target === 'removed' ? 'reportRemoved' : 'reportRestored' : target === 'removed' ? 'reportRemovedLibraryError' : 'reportRestoredLibraryError', !loaded);
    } catch {
      // The server may have committed even when its acknowledgement was lost.
      // Clear only this preview; capped history absence cannot prove either state.
      uncertainCodes.add(current.row.lookupCode); onUncertain({ lookupCode: current.row.lookupCode });
      current.error = true; status('reportChangeUncertain', true);
    } finally { pending = false; setPending(false); applyLanguage(); refresh(); }
  }
  $('history').addEventListener('click', event => {
    if (pending || loading || !context()) return;
    const button = event.target.closest('[data-code]');
    const row = rows.find(row => row.lookupCode === button?.dataset.code); if (!row) return;
    if (button.dataset.reportAction) open(row, button.dataset.reportAction, button);
    else if (uncertainCodes.has(row.lookupCode)) { onUncertain(row); status('reportChangeUncertain', true); }
    else onPreview(row, state);
  });
  $('report-state').addEventListener('change', () => { if (pending || !context()) return; state = $('report-state').value === 'removed' ? 'removed' : 'published'; return load(); });
  $('report-refresh').addEventListener('click', load);
  $('report-confirm').addEventListener('click', confirm); $('report-cancel').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { if (operation && !pending) close(); });
  dialog.addEventListener('click', event => { if (event.target !== dialog) return; const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); });
  return { load, refresh, applyLanguage, confirm, close };
}
