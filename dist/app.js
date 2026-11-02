import { DEMO_REPORT, SERVICE_NAMES, findReportByLookupCode, findLegacyReport, reportPath, lookupResultPath, resolveCOARoute, validateSubmission } from './data.js';

const dialog = document.querySelector('#app-dialog');
const dialogContent = document.querySelector('#dialog-content');
const storageKey = 'assaynova.prototype.requests.v1';
const toast = document.querySelector('#toast');
let previousFocus;
let toastTimer;
const homeView = document.querySelector('#home-view');
const coaView = document.querySelector('#coa-view');
const homeTitle = document.title;
let activeReport = null;
let pendingCopyKind = null;

const icon = (name, small = false) => `<svg class="icon${small ? ' small' : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function readRequests() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(value) ? value.filter((request) => request && typeof request.id === 'string' && typeof request.sample === 'string' && Object.hasOwn(SERVICE_NAMES, request.service)).slice(0, 50) : [];
  } catch { return []; }
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function openDialog(html, wide = false) {
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
  document.body.classList.remove('dialog-open');
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
document.querySelector('.dialog-close').addEventListener('click', closeDialog);
dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog();
});

function renderAbout() {
  openDialog(`<div class="dialog-padding"><p class="dialog-eyebrow">ABOUT ASSAYNOVA</p><h2 class="dialog-title" id="dialog-title">About us</h2><p class="dialog-description">Purity and identity testing, with clear access to certificates of analysis. Explore our testing services and use a COA Lookup Code to find a published report.</p></div>`);
}

function renderContact() {
  openDialog(`<div class="dialog-padding"><p class="dialog-eyebrow">CONTACT ASSAYNOVA</p><h2 class="dialog-title" id="dialog-title">Contact us</h2><p class="dialog-description">Contact details coming soon.</p><p class="dialog-description">Our contact email will appear here once it is configured.</p></div>`);
}

function renderSubmission(service = 'comprehensive') {
  if (!Object.hasOwn(SERVICE_NAMES, service)) service = 'comprehensive';
  openDialog(`<div class="dialog-padding">
    <p class="dialog-eyebrow">YOUR NEXT ANSWER STARTS HERE</p>
    <h2 class="dialog-title" id="dialog-title">Tell us about your sample.</h2>
    <p class="dialog-description">No account needed. Add a contact email and the details of your testing request.</p>
    <div class="demo-notice email-connection"><p class="email-connection-heading"><strong>Email notifications</strong><span class="email-connection-status">Not connected</span></p><p>No email is sent. Save a draft on this device. Saving does not send your request to the laboratory.</p></div>
    <form class="submission-form" id="submission-form" novalidate>
      <div class="form-grid">
        <div class="form-field"><label for="request-name">Your name</label><input id="request-name" name="name" required maxlength="100" autocomplete="name" placeholder="Full name" aria-describedby="error-name"><span class="field-error" id="error-name"></span></div>
        <div class="form-field"><label for="request-email">Contact email</label><input id="request-email" name="email" type="email" required maxlength="160" autocomplete="email" placeholder="you@company.com" aria-describedby="request-email-help error-email"><small class="field-helper" id="request-email-help">For future request updates once email is connected. No email is sent now.</small><span class="field-error" id="error-email"></span></div>
        <div class="form-field full"><label for="request-company">Company or laboratory <span>Optional</span></label><input id="request-company" name="company" maxlength="160" autocomplete="organization" placeholder="Your organization"></div>
        <div class="form-field full"><label for="request-sample">Sample or project name</label><input id="request-sample" name="sample" required maxlength="160" placeholder="A name you will recognize" aria-describedby="error-sample"><span class="field-error" id="error-sample"></span></div>
        <div class="form-field"><label for="request-service">Testing service</label><select id="request-service" name="service" aria-describedby="error-service">${Object.entries(SERVICE_NAMES).map(([key, name]) => `<option value="${key}"${key === service ? ' selected' : ''}>${name}</option>`).join('')}</select><span class="field-error" id="error-service"></span></div>
        <div class="form-field"><label for="request-quantity">Number of samples</label><input id="request-quantity" name="quantity" type="number" min="1" max="100" step="1" value="1" required aria-describedby="error-quantity"><span class="field-error" id="error-quantity"></span></div>
        <div class="form-field full"><label for="request-notes">What would you like to understand? <span>Optional</span></label><textarea id="request-notes" name="notes" maxlength="1200" placeholder="Add context, questions, or specific testing needs."></textarea></div>
      </div>
      <p class="inline-error" id="submission-error" role="alert"></p>
      <div class="form-footer"><p>Review your details before saving.</p><button class="button button-teal" type="submit">Save request ${icon('arrow', true)}</button></div>
    </form>
  </div>`);
  const form = document.querySelector('#submission-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    for (const key of Object.keys(values)) values[key] = values[key].trim();
    const errors = validateSubmission(values);
    form.querySelectorAll('[aria-invalid]').forEach((input) => input.removeAttribute('aria-invalid'));
    form.querySelectorAll('.field-error').forEach((element) => { element.textContent = ''; });
    for (const [key, message] of Object.entries(errors)) {
      const field = form.elements.namedItem(key);
      field.setAttribute('aria-invalid', 'true');
      document.querySelector(`#error-${key}`).textContent = message;
    }
    if (Object.keys(errors).length) { form.querySelector('[aria-invalid=true]').focus(); return; }
    const request = {
      id: `AN-REQ-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      createdAt: new Date().toISOString(),
      ...values,
      quantity: Number(values.quantity),
      status: 'Draft request'
    };
    try { localStorage.setItem(storageKey, JSON.stringify([request, ...readRequests()].slice(0, 50))); }
    catch { document.querySelector('#submission-error').textContent = 'This browser could not save the request. Please enable local storage and try again.'; return; }
    renderSuccess(request);
  });
}

function renderSuccess(request) {
  openDialog(`<div class="dialog-padding"><div class="success-icon">${icon('check')}</div>
    <p class="dialog-eyebrow">SAVED DRAFT</p>
    <h2 class="dialog-title" id="dialog-title">Draft saved on this device.</h2>
    <p class="dialog-description">Your request draft is saved on this device. It has not been sent to the laboratory.</p>
    <div class="reference-box"><p>REQUEST REFERENCE</p><strong>${escape(request.id)}</strong></div>
    <dl class="success-details"><div><dt>Sample</dt><dd>${escape(request.sample)}</dd></div><div><dt>Contact email</dt><dd>${escape(request.email)}</dd></div><div><dt>Service</dt><dd>${escape(SERVICE_NAMES[request.service])}</dd></div><div><dt>Number of samples</dt><dd>${escape(request.quantity)}</dd></div><div><dt>Status</dt><dd>Draft · Not sent</dd></div></dl>
    <p class="demo-notice">Email notifications: Not connected. No email is sent. Reopen this draft from Saved drafts on this device.</p>
    <div class="dialog-buttons"><button class="button button-teal" data-action="requests">View saved drafts ${icon('arrow', true)}</button><button class="text-button" data-action="close">Back to website</button></div></div>`);
}

function reportChart() {
  return `<svg viewBox="0 0 520 160" role="img" aria-label="Shared chromatogram schematic, not report-specific measurements"><g class="chart-grid"><path d="M20 25H500M20 70H500M20 115H500"/></g><path class="chart-line" fill="none" stroke-width="2" d="M20 122H100Q108 120 112 100Q116 78 120 100Q124 122 134 122H250Q265 120 276 52Q286 10 296 52Q308 122 326 122H500"/><text x="20" y="150" class="chart-labels">SCHEMATIC ONLY · NO MEASURED RETENTION-TIME AXIS</text></svg>`;
}

function lookupForm() {
  return `<form id="coa-lookup-form" class="coa-search" novalidate><label for="coa-lookup-code">Find another COA · COA Lookup Code</label><div class="coa-search-controls"><input id="coa-lookup-code" name="lookupCode" type="text" maxlength="64" autocomplete="off" spellcheck="false" placeholder="e.g. AN-8P6R-3N5Y" aria-describedby="coa-lookup-error" required><button class="button button-dark" type="submit">Find report</button></div><p id="coa-lookup-error" class="inline-error" role="status"></p><p class="coa-help">Use a COA Lookup Code, not a report or submission number.</p></form>`;
}

function renderReport(report) {
  const identityMatched = report.identityOutcome === 'matched';
  coaView.innerHTML = `<div class="coa-navigation"><a class="text-button" href="/" data-action="home">← Back to AssayNova</a><span>COA report</span></div><article class="coa-card" aria-labelledby="report-title"><div class="report-heading"><div class="brand"><img src="/assets/assaynova-logo.png" alt="AssayNova" width="2172" height="724"></div>
    <div class="report-header-row"><div><p class="dialog-eyebrow">REPORT DETAILS</p><h1 id="report-title" tabindex="-1">Certificate of analysis</h1><p>${escape(report.id)} · Report date ${escape(report.issued)}</p></div><span class="report-demo-label">Sample report</span></div><p class="coa-code">COA Lookup Code <strong>${escape(report.lookupCode)}</strong></p></div>
    <div class="report-body"><dl class="report-meta"><div><dt>Sample name</dt><dd>${escape(report.sample)}</dd></div><div><dt>Batch reference</dt><dd>${escape(report.batch)}</dd></div><div><dt>Sample received</dt><dd>${escape(report.received)}</dd></div><div><dt>Analysis method</dt><dd>${escape(report.method)}</dd></div><div><dt>Report number</dt><dd>${escape(report.id)}</dd></div><div><dt>Publication</dt><dd>${escape(report.publication)}</dd></div><div><dt>Version</dt><dd>${escape(report.version)}</dd></div><div><dt>Retention time</dt><dd>${escape(report.retentionTime)}</dd></div></dl>
      <div class="report-results"><div><span>Chromatographic purity</span><strong>${escape(report.purity)}</strong></div><div><span>Identity check</span><strong class="identity-result ${identityMatched ? 'identity-matched' : 'identity-neutral'}">${identityMatched ? icon('check') : ''}${escape(report.identity)}</strong></div></div>
      <div class="report-chart"><h3>Chromatogram schematic</h3>${reportChart()}<p class="coa-help">Shared schematic, not report-specific analytical data.</p></div>
      <p class="report-disclaimer"><strong>Sample report.</strong> ${escape(report.disclaimer)}</p>
      <div class="report-actions"><button class="button button-dark" data-action="print">${icon('download', true)} Print / save PDF</button><button class="text-button" data-action="copy-code">Copy lookup code</button><button class="text-button" data-action="copy-link">Copy report link</button></div>
      <div id="report-copy-fallback" class="copy-fallback" role="region" aria-label="Manual copy" hidden><p>Automatic copy was unavailable. Select and copy the complete value below.</p><label for="report-copy-value">Value to copy</label><textarea id="report-copy-value" readonly></textarea><div class="dialog-buttons"><button class="text-button" data-action="copy-select">Select all</button><button class="text-button" data-action="copy-retry">Try copying again</button></div></div>
    </div></article>${lookupForm()}`;
}

function renderReportNotFound() {
  coaView.innerHTML = `<div class="coa-navigation"><a class="text-button" href="/" data-action="home">← Back to AssayNova</a><span>COA Lookup</span></div><div class="coa-not-found coa-card"><p class="eyebrow">COA LOOKUP</p><h1 id="report-title" tabindex="-1">No COA found.</h1><p>This code does not identify a published report. Check the COA Lookup Code or search again below.</p><p class="coa-help">Report and submission numbers are separate from COA Lookup Codes.</p></div>${lookupForm()}`;
}

function renderCurrentRoute(focus = false) {
  const url = new URL(location.href);
  const legacy = url.pathname === '/' && url.searchParams.has('coa');
  const legacyReport = legacy ? findLegacyReport(url.searchParams.get('coa')) : null;
  if (legacyReport) {
    history.replaceState(null, '', reportPath(legacyReport.lookupCode));
    url.pathname = reportPath(legacyReport.lookupCode);
  }
  const route = resolveCOARoute(url.pathname);
  activeReport = null;
  clearTimeout(toastTimer);
  toast.hidden = true;
  pendingCopyKind = null;
  coaView.innerHTML = '';
  previousFocus = null;
  if (dialog.open) dialog.close();
  homeView.hidden = !!route;
  coaView.hidden = !route;
  document.body.classList.toggle('report-page', !!route);
  if (route) {
    activeReport = route.report;
    if (activeReport) {
      if (location.pathname !== route.canonicalPath || location.search || location.hash) history.replaceState(null, '', route.canonicalPath);
      renderReport(activeReport);
      document.title = `${activeReport.id} · ${activeReport.lookupCode} · AssayNova`;
    } else {
      renderReportNotFound();
      document.title = 'COA not found · AssayNova';
    }
    if (focus) coaView.querySelector('#report-title')?.focus({ preventScroll: true });
  } else {
    document.title = homeTitle;
    if (legacy && !legacyReport) {
      document.querySelector('#verify-error').textContent = 'No report matches that link. Enter a COA Lookup Code below.';
      document.querySelector('#verify').scrollIntoView();
    }
    if (focus) document.querySelector('#hero-title').focus({ preventScroll: true });
  }
}

function navigateToReport(code) {
  const destination = lookupResultPath(code);
  history.pushState(null, '', destination);
  renderCurrentRoute(true);
  window.scrollTo(0, 0);
}

function renderPortal() {
  const requests = readRequests();
  const requestRows = requests.map((request) => `<tr><td><strong>${escape(request.sample)}</strong><small>${escape(request.id)}</small></td><td>${escape(SERVICE_NAMES[request.service])}<small>${escape(request.quantity)} sample${request.quantity === 1 ? '' : 's'}</small></td><td><span class="state-tag state-pending">Draft · Not sent</span></td><td><button class="text-button" data-action="request-detail" data-id="${escape(request.id)}">Details ${icon('arrow-up', true)}</button></td></tr>`).join('');
  openDialog(`<div class="dialog-padding"><p class="dialog-eyebrow">ON THIS DEVICE</p><h2 class="dialog-title" id="dialog-title">Saved drafts</h2><p class="dialog-description">No account needed. These drafts are stored only in this browser.</p>
    <p class="demo-notice">Not sent to the laboratory. Email notifications are not connected, so no email is sent.</p>
    <div class="portal-toolbar"><h3 class="drafts-heading" id="saved-drafts-title">${requests.length} saved draft${requests.length === 1 ? '' : 's'}</h3><button class="button button-dark" data-action="submit">${icon('plus', true)} New request</button></div>
    <section class="portal-panel" id="panel-requests" aria-labelledby="saved-drafts-title" tabindex="0">${requests.length ? `<table class="portal-table"><thead><tr><th scope="col">SAMPLE / REFERENCE</th><th scope="col">REQUESTED SERVICE</th><th scope="col">STATUS</th><th scope="col">DETAILS</th></tr></thead><tbody>${requestRows}</tbody></table><p class="portal-bottom-note">Drafts stay on this device until you clear this site's data. They have not been sent to the laboratory.</p>` : `<div class="empty-state">${icon('flask')}<h3>No saved drafts yet.</h3><p>Save a request draft to keep its details on this device. Nothing is sent.</p><button class="button button-teal" data-action="submit">New request ${icon('arrow', true)}</button></div>`}</section></div>`, true);
}

function renderRequestDetail(id) {
  const request = readRequests().find((entry) => entry.id === id);
  if (!request) { renderPortal(); return; }
  openDialog(`<div class="dialog-padding"><p class="dialog-eyebrow">SAVED REQUEST</p><h2 class="dialog-title" id="dialog-title">${escape(request.sample)}</h2><div class="reference-box"><p>REQUEST REFERENCE</p><strong>${escape(request.id)}</strong></div>
    <dl class="success-details"><div><dt>Contact</dt><dd>${escape(request.name)}</dd></div><div><dt>Contact email</dt><dd>${escape(request.email)}</dd></div><div><dt>Organization</dt><dd>${escape(request.company || 'Not provided')}</dd></div><div><dt>Service</dt><dd>${escape(SERVICE_NAMES[request.service])}</dd></div><div><dt>Samples</dt><dd>${escape(request.quantity)}</dd></div><div><dt>Status</dt><dd>Draft · Not sent</dd></div><div><dt>Notes</dt><dd>${escape(request.notes || 'No additional notes')}</dd></div></dl><p class="demo-notice">Saved on this device. Not sent to the laboratory. Email notifications: Not connected. No email is sent.</p><div class="dialog-buttons"><button class="button button-dark" data-action="requests">Back to saved drafts ${icon('arrow', true)}</button></div></div>`);
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
  const target = event.target.closest('[data-action]');
  if (!target) return;
  if (target.matches('a[href]')) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
  }
  closeMobileNavigation();
  const actions = {
    about: renderAbout,
    contact: renderContact,
    submit: () => renderSubmission(target.dataset.service),
    report: () => navigateToReport(target.dataset.lookupCode),
    home: () => { history.pushState(null, '', '/'); renderCurrentRoute(true); window.scrollTo(0, 0); },
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
window.matchMedia('(min-width: 761px)').addEventListener('change', (event) => { if (event.matches) closeMobileNavigation(); });

window.addEventListener('popstate', () => renderCurrentRoute(true));
renderCurrentRoute();
