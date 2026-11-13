import { captureMailAction } from './account-mail.js';
import { DEMO_REPORT, SERVICE_NAMES, findReportByLookupCode, findLegacyReport, reportPath, lookupResultPath, resolveCOARoute, validateSubmission, normalizeLookupCode } from './data.js';
import { PAGE_ROUTES, resolvePageRoute } from './routes.js';
import { createRequestPage } from './request-page.js';
import { createCustomerAccountClient } from './customer-account.js';
import { createContactForm } from './contact-form.js';
import { requestKind } from './account-requests.js';
import { createAccountPage } from './account-page.js';
import { SAMPLE_REPORT_DATA } from './reports/sample-data.js';

let pendingMailAction = null;
function captureActionFragment() {
  const path = location.pathname;
  if (!['/verify-email', '/reset-password', '/verify-email/', '/reset-password/'].includes(path)) { pendingMailAction = null; return; }
  const exact = ['/verify-email', '/reset-password'].includes(path);
  if (location.hash || location.search || !pendingMailAction) {
    const token = exact ? captureMailAction(location, history) : null;
    pendingMailAction = { path: path.replace(/\/$/, ''), token };
    if (!exact) history.replaceState(null, '', path.replace(/\/$/, ''));
  }
}
captureActionFragment();

const dialog = document.querySelector('#app-dialog');
const dialogContent = document.querySelector('#dialog-content');
const toast = document.querySelector('#toast');
let previousFocus;
let toastTimer;
const pageViews = Object.fromEntries(PAGE_ROUTES.map((route) => [route.path, document.querySelector('#' + route.view)]));
const coaView = document.querySelector('#coa-view');
let renderedURL = '';
let historyFocusRevision = 0;
let activeReport = null;
let pendingCopyKind = null;
const publishedReaderEnabled = document.querySelector('meta[name="assaynova-report-reader"]')?.getAttribute('content') === 'enabled';
const accountsEnabled = document.querySelector('meta[name="assaynova-accounts"]')?.getAttribute('content') === 'enabled';
const accountClient = accountsEnabled ? createCustomerAccountClient() : null;
let accountLoadRevision = 0, accountLoadController = null;
for (const entry of document.querySelectorAll('[data-account-entry]')) entry.hidden = !accountsEnabled;
const publishedReports = new Map();
let lookupRevision = 0;
let lookupController;
function cancelPublishedLookup() { lookupRevision++; lookupController?.abort(); lookupController = null; }
async function fetchPublishedReport(code) {
  const controller = new AbortController();
  lookupController = controller;
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/__reports/' + code, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return null;
    const bundle = await response.json();
    if (bundle?.report?.lookupCode !== code || bundle.report.publication !== 'published' || !bundle.record || typeof bundle.label !== 'string' || bundle.assets?.svg !== '/__reports/' + code + '/report.svg' || bundle.assets?.pdf !== '/__reports/' + code + '/report.pdf') return null;
    return bundle;
  } catch { return null; }
  finally { clearTimeout(timeout); if (lookupController === controller) lookupController = null; }
}

