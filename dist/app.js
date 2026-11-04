import { DEMO_REPORT, SERVICE_NAMES, findReportByLookupCode, findLegacyReport, reportPath, lookupResultPath, resolveCOARoute, validateSubmission } from './data.js';
import { PAGE_ROUTES, resolvePageRoute } from './routes.js';
import { SUPPORT_DRAFT_KEY, normalizeSupport, validateSupport, parseSupportDraft, formatSupportRequest } from './support.js';
import { REQUEST_DRAFT_KEY, readableRequests, effectiveReportRecipient, SAMPLE_FORMS, IMAGE_CHOICES, IMAGE_STYLES } from './submission.js';
import { createRequestPage } from './request-page.js';

const dialog = document.querySelector('#app-dialog');
const dialogContent = document.querySelector('#dialog-content');
const storageKey = REQUEST_DRAFT_KEY;
const toast = document.querySelector('#toast');
let previousFocus;
let toastTimer;
const pageViews = Object.fromEntries(PAGE_ROUTES.map((route) => [route.path, document.querySelector('#' + route.view)]));
const coaView = document.querySelector('#coa-view');
let renderedURL = '';
let historyFocusRevision = 0;
let activeReport = null;
let pendingCopyKind = null;

const icon = (name, small = false) => `<svg class="icon${small ? ' small' : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function readRequests() {
  try { return readableRequests(localStorage.getItem(storageKey)); }
  catch { return []; }
}

const requestPage = createRequestPage(document.querySelector('#request-flow'), { storage: { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }, makeId: () => crypto.randomUUID(), openSavedDrafts: () => renderPortal() });

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function openDialog(html, wide = false) {
  historyFocusRevision++;
  if (!dialog.open) previousFocus = document.activeElement;
  dialog.classList.toggle('wide', wide);
  dialogContent.innerHTML = html;
  if (!dialog.open) dialog.showModal();
  document.body.classList.add('dialog-open');
  dialog.scrollTop = 0;
  const title = dialogContent.querySelector('#dialog-title');
  title?.setAttribute('tabindex', '-1');
  title?.focus({ preventScroll: true });
}

function closeDialog() { dialog.close(); }
dialog.addEventListener('close', () => {
  if (dialog.open) return;
  document.body.classList.remove('dialog-open');
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
document.querySelector('.dialog-close').addEventListener('click', closeDialog);
dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog();
});

function renderSubmission(service, reset = false) {
  requestPage.activate({ service, reset });
  navigateToURL('/submit-sample');
}

function resumeRequest(id) {
  const request = readRequests().find(entry => entry.id === id);
  if (requestPage.resume(request)) navigateToURL('/submit-sample');
}

function renderRecovery() {
  let saved = null;
  let readFailed = false;
  try { saved = parseSupportDraft(localStorage.getItem(SUPPORT_DRAFT_KEY)); }
  catch { readFailed = true; }
  const values = saved || { email: '', reference: '', notes: '' };
  openDialog(`<div class="nova-support-dialog">
    <p class="dialog-eyebrow">NOVA SUPPORT</p>
    <h2 class="dialog-title" id="dialog-title">Recover your report.</h2>
    <p class="dialog-description">Use the email used for testing and your company or project name to prepare a report recovery request.</p>
    <form id="recovery-form" class="recovery-form" novalidate>
      <div class="form-grid">
        <div class="form-field full"><label for="support-email">Testing email</label><input id="support-email" name="email" type="email" required maxlength="160" autocomplete="email" value="${escape(values.email)}" placeholder="you@company.com" aria-describedby="support-email-help support-error-email"><small id="support-email-help" class="field-helper">Use the contact email associated with the original testing request.</small><span class="field-error" id="support-error-email"></span></div>
        <div class="form-field full"><label for="support-reference">Company or project name</label><input id="support-reference" name="reference" required maxlength="160" value="${escape(values.reference)}" placeholder="Your company or project" aria-describedby="support-reference-help support-error-reference"><small id="support-reference-help" class="field-helper">Additional verification may be needed before a report is shared.</small><span class="field-error" id="support-error-reference"></span></div>
        <div class="form-field full"><label for="support-notes">Additional context <span>Optional</span></label><textarea id="support-notes" name="notes" maxlength="1200" placeholder="Sample name, approximate testing date, or anything else that helps" aria-describedby="support-error-notes">${escape(values.notes)}</textarea><span class="field-error" id="support-error-notes"></span></div>
      </div>
      <div class="demo-notice email-connection"><p class="email-connection-heading"><strong>Recovery draft</strong><span class="email-connection-status">On this device</span></p><p>Saving or copying prepares your request. Nothing is sent to Nova Support.</p></div>
      <p id="support-error" class="inline-error" role="alert">${readFailed ? 'Your saved recovery draft could not be opened. You can still prepare a request below.' : ''}</p>
      <p id="support-status" class="support-status" role="status"></p>
      <div id="support-copy-fallback" class="support-copy-fallback" role="region" aria-label="Manual request copy" hidden><p>Automatic copying was unavailable. Select and copy the complete request below.</p><label for="support-copy-value">Request details</label><textarea id="support-copy-value" readonly></textarea><button type="button" class="text-button" data-recovery-action="select">Select all</button></div>
      <div class="form-footer support-footer"><button class="button button-teal" type="submit">Save draft ${icon('arrow', true)}</button><button class="button button-outline" type="button" data-recovery-action="copy">Copy request</button><button class="text-button" type="button" data-recovery-action="clear">Clear saved draft</button></div>
    </form>
  </div>`);
  const form = document.querySelector('#recovery-form');
  const field = (key) => form.elements.namedItem(key);
  const error = form.querySelector('#support-error');
  const status = form.querySelector('#support-status');
  const fallback = form.querySelector('#support-copy-fallback');
  const copyField = form.querySelector('#support-copy-value');
  let operation = 0;
  const currentValues = () => Object.fromEntries(['email', 'reference', 'notes'].map((key) => [key, field(key).value]));
  function resetFeedback() {
    operation++;
    error.textContent = '';
    status.textContent = '';
    fallback.hidden = true;
    copyField.value = '';
  }
  function validatedValues() {
    const current = currentValues();
    const errors = validateSupport(current);
    for (const key of ['email', 'reference', 'notes']) {
      form.querySelector('#support-error-' + key).textContent = errors[key] || '';
      if (errors[key]) field(key).setAttribute('aria-invalid', 'true');
      else field(key).removeAttribute('aria-invalid');
    }
    const invalid = ['email', 'reference', 'notes'].find((key) => errors[key]);
    if (invalid) { field(invalid).focus(); return null; }
    return normalizeSupport(current);
  }
  form.addEventListener('input', (event) => {
    resetFeedback();
    if (['email', 'reference', 'notes'].includes(event.target.name)) {
      event.target.removeAttribute('aria-invalid');
      form.querySelector('#support-error-' + event.target.name).textContent = '';
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    resetFeedback();
    const current = validatedValues();
    if (!current) return;
    try {
      const serialized = JSON.stringify({ version: 1, ...current });
      localStorage.setItem(SUPPORT_DRAFT_KEY, serialized);
      if (localStorage.getItem(SUPPORT_DRAFT_KEY) !== serialized) throw new Error('Recovery draft was not persisted');
      status.textContent = 'Draft saved on this device. Nothing has been sent to Nova Support.';
    } catch { error.textContent = 'Your recovery draft could not be saved. Keep this form open or copy the request details.'; }
  });
  form.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-recovery-action]');
    if (!button) return;
    const action = button.dataset.recoveryAction;
    if (action === 'select') { copyField.focus(); copyField.select(); return; }
    resetFeedback();
    if (action === 'clear') {
      try {
        localStorage.removeItem(SUPPORT_DRAFT_KEY);
        if (localStorage.getItem(SUPPORT_DRAFT_KEY) !== null) throw new Error('Recovery draft was not removed');
        for (const key of ['email', 'reference', 'notes']) { field(key).value = ''; field(key).removeAttribute('aria-invalid'); form.querySelector('#support-error-' + key).textContent = ''; }
        status.textContent = 'Saved recovery draft cleared from this device.';
        field('email').focus();
      } catch { error.textContent = 'Your saved recovery draft could not be cleared. Your current details have been kept.'; }
      return;
    }
    if (action !== 'copy') return;
    const current = validatedValues();
    if (!current) return;
    const value = formatSupportRequest(current);
    const revision = operation;
    const snapshot = JSON.stringify(currentValues());
    const stillCurrent = () => dialog.open && document.querySelector('#recovery-form') === form && revision === operation && JSON.stringify(currentValues()) === snapshot;
    try {
      await navigator.clipboard.writeText(value);
      if (stillCurrent()) status.textContent = 'Request details copied. Nothing has been sent.';
    } catch {
      if (!stillCurrent()) return;
      fallback.hidden = false;
      copyField.value = value;
      copyField.focus();
      copyField.select();
    }
  });
}

function renderSuccess(request) {
  openDialog(`<div class="dialog-padding"><div class="success-icon">${icon('check')}</div>
    <p class="dialog-eyebrow">SAVED DRAFT</p>
    <h2 class="dialog-title" id="dialog-title">Draft saved on this device.</h2>
    <p class="dialog-description">Your request draft is saved on this device. It has not been sent to the laboratory.</p>
    <div class="reference-box"><p>REQUEST REFERENCE</p><strong>${escape(request.id)}</strong></div>
    <dl class="success-details"><div><dt>Sample</dt><dd>${escape(request.sample)}</dd></div><div><dt>Contact email</dt><dd>${escape(request.email)}</dd></div><div><dt>Service</dt><dd>${escape(SERVICE_NAMES[request.service])}</dd></div><div><dt>Number of samples</dt><dd>${escape(request.quantity)}</dd></div><div><dt>Status</dt><dd>Draft · Not sent</dd></div></dl>
    <p class="demo-notice">No email is sent when a draft is saved. Reopen this draft from Saved drafts on this device.</p>
    <div class="dialog-buttons"><button class="button button-teal" data-action="requests">View saved drafts ${icon('arrow', true)}</button><button class="text-button" data-action="close">Back to website</button></div></div>`);
}

const SAMPLE_REPORT_ASSETS = Object.freeze({
  'AN-7K9Q-2M4X': Object.freeze({ label: 'Reference sample A', svg: '/reports/sample-a.svg', pdf: '/reports/sample-a.pdf' }),
  'AN-8P6R-3N5Y': Object.freeze({ label: 'Reference sample C', svg: '/reports/sample-c.svg', pdf: '/reports/sample-c.pdf' })
});

function lookupForm() {
  return `<form id="coa-lookup-form" class="coa-search" novalidate><label for="coa-lookup-code">Find another COA · COA Lookup Code</label><div class="coa-search-controls"><input id="coa-lookup-code" name="lookupCode" type="text" maxlength="64" autocomplete="off" spellcheck="false" placeholder="e.g. AN-8P6R-3N5Y" aria-describedby="coa-lookup-error" required><button class="button button-dark" type="submit">Find report</button></div><p id="coa-lookup-error" class="inline-error" role="status"></p><p class="coa-help">Use a COA Lookup Code, not a report or submission number.</p></form>`;
}

function renderReport(report) {
  const sample = Object.hasOwn(SAMPLE_REPORT_ASSETS, report.lookupCode) ? SAMPLE_REPORT_ASSETS[report.lookupCode] : null;
  if (!sample) { renderReportNotFound(); return; }
  const fields = [['Product name', '[Product name]'], ['Appearance', '[Appearance]'], ['Client', '[Client name]'], ['Lot', '[Lot number]'], ['Accession no.', '[Accession no.]'], ['COA Lookup Code', report.lookupCode], ['Received', '[YYYY-MM-DD]'], ['Reported', '[YYYY-MM-DD]']];
  const screenings = ['Identity (LC-MS)', 'Elemental impurities (ICP-MS)', 'Endotoxin (LAL)', 'Microbial analysis (PCR)', 'Fentanyl'];
  coaView.innerHTML = `<div class="coa-navigation"><a class="text-button" href="/" data-action="home">← Back to AssayNova</a><span>COA report</span></div><article class="coa-card coa-master-card" aria-labelledby="report-title"><header class="coa-master-heading"><div><p class="report-demo-label">Sample report</p><h1 id="report-title" tabindex="-1">${escape(sample.label)}</h1></div><p class="coa-code">COA Lookup Code <strong>${escape(report.lookupCode)}</strong></p></header>
    <figure class="coa-master-paper"><img src="${sample.svg}" width="595" height="842" alt="Placeholder certificate of analysis for ${escape(sample.label)}. COA Lookup Code ${escape(report.lookupCode)}. Report fields are also available below."></figure>
    <p class="report-disclaimer coa-master-disclosure"><strong>Sample report.</strong> ${escape(report.disclaimer)}</p>
    <div class="report-actions coa-master-tools"><a class="button button-dark" href="${sample.pdf}" download>Download PDF</a><a class="button button-outline" href="${sample.svg}" target="_blank" rel="noopener">View full size</a><button class="button button-outline" data-action="print">${icon('download', true)} Print / save PDF</button><button class="text-button" data-action="copy-code">Copy lookup code</button><button class="text-button" data-action="copy-link">Copy report link</button></div>
    <details class="coa-master-transcript"><summary>Report fields</summary><div class="coa-master-transcript-body"><section><h2>Sample information</h2><dl class="coa-master-field-list">${fields.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl></section><section><h2>Analytical results</h2><p>Purity / HPLC-UV</p><dl class="coa-master-field-list">${['Sample 1', 'Sample 2', 'Reported summary'].map((label) => `<div><dt>${label}</dt><dd>--.--%</dd></div>`).join('')}</dl><table><caption>Composition · Net content (mg)</caption><thead><tr><th scope="col">Analyte</th><th scope="col">Sample 1</th><th scope="col">Sample 2</th><th scope="col">Reported summary</th></tr></thead><tbody>${Array.from({ length: 4 }, (_, i) => `<tr><th scope="row">[Analyte ${i + 1}]</th><td>--.--</td><td>--.--</td><td>--.--</td></tr>`).join('')}</tbody></table></section><section><h2>Analytical figures</h2><p>HPLC-UV chromatogram: [Chromatogram]</p><ul>${Array.from({ length: 4 }, (_, i) => `<li>[Analyte ${i + 1}]: [Spectrum]</li>`).join('')}</ul></section><section><h2>Screening outcomes</h2><dl class="coa-master-field-list">${screenings.map((label) => `<div><dt>${label}</dt><dd>[Result] · [Result details]</dd></div>`).join('')}</dl><h2>Method</h2><p>[Analytical method]</p></section><section><h2>Signoff</h2><p>Dylan Greene</p><p>[Title]</p></section></div></details>
    <div id="report-copy-fallback" class="copy-fallback" role="region" aria-label="Manual copy" hidden><p>Automatic copy was unavailable. Select and copy the complete value below.</p><label for="report-copy-value">Value to copy</label><textarea id="report-copy-value" readonly></textarea><div class="dialog-buttons"><button class="text-button" data-action="copy-select">Select all</button><button class="text-button" data-action="copy-retry">Try copying again</button></div></div>
    </article>${lookupForm()}`;
}

function renderReportNotFound() {
  coaView.innerHTML = `<div class="coa-navigation"><a class="text-button" href="/" data-action="home">← Back to AssayNova</a><span>COA Lookup</span></div><div class="coa-not-found coa-card"><p class="eyebrow">COA LOOKUP</p><h1 id="report-title" tabindex="-1">No COA found.</h1><p>This code does not identify a published report. Check the COA Lookup Code or search again below.</p><p class="coa-help">Report and submission numbers are separate from COA Lookup Codes.</p></div>${lookupForm()}`;
}

function routeLocation(address) {
  const url = new URL(address, location.href);
  let invalidLegacy = false;
  if (url.pathname === '/' && url.searchParams.has('coa')) {
    const report = findLegacyReport(url.searchParams.get('coa'));
    url.pathname = report ? reportPath(report.lookupCode) : '/verify';
    url.search = ''; url.hash = '';
    invalidLegacy = !report;
  } else if (url.pathname === '/' && ['#testing', '#verify'].includes(url.hash)) {
    url.pathname = url.hash === '#testing' ? '/testing-methods' : '/verify';
    url.hash = '';
  }
  const page = resolvePageRoute(url.pathname);
  if (page) url.pathname = page.path;
  const coa = resolveCOARoute(url.pathname);
  if (coa?.report) { url.pathname = coa.canonicalPath; url.search = ''; }
  return { url, page, coa, invalidLegacy };
}

function renderCurrentRoute(focus = false, legacyError = false) {
  historyFocusRevision++;
  const current = routeLocation(location.href);
  if (current.url.href !== location.href) history.replaceState(null, '', current.url.pathname + current.url.search + current.url.hash);
  activeReport = null;
  clearTimeout(toastTimer);
  toast.hidden = true;
  pendingCopyKind = null;
  coaView.innerHTML = '';
  previousFocus = null;
  if (dialog.open) dialog.close();
  const page = current.page || PAGE_ROUTES[0];
  for (const route of PAGE_ROUTES) pageViews[route.path].hidden = !!current.coa || route.path !== page.path;
  coaView.hidden = !current.coa;
  document.body.classList.toggle('report-page', !!current.coa);
  const error = document.querySelector('#verify-error');
  error.textContent = legacyError || current.invalidLegacy ? 'No report matches that link. Enter a COA Lookup Code below.' : '';
  document.querySelector('#report-id').removeAttribute('aria-invalid');
  if (current.coa) {
    activeReport = current.coa.report;
    if (activeReport) {
      renderReport(activeReport);
      document.title = `Sample report · ${activeReport.lookupCode} · AssayNova`;
    } else {
      renderReportNotFound();
      document.title = 'COA not found · AssayNova';
    }
  } else document.title = page.title;
  if (!current.coa && page.path === '/submit-sample') requestPage.activate();
  const activePath = current.coa ? '/verify' : page.path;
  for (const link of document.querySelectorAll('.desktop-nav a,.mobile-nav a')) {
    if (new URL(link.getAttribute('href'), location.href).pathname === activePath) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (focus) document.getElementById(current.coa ? 'report-title' : page.heading)?.focus({ preventScroll: true });
  renderedURL = location.href;
}

function scrollToCurrentHash() {
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const target = id && document.getElementById(id);
  if (target && !target.closest('[hidden]')) target.scrollIntoView();
}

function navigateToURL(address) {
  historyFocusRevision++;
  const current = routeLocation(address);
  if (current.url.href !== location.href) history.pushState(null, '', current.url.pathname + current.url.search + current.url.hash);
  const previous = new URL(renderedURL, location.href);
  if (current.url.hash && previous.pathname === current.url.pathname && previous.search === current.url.search) {
    renderedURL = location.href;
    scrollToCurrentHash();
    return;
  }
  renderCurrentRoute(true, current.invalidLegacy);
  if (current.url.hash) scrollToCurrentHash();
  else window.scrollTo(0, 0);
}

function navigateToReport(code) { navigateToURL(lookupResultPath(code)); }

function renderPortal() {
  const requests = readRequests();
  const requestRows = requests.map((request) => {
    const multiple = request.version === 2;
    const sample = multiple ? `${request.samples.length} sample entr${request.samples.length === 1 ? 'y' : 'ies'} · ${request.samples[0].name}` : request.sample;
    const service = multiple && new Set(request.samples.map(entry => entry.service)).size > 1 ? 'Multiple testing services' : SERVICE_NAMES[request.service];
    return `<tr><td><strong>${escape(sample)}</strong><small>${escape(request.id)}</small></td><td>${escape(service)}<small>${escape(request.quantity)} ${multiple ? (Number(request.quantity) === 1 ? 'planned unit' : 'planned units') : `sample${request.quantity === 1 ? '' : 's'}`}</small></td><td><span class="state-tag state-pending">Draft · Not sent</span></td><td><button class="text-button" data-action="request-detail" data-id="${escape(request.id)}">Details ${icon('arrow-up', true)}</button></td></tr>`;
  }).join('');
  openDialog(`<div class="dialog-padding"><p class="dialog-eyebrow">ON THIS DEVICE</p><h2 class="dialog-title" id="dialog-title">Saved drafts</h2><p class="dialog-description">No account needed. These drafts are stored only in this browser.</p>
    <p class="demo-notice">These are saved drafts, not submitted requests. No email is sent when a draft is saved.</p>
    <div class="portal-toolbar"><h3 class="drafts-heading" id="saved-drafts-title">${requests.length} saved draft${requests.length === 1 ? '' : 's'}</h3><button class="button button-dark" data-action="request-new">${icon('plus', true)} New request</button></div>
    <section class="portal-panel" id="panel-requests" aria-labelledby="saved-drafts-title" tabindex="0">${requests.length ? `<table class="portal-table"><thead><tr><th scope="col">SAMPLE / REFERENCE</th><th scope="col">REQUESTED SERVICE</th><th scope="col">STATUS</th><th scope="col">DETAILS</th></tr></thead><tbody>${requestRows}</tbody></table><p class="portal-bottom-note">Drafts stay on this device until you clear this site's data. They have not been sent to the laboratory.</p>` : `<div class="empty-state">${icon('flask')}<h3>No saved drafts yet.</h3><p>Save a request draft to keep its details on this device. Nothing is sent.</p><button class="button button-teal" data-action="request-new">New request ${icon('arrow', true)}</button></div>`}</section></div>`, true);
}

function renderRequestDetail(id) {
  const request = readRequests().find((entry) => entry.id === id);
  if (!request) { renderPortal(); return; }
  if (request.version === 2) {
    openDialog(`<div class="dialog-padding"><p class="dialog-eyebrow">SAVED REQUEST</p><h2 class="dialog-title" id="dialog-title">Your saved request.</h2><div class="reference-box"><p>REQUEST REFERENCE</p><strong>${escape(request.id)}</strong></div><div data-request-private><dl class="success-details"><div><dt>Contact</dt><dd>${escape(request.name)}</dd></div><div><dt>Email</dt><dd>${escape(request.email)}</dd></div><div><dt>Report recipient</dt><dd>${escape(effectiveReportRecipient(request))}</dd></div><div><dt>Context</dt><dd>${escape(request.notes || 'No additional notes')}</dd></div></dl>${request.samples.map((sample, index) => `<section><h3>Sample ${index + 1} · ${escape(sample.name)}</h3><dl class="success-details"><div><dt>Service</dt><dd>${escape(SERVICE_NAMES[sample.service])}</dd></div><div><dt>Planned units</dt><dd>${sample.quantity}</dd></div><div><dt>Form</dt><dd>${escape(SAMPLE_FORMS[sample.form])}</dd></div><div><dt>Product image</dt><dd>${escape(IMAGE_CHOICES[sample.image])}${sample.image === 'include' ? ' · ' + escape(IMAGE_STYLES[sample.imageStyle]) : ''}</dd></div></dl></section>`).join('')}</div><p class="demo-notice">Draft · Not sent. Saved on this device; no request or email has been sent. Image files are not retained.</p><div class="dialog-buttons"><button class="button button-teal" data-action="request-resume" data-id="${escape(request.id)}">Resume editing</button><button class="button button-outline" data-action="request-new">New request</button><button class="text-button" data-action="requests">Back to saved drafts</button></div></div>`, true);
    return;
  }
  openDialog(`<div class="dialog-padding"><p class="dialog-eyebrow">SAVED REQUEST</p><h2 class="dialog-title" id="dialog-title">${escape(request.sample)}</h2><div class="reference-box"><p>REQUEST REFERENCE</p><strong>${escape(request.id)}</strong></div>
    <dl class="success-details"><div><dt>Contact</dt><dd>${escape(request.name)}</dd></div><div><dt>Contact email</dt><dd>${escape(request.email)}</dd></div><div><dt>Organization</dt><dd>${escape(request.company || 'Not provided')}</dd></div><div><dt>Service</dt><dd>${escape(SERVICE_NAMES[request.service])}</dd></div><div><dt>Samples</dt><dd>${escape(request.quantity)}</dd></div><div><dt>Status</dt><dd>Draft · Not sent</dd></div><div><dt>Notes</dt><dd>${escape(request.notes || 'No additional notes')}</dd></div></dl><p class="demo-notice">Saved on this device. Not sent to the laboratory. No email is sent when a draft is saved.</p><div class="dialog-buttons"><button class="button button-dark" data-action="requests">Back to saved drafts ${icon('arrow', true)}</button></div></div>`);
}

async function copyReportValue(kind) {
  const report = activeReport;
  if (!report) return;
  const value = kind === 'link' ? new URL(reportPath(report.lookupCode), location.origin).href : report.lookupCode;
  pendingCopyKind = kind;
  try {
    await navigator.clipboard.writeText(value);
    if (activeReport === report) showToast(kind === 'link' ? 'Report link copied.' : 'COA Lookup Code copied: ' + value);
  } catch {
    if (activeReport !== report) return;
    const fallback = document.querySelector('#report-copy-fallback');
    const field = document.querySelector('#report-copy-value');
    fallback.hidden = false;
    field.value = value;
    field.focus();
    field.select();
  }
}

document.addEventListener('click', (event) => {
  if (event.defaultPrevented) return;
  const anchor = event.target.closest('a[href]');
  if (anchor) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || anchor.hasAttribute('target') || anchor.hasAttribute('download')) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    let destination;
    try { destination = new URL(href, location.href); } catch { return; }
    if (destination.origin !== location.origin || !(resolvePageRoute(destination.pathname) || resolveCOARoute(destination.pathname))) return;
    if (destination.hash && destination.pathname === location.pathname && destination.search === location.search) return;
    event.preventDefault();
    closeMobileNavigation();
    navigateToURL(destination.href);
    return;
  }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const returnToMobileMenu = !!target.closest('#mobile-nav');
  closeMobileNavigation();
  const actions = {
    submit: () => renderSubmission(target.dataset.service),
    'request-new': () => renderSubmission(target.dataset.service, true),
    'request-resume': () => resumeRequest(target.dataset.id),
    'recover-report': () => renderRecovery(),
    report: () => navigateToReport(target.dataset.lookupCode),
    home: () => navigateToURL('/'),
    portal: () => renderPortal(),
    requests: () => renderPortal(),
    close: closeDialog,
    print: () => { if (activeReport) window.print(); },
    'copy-code': () => copyReportValue('code'),
    'copy-link': () => copyReportValue('link'),
    'copy-retry': () => copyReportValue(pendingCopyKind),
    'copy-select': () => { const field = document.querySelector('#report-copy-value'); field?.focus(); field?.select(); },
    'request-detail': () => renderRequestDetail(target.dataset.id)
  };
  actions[target.dataset.action]?.();
  if (returnToMobileMenu && dialog.open) previousFocus = menuButton;
});
document.addEventListener('submit', (event) => {
  if (!event.target.matches('#verify-form,#coa-lookup-form')) return;
  event.preventDefault();
  const input = event.target.querySelector('input[name="lookupCode"]');
  const report = findReportByLookupCode(input.value);
  const error = event.target.id === 'verify-form' ? document.querySelector('#verify-error') : document.querySelector('#coa-lookup-error');
  input.setAttribute('aria-invalid', String(!report));
  if (report) { error.textContent = ''; navigateToReport(report.lookupCode); }
  else if (event.target.id === 'coa-lookup-form') { navigateToReport(input.value); }
  else { error.textContent = 'No COA found. Use a COA Lookup Code, not a report or submission number.'; input.focus(); }
});
document.addEventListener('input', (event) => {
  if (!event.target.matches('#report-id,#coa-lookup-code')) return;
  const error = document.querySelector(event.target.id === 'report-id' ? '#verify-error' : '#coa-lookup-error');
  if (error) error.textContent = '';
  event.target.removeAttribute('aria-invalid');
});
document.querySelector('#demo-lookup').addEventListener('click', () => {
  document.querySelector('#report-id').value = DEMO_REPORT.lookupCode;
  document.querySelector('#verify-form').requestSubmit();
});

const menuButton = document.querySelector('.menu-toggle');
const mobileNavigation = document.querySelector('#mobile-nav');
function closeMobileNavigation() {
  mobileNavigation.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', 'Open navigation');
}
menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') === 'true';
  mobileNavigation.hidden = open;
  menuButton.setAttribute('aria-expanded', String(!open));
  menuButton.setAttribute('aria-label', open ? 'Open navigation' : 'Close navigation');
});
mobileNavigation.addEventListener('click', (event) => { if (event.target.closest('a')) closeMobileNavigation(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMobileNavigation(); });
window.matchMedia('(min-width: 1101px)').addEventListener('change', (event) => { if (event.matches) closeMobileNavigation(); });

function handleHistoryNavigation() {
  if (renderedURL === location.href) return;
  const previous = new URL(renderedURL, location.href);
  const current = routeLocation(location.href);
  if (previous.pathname === current.url.pathname && previous.search === current.url.search) {
    historyFocusRevision++;
    if (current.url.href !== location.href) history.replaceState(null, '', current.url.pathname + current.url.search + current.url.hash);
    renderedURL = location.href;
    return; // Native fragment focus/scroll and existing view state remain intact.
  }
  renderCurrentRoute();
  const revision = historyFocusRevision;
  const expectedURL = location.href;
  const headingId = current.coa ? 'report-title' : (current.page || PAGE_ROUTES[0]).heading;
  requestAnimationFrame(() => {
    // Native fragment focusing runs after popstate. Restore only the still-current
    // page heading; a later fragment, navigation or dialog cancels this callback.
    if (revision !== historyFocusRevision || location.href !== expectedURL || dialog.open) return;
    const heading = document.getElementById(headingId);
    if (heading && !heading.closest('[hidden]')) heading.focus({ preventScroll: true });
  });
}

window.addEventListener('popstate', handleHistoryNavigation);
window.addEventListener('hashchange', handleHistoryNavigation);
renderCurrentRoute();
scrollToCurrentHash();