const icon = (name, small = false) => `<svg class="icon${small ? ' small' : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function makeSampleId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const requestPage = createRequestPage(document.querySelector('#request-flow'), { makeId: makeSampleId, openMyRequests: () => navigateToURL('/account'), accountEnabled: accountsEnabled, saveAccountRequest: (record, options) => accountClient.saveRequest(record, options), onSignIn: () => navigateToURL('/login?next=' + encodeURIComponent('/submit-sample')) });
const contactForm = createContactForm(document.querySelector('#contact-form'), { client: accountClient, accountEnabled: accountsEnabled, makeId: makeSampleId, onSignIn: () => navigateToURL('/login?next=' + encodeURIComponent('/contact')), onView: () => navigateToURL('/account') });
let recoveryForm = null, recoveryOwnerId = null, recoveryReturn = null, recoveryCloseForAuth = false;
function clearRecoveryReturn() { recoveryReturn?.controller.destroy(); recoveryReturn = null; }
function signInForRecovery() {
  if (!recoveryForm || !recoveryOwnerId) return;
  recoveryForm.suspend();
  const node = dialogContent.firstElementChild;
  if (!node) return;
  recoveryReturn = { controller: recoveryForm, node, ownerId: recoveryOwnerId };
  node.remove(); recoveryForm = null; recoveryOwnerId = null; recoveryCloseForAuth = true;
  navigateToURL('/login?next=' + encodeURIComponent('/contact?request=report-recovery'));
}
const accountPage = accountsEnabled ? createAccountPage({ roots: Object.fromEntries(['/account', '/login', '/register', '/recover-account', '/verify-email', '/reset-password', '/google-signin'].map(path => [path, pageViews[path]?.querySelector('[data-account-content]')])), client: accountClient, navigate: navigateToURL, onResume: (doc, ownerId) => {
  const kind = requestKind(doc.record);
  if (kind === 'testing') { if (requestPage.resume(doc.record, { ...doc, ownerId })) navigateToURL('/submit-sample'); }
  else if (kind === 'contact') { navigateToURL('/contact'); contactForm?.resume(doc, ownerId); }
  else { navigateToURL('/contact'); renderRecovery(doc, ownerId); }
}, onNewRequest: () => renderSubmission(undefined, true), onRegistrationNotice: showToast }) : null;
accountClient?.subscribe((user, reason) => {
  requestPage.setAccountSession(user, reason); contactForm?.setAccountSession(user, reason); recoveryForm?.setAccountSession(user, reason);
  if (recoveryReturn) {
    if (reason === 'logout' || user && user.id !== recoveryReturn.ownerId) clearRecoveryReturn();
    else recoveryReturn.controller.setAccountSession(user, reason);
  }
});

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
  recoveryForm?.destroy(); recoveryForm = null; recoveryOwnerId = null;
  if (!recoveryCloseForAuth) clearRecoveryReturn(); recoveryCloseForAuth = false;
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

function renderRecovery(documentToEdit = null, ownerId = null) {
  const user = accountClient?.snapshot().user;
  if (!accountsEnabled) { navigateToURL('/contact'); return; }
  if (!user) { navigateToURL('/login?next=' + encodeURIComponent('/contact?request=report-recovery')); return; }
  recoveryForm?.destroy(); recoveryForm = null; recoveryOwnerId = user.id;
  if (recoveryReturn && recoveryReturn.ownerId === user.id && !documentToEdit) {
    const held = recoveryReturn; recoveryReturn = null; recoveryCloseForAuth = false;
    openDialog(''); dialogContent.appendChild(held.node); recoveryForm = held.controller;
    recoveryForm.setAccountSession(user); recoveryForm.activate(); dialogContent.querySelector('#dialog-title')?.focus({ preventScroll: true }); return;
  }
  clearRecoveryReturn();
  openDialog('<div class="nova-support-dialog" data-request-private><p class="dialog-eyebrow">NOVA SUPPORT</p><h2 class="dialog-title" id="dialog-title">Recover your report.</h2><p class="dialog-description">Submit a recovery request with the email used for testing and your company or project name. Manual identity verification is required before a report can be shared.</p><form id="recovery-form" class="recovery-form" novalidate><div class="form-grid" data-inquiry-fields><div class="form-field full"><label for="support-email">Testing email</label><input id="support-email" type="email" required maxlength="160" autocomplete="email" aria-describedby="support-error-email"><span class="field-error" id="support-error-email"></span></div><div class="form-field full"><label for="support-reference">Company or project name</label><input id="support-reference" required maxlength="160" aria-describedby="support-error-reference"><span class="field-error" id="support-error-reference"></span></div><div class="form-field full"><label for="support-notes">Additional context <span>Optional</span></label><textarea id="support-notes" maxlength="1200" aria-describedby="support-error-notes"></textarea><span class="field-error" id="support-error-notes"></span></div></div><p class="demo-notice" data-inquiry-gate></p><p id="support-error" class="inline-error" role="alert"></p><p id="support-status" role="status" data-request-private></p><div class="form-footer support-footer"><button class="button button-teal" type="submit" disabled>Submit recovery request</button><button class="text-button" type="button" data-inquiry-action="sign-in" hidden>Sign in to continue</button><button class="text-button" type="button" data-inquiry-action="view" hidden>View in My requests</button><button class="text-button" type="button" data-inquiry-action="new">New request</button></div></form></div>');
  recoveryForm = createContactForm(dialogContent.querySelector('#recovery-form'), { client: accountClient, accountEnabled: true, kind: 'report-recovery', makeId: makeSampleId, isVisible: () => dialog.open && location.pathname === '/contact', onSignIn: signInForRecovery, onView: () => navigateToURL('/account') });
  recoveryForm.setAccountSession(user); recoveryForm.activate();
  if (documentToEdit) recoveryForm.resume(documentToEdit, ownerId);
}

const SAMPLE_REPORT_ASSETS = Object.freeze({
  'AN-7K9Q-2M4X': Object.freeze({ label: 'Reference sample A', svg: '/reports/sample-a.svg', pdf: '/reports/sample-a.pdf' }),
  'AN-8P6R-3N5Y': Object.freeze({ label: 'Reference sample C', svg: '/reports/sample-c.svg', pdf: '/reports/sample-c.pdf' })
});

function lookupForm() {
  return `<form id="coa-lookup-form" class="coa-search" novalidate><label for="coa-lookup-code">Find another COA · Lookup Code</label><div class="coa-search-controls"><input id="coa-lookup-code" name="lookupCode" type="text" maxlength="64" autocomplete="off" spellcheck="false" placeholder="e.g. AN-XXXX-XXXX" aria-describedby="coa-lookup-error" required><button class="button button-dark" type="submit">Find report</button></div><p id="coa-lookup-error" class="inline-error" role="status"></p><p class="coa-help">Use a Lookup Code, not a report or submission number.</p></form>`;
}

function screeningPresentation(row) {
  const presented = { ...row };
  let redundant;
  if (row.test === 'Microbial analysis (PCR)' || row.test === 'Microbial Screening (PCR)') {
    presented.test = 'Microbial Screening (PCR)';
    if (row.result === 'Not detected') presented.result = 'No microbial DNA detected';
    redundant = 'Target microbial DNA not detected.';
  } else if (row.test === 'Fentanyl' || row.test === 'Fentanyl Screening') {
    presented.test = 'Fentanyl Screening';
    redundant = 'Target signal not detected in the screen.';
  } else return presented;
  if ((row.result === 'Not detected' && row.details === redundant) ||
      (row.result === 'Not assessed' && row.details === 'No result supplied')) presented.details = '';
  return presented;
}

function renderReport(report) {
  const generated = publishedReports.get(report.lookupCode);
  const sample = generated ? { label: generated.label, ...generated.assets } : Object.hasOwn(SAMPLE_REPORT_ASSETS, report.lookupCode) ? SAMPLE_REPORT_ASSETS[report.lookupCode] : null;
  const record = generated?.record ?? (Object.hasOwn(SAMPLE_REPORT_DATA, report.lookupCode) ? SAMPLE_REPORT_DATA[report.lookupCode] : null);
  if (!sample || !record) { renderReportNotFound(); return; }
  const fields = [['Product name', record.product], ['Appearance', record.appearance], ['Client', record.client], ['Report no.', record.reportId], ['Lot', record.lot], ['Accession no.', record.accession], ['Lookup Code', report.lookupCode], ['Received', record.received], ['Reported', record.reported]];
  const heading = `<h1 id="report-title" tabindex="-1"${generated ? '' : ' class="sr-only"'}>${escape(sample.label)}</h1>`;
  coaView.innerHTML = `<div class="coa-navigation"><a class="text-button" href="/" data-action="home">← Back to AssayNova</a><span>COA report</span></div><article class="coa-card coa-master-card" aria-labelledby="report-title"><header class="coa-master-heading">${generated ? `<div>${heading}</div>` : heading}<p class="coa-code">Lookup Code <strong>${escape(report.lookupCode)}</strong></p></header>
    <figure class="coa-master-paper"><img src="${sample.svg}" width="595" height="842" alt="${generated ? 'Certificate' : 'Illustrative certificate'} of analysis for ${escape(sample.label)}. Lookup Code ${escape(report.lookupCode)}. Report fields are also available below."></figure>
    ${generated ? '' : `<p class="report-disclaimer coa-master-disclosure"><strong>Sample report.</strong> ${escape(report.disclaimer)}</p>`}
    <div class="report-actions coa-master-tools"><a class="button button-dark" href="${sample.pdf}" download>Download PDF</a><a class="button button-outline" href="${sample.svg}" target="_blank" rel="noopener">View full size</a><button class="button button-outline" data-action="print">${icon('download', true)} Print / save PDF</button><button class="text-button" data-action="copy-code">Copy lookup code</button><button class="text-button" data-action="copy-link">Copy report link</button></div>
    <details class="coa-master-transcript"><summary>Report fields</summary><div class="coa-master-transcript-body"><section><h2>Sample information</h2><dl class="coa-master-field-list">${fields.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl></section><section><h2>Analytical results</h2><p>Two determinations of the same sample.</p><p>Purity (HPLC-UV area%)</p><dl class="coa-master-field-list">${['Replicate 1', 'Replicate 2', 'Mean'].map((label, index) => `<div><dt>${escape(label)}</dt><dd>${escape(record.purity[index])}%</dd></div>`).join('')}</dl><table><caption>Measured content · ${record.contentUnit === 'mixed' ? 'Per-analyte results' : escape(record.contentUnit || 'mg') + '/vial'}</caption><thead><tr><th scope="col">Analyte</th><th scope="col">Replicate 1</th><th scope="col">Replicate 2</th><th scope="col">Mean</th></tr></thead><tbody>${record.composition.map(row => `<tr><th scope="row">${escape(row.analyte)}${row.unit ? ' (' + escape(row.unit) + '/vial)' : ''}</th><td>${escape(row.sample1)}</td><td>${escape(row.sample2)}</td><td>${escape(row.summary)}</td></tr>`).join('')}</tbody></table></section><section><h2>Analytical figures</h2><p>HPLC-UV chromatogram. Principal retention time: ${escape(record.retentionTime)} min. Relative UV response, 0-100%. Fitted target areas total ${escape(record.purity[2])}%.</p><ul>${record.chromatogram.map(peak => `<li>${escape(peak.analyte)}: ${escape(peak.time)} min; fitted area ${escape(peak.area)}%; relative peak response ${escape(peak.response)}.</li>`).join('')}</ul><ul>${record.spectra.map(spectrum => `<li>${escape(spectrum.analyte)} / ${escape(spectrum.species)}: ${escape(spectrum.status)}. Scan ${spectrum.scan.map(escape).join('-')} m/z. ${spectrum.ions.map(ion => `${escape(ion.label)}: ${escape(ion.mz)} m/z; relative intensity ${escape(ion.intensity)}; isotope peaks ${ion.isotopes.map(peak => escape(peak.mz)).join(', ')} m/z`).join('; ')}.</li>`).join('')}</ul></section><section><h2>Screening outcomes</h2><dl class="coa-master-field-list">${record.screenings.map(screeningPresentation).map(row => `<div><dt>${escape(row.test)}</dt><dd>${escape(row.result)}${row.details ? ' · ' + escape(row.details) : ''}</dd></div>`).join('')}</dl><h2>Method</h2><p>${escape(record.method)}</p></section><section><h2>Signoff</h2><p>Dylan Greene</p><p>${escape(record.signoffTitle)}</p></section></div></details>
    <div id="report-copy-fallback" class="copy-fallback" role="region" aria-label="Manual copy" hidden><p>Automatic copy was unavailable. Select and copy the complete value below.</p><label for="report-copy-value">Value to copy</label><textarea id="report-copy-value" readonly></textarea><div class="dialog-buttons"><button class="text-button" data-action="copy-select">Select all</button><button class="text-button" data-action="copy-retry">Try copying again</button></div></div>
    </article>${lookupForm()}`;
}

function renderReportNotFound() {
  coaView.innerHTML = `<div class="coa-navigation"><a class="text-button" href="/" data-action="home">← Back to AssayNova</a><span>COA Lookup</span></div><div class="coa-not-found coa-card"><p class="eyebrow">COA LOOKUP</p><h1 id="report-title" tabindex="-1">No COA found.</h1><p>This code does not identify a published report. Check the Lookup Code or search again below.</p><p class="coa-help">Report and submission numbers are separate from Lookup Codes.</p></div>${lookupForm()}`;
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

function renderCurrentRoute(focus = false, legacyError = false, checked = null) {
  captureActionFragment();
  const actionToken = pendingMailAction?.token; pendingMailAction = null;
  cancelPublishedLookup();
  historyFocusRevision++;
  const current = routeLocation(location.href);
  const checkedCurrent = !!current.coa?.code && checked?.code === current.coa.code;
  if (checkedCurrent && checked.bundle) { current.coa.report = checked.bundle.report; current.coa.canonicalPath = lookupResultPath(current.coa.code); current.url.pathname = current.coa.canonicalPath; current.url.search = ''; }
  accountLoadRevision++; accountLoadController?.abort(); accountLoadController = null;
  if (renderedURL && new URL(renderedURL, location.href).pathname === '/submit-sample' && current.url.pathname !== '/submit-sample') requestPage.suspend();
  accountPage?.leave();
  contactForm?.suspend();
  recoveryForm?.destroy(); recoveryForm = null; recoveryOwnerId = null;
  const recoveryAuthPath = ['/login', '/register', '/recover-account'].includes(current.url.pathname) || current.url.pathname === '/contact' && current.url.search === '?request=report-recovery';
  if (!recoveryAuthPath) clearRecoveryReturn();
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
  error.textContent = legacyError || current.invalidLegacy ? 'No report matches that link. Enter a Lookup Code below.' : '';
  document.querySelector('#report-id').removeAttribute('aria-invalid');
  if (current.coa) {
    activeReport = current.coa.report;
    if (activeReport) {
      renderReport(activeReport);
      document.title = `${publishedReports.has(activeReport.lookupCode) ? 'COA report' : 'Sample report'} · ${activeReport.lookupCode} · AssayNova`;
    } else {
      renderReportNotFound();
      document.title = 'COA not found · AssayNova';
      if (publishedReaderEnabled && current.coa.code && !checkedCurrent) {
        const revision = lookupRevision, expectedURL = location.href;
        coaView.innerHTML = '<div class="coa-card"><h1 id="report-title" tabindex="-1">Finding your report…</h1><p role="status">Checking this Lookup Code.</p></div>';
        fetchPublishedReport(current.coa.code).then(bundle => {
          if (revision !== lookupRevision || location.href !== expectedURL) return;
          if (bundle) publishedReports.set(current.coa.code, bundle);
          else publishedReports.delete(current.coa.code);
          renderCurrentRoute(focus, false, { code: current.coa.code, bundle });
        });
      }
    }
  } else document.title = page.title;
  if (!current.coa && page.path === '/submit-sample') {
    requestPage.checkAccountSession(); requestPage.activate();
    if (accountClient) { const ticket = accountLoadRevision; const controller = new AbortController(); accountLoadController = controller; accountClient.getSession({ signal: controller.signal }).catch(() => { if (ticket === accountLoadRevision && !controller.signal.aborted) requestPage.setAccountSession(null, 'session'); }); }
  }
  if (!current.coa && ['/account', '/login', '/register', '/recover-account', '/verify-email', '/reset-password', '/google-signin'].includes(page.path)) {
    if (accountPage) void accountPage.activate(page.path, current.url.searchParams.get('next'), actionToken);
    else { const content = pageViews[page.path]?.querySelector('[data-account-content]'); if (content) content.innerHTML = '<div class="ac-card"><h2>Accounts are unavailable in this view.</h2><p>Public testing information and COA lookup remain available.</p><a href="/submit-sample">Explore testing</a></div>'; }
  }
  if (!current.coa && page.path === '/contact') {
    contactForm?.activate({ checking: !!accountClient });
    if (accountClient) {
      const ticket = accountLoadRevision, expectedURL = location.href, controller = new AbortController(); accountLoadController = controller;
      accountClient.getSession({ signal: controller.signal }).then(user => {
        if (ticket !== accountLoadRevision || controller.signal.aborted || location.href !== expectedURL) return;
        if (current.url.search === '?request=report-recovery') {
          if (!user) { navigateToURL('/login?next=' + encodeURIComponent('/contact?request=report-recovery'), { replace: true }); return; }
          history.replaceState(null, '', '/contact'); renderedURL = location.href; renderRecovery();
        }
      }).catch(() => { if (ticket === accountLoadRevision && !controller.signal.aborted) contactForm?.setAccountSession(null); });
    }
  }
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

function navigateToURL(address, { replace = false, checked = null } = {}) {
  cancelPublishedLookup();
  historyFocusRevision++;
  const current = routeLocation(address);
  if (current.url.href !== location.href) history[replace ? 'replaceState' : 'pushState'](null, '', current.url.pathname + current.url.search + current.url.hash);
  const previous = new URL(renderedURL, location.href);
  if (current.url.hash && previous.pathname === current.url.pathname && previous.search === current.url.search) {
    renderedURL = location.href;
    scrollToCurrentHash();
    return;
  }
  renderCurrentRoute(true, current.invalidLegacy, checked);
  if (current.url.hash) scrollToCurrentHash();
  else window.scrollTo(0, 0);
}

function navigateToReport(code, checked = null) { navigateToURL(lookupResultPath(code), { checked }); }

// Keep existing development locator declarations as safe account redirects.
function renderSuccess() { navigateToURL('/account'); }
function renderPortal() { navigateToURL('/account'); }
function renderRequestDetail() { navigateToURL('/account'); }

async function copyReportValue(kind) {
  const report = activeReport;
  if (!report) return;
  const value = kind === 'link' ? new URL(lookupResultPath(report.lookupCode), location.origin).href : report.lookupCode;
  pendingCopyKind = kind;
  try {
    await navigator.clipboard.writeText(value);
    if (activeReport === report) showToast(kind === 'link' ? 'Report link copied.' : 'Lookup Code copied: ' + value);
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
    'request-resume': () => navigateToURL('/account'),
    'request-account': () => navigateToURL('/account'),
    'request-legacy': () => navigateToURL('/account'),
    'recover-report': () => navigateToURL('/contact?request=report-recovery'),
    report: () => navigateToReport(target.dataset.lookupCode),
    home: () => navigateToURL('/'),
    portal: renderPortal,
    requests: renderPortal,
    close: closeDialog,
    print: () => { if (activeReport) window.print(); },
    'copy-code': () => copyReportValue('code'),
    'copy-link': () => copyReportValue('link'),
    'copy-retry': () => copyReportValue(pendingCopyKind),
    'copy-select': () => { const field = document.querySelector('#report-copy-value'); field?.focus(); field?.select(); },
    'request-detail': renderRequestDetail
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
  cancelPublishedLookup();
  const code = normalizeLookupCode(input.value);
  if (!report && publishedReaderEnabled && code) {
    const revision = lookupRevision, expectedURL = location.href, submittedValue = input.value;
    error.textContent = 'Finding your report…';
    input.removeAttribute('aria-invalid');
    fetchPublishedReport(code).then(bundle => {
      if (revision !== lookupRevision || location.href !== expectedURL || input.value !== submittedValue) return;
      if (bundle) { publishedReports.set(code, bundle); navigateToReport(code, { code, bundle }); }
      else {
        publishedReports.delete(code);
        if (event.target.id === 'coa-lookup-form') navigateToReport(code, { code, bundle: null });
        else { input.setAttribute('aria-invalid','true'); error.textContent = 'No COA found. Use a Lookup Code, not a report or submission number.'; input.focus(); }
      }
    });
    return;
  }
  input.setAttribute('aria-invalid', String(!report));
  if (report) { error.textContent = ''; navigateToReport(report.lookupCode); }
  else if (event.target.id === 'coa-lookup-form') { navigateToReport(input.value); }
  else { error.textContent = 'No COA found. Use a Lookup Code, not a report or submission number.'; input.focus(); }
});
document.addEventListener('input', (event) => {
  if (!event.target.matches('#report-id,#coa-lookup-code')) return;
  cancelPublishedLookup();
  const error = document.querySelector(event.target.id === 'report-id' ? '#verify-error' : '#coa-lookup-error');
  if (error) error.textContent = '';
  event.target.removeAttribute('aria-invalid');
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
  cancelPublishedLookup();
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
