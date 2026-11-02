import { DEMO_REPORT, SERVICE_NAMES, findDemoReport, validateSubmission } from './data.js';

const dialog = document.querySelector('#app-dialog');
const dialogContent = document.querySelector('#dialog-content');
const storageKey = 'assaynova.prototype.requests.v1';
const toast = document.querySelector('#toast');
let previousFocus;
let toastTimer;

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

function renderSubmission(service = 'comprehensive') {
  if (!Object.hasOwn(SERVICE_NAMES, service)) service = 'comprehensive';
  openDialog(`<div class="dialog-padding">
    <p class="dialog-eyebrow">YOUR NEXT ANSWER STARTS HERE</p>
    <h2 class="dialog-title" id="dialog-title">Tell us about your sample.</h2>
    <p class="dialog-description">A few details to bring your testing request into focus.</p>
    <p class="demo-notice">Concept preview · Requests are saved on this device only. They are not sent to a laboratory.</p>
    <form class="submission-form" id="submission-form" novalidate>
      <div class="form-grid">
        <div class="form-field"><label for="request-name">Your name</label><input id="request-name" name="name" required maxlength="100" autocomplete="name" placeholder="Full name" aria-describedby="error-name"><span class="field-error" id="error-name"></span></div>
        <div class="form-field"><label for="request-email">Email address</label><input id="request-email" name="email" type="email" required maxlength="160" autocomplete="email" placeholder="you@company.com" aria-describedby="error-email"><span class="field-error" id="error-email"></span></div>
        <div class="form-field full"><label for="request-company">Company or laboratory <span>Optional</span></label><input id="request-company" name="company" maxlength="160" autocomplete="organization" placeholder="Your organization"></div>
        <div class="form-field full"><label for="request-sample">Sample or project name</label><input id="request-sample" name="sample" required maxlength="160" placeholder="A name you will recognize" aria-describedby="error-sample"><span class="field-error" id="error-sample"></span></div>
        <div class="form-field"><label for="request-service">Testing service</label><select id="request-service" name="service" aria-describedby="error-service">${Object.entries(SERVICE_NAMES).map(([key, name]) => `<option value="${key}"${key === service ? ' selected' : ''}>${name}</option>`).join('')}</select><span class="field-error" id="error-service"></span></div>
        <div class="form-field"><label for="request-quantity">Number of samples</label><input id="request-quantity" name="quantity" type="number" min="1" max="100" step="1" value="1" required aria-describedby="error-quantity"><span class="field-error" id="error-quantity"></span></div>
        <div class="form-field full"><label for="request-notes">What would you like to understand? <span>Optional</span></label><textarea id="request-notes" name="notes" maxlength="1200" placeholder="Add context, questions, or specific testing needs."></textarea></div>
      </div>
      <p class="inline-error" id="submission-error" role="alert"></p>
      <div class="form-footer"><p>No payment or shipment is needed to try this preview.</p><button class="button button-teal" type="submit">Save demo request ${icon('arrow', true)}</button></div>
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
      id: `AN-DEMO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
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
    <p class="dialog-eyebrow">YOUR DEMO REQUEST IS SAVED</p>
    <h2 class="dialog-title" id="dialog-title">One step closer to clarity.</h2>
    <p class="dialog-description">Your preview request is ready to explore in the client portal. Nothing has been sent to a laboratory.</p>
    <div class="reference-box"><p>YOUR PREVIEW REFERENCE</p><strong>${escape(request.id)}</strong></div>
    <dl class="success-details"><div><dt>Sample</dt><dd>${escape(request.sample)}</dd></div><div><dt>Service</dt><dd>${escape(SERVICE_NAMES[request.service])}</dd></div><div><dt>Number of samples</dt><dd>${request.quantity}</dd></div><div><dt>Status</dt><dd>Draft request · local preview</dd></div></dl>
    <p class="demo-notice">In the finished platform, the laboratory would review your request and confirm sample requirements, pricing, and shipping instructions.</p>
    <div class="dialog-buttons"><button class="button button-teal" data-action="requests">View in client portal ${icon('arrow', true)}</button><button class="text-button" data-action="close">Back to website</button></div></div>`);
}

function reportChart() {
  return document.querySelector('.hero-chromatogram').innerHTML.replaceAll('peak-fill', 'report-peak-fill');
}

function renderReport() {
  const report = DEMO_REPORT;
  openDialog(`<div class="report-heading"><div class="brand"><img src="/assets/assaynova-logo.png" alt="AssayNova" width="2172" height="724"></div>
    <div class="report-header-row"><div><p class="dialog-eyebrow">ILLUSTRATIVE LABORATORY REPORT</p><h2 id="dialog-title">Certificate of analysis</h2><p>${report.id} · Issued ${report.issued}</p></div><span class="report-demo-label">DEMONSTRATION ONLY</span></div></div>
    <div class="report-body"><dl class="report-meta"><div><dt>Sample name</dt><dd>${report.sample}</dd></div><div><dt>Batch reference</dt><dd>${report.batch}</dd></div><div><dt>Sample received</dt><dd>${report.received}</dd></div><div><dt>Analysis method</dt><dd>${report.method}</dd></div></dl>
      <div class="report-results"><div><span>Chromatographic purity</span><strong>${report.purity}</strong></div><div><span>Identity check</span><strong>${icon('check')}${report.identity}</strong></div></div>
      <div class="report-chart"><h3>Chromatographic profile · illustrative</h3>${reportChart()}</div>
      <p class="report-disclaimer"><strong>Not a valid COA.</strong> ${report.disclaimer}</p>
      <div class="report-actions"><button class="button button-dark" data-action="print">${icon('download', true)} Print / save demo PDF</button><button class="text-button" data-action="copy">Copy report reference ${icon('file', true)}</button></div>
    </div>`, true);
}

function renderPortal(tab = 'reports') {
  const requests = readRequests();
  const requestRows = requests.map((request) => `<tr><td><strong>${escape(request.sample)}</strong><small>${escape(request.id)}</small></td><td>${escape(SERVICE_NAMES[request.service])}<small>${request.quantity} sample${request.quantity === 1 ? '' : 's'}</small></td><td><span class="state-tag state-pending">Draft request</span></td><td><button class="text-button" data-action="request-detail" data-id="${escape(request.id)}">Details ${icon('arrow-up', true)}</button></td></tr>`).join('');
  openDialog(`<div class="dialog-padding"><p class="dialog-eyebrow">YOUR CONNECTED LAB WORKSPACE</p><h2 class="dialog-title" id="dialog-title">A place for every detail.</h2><p class="dialog-description">An early look at your sample requests and reports.</p>
    <p class="demo-notice">Demo workspace · Report data is fictional. Saved requests are only available in this browser; no sign-in or real order is created.</p>
    <div class="portal-toolbar"><div class="portal-tabs" role="tablist" aria-label="Workspace sections"><button class="portal-tab" id="tab-reports" role="tab" data-tab="reports" aria-selected="${tab === 'reports'}" aria-controls="panel-reports" tabindex="${tab === 'reports' ? '0' : '-1'}">Reports</button><button class="portal-tab" id="tab-requests" role="tab" data-tab="requests" aria-selected="${tab === 'requests'}" aria-controls="panel-requests" tabindex="${tab === 'requests' ? '0' : '-1'}">My requests (${requests.length})</button></div><button class="button button-dark" data-action="submit">${icon('plus', true)} New request</button></div>
    <div class="portal-panel" id="panel-reports" role="tabpanel" aria-labelledby="tab-reports" tabindex="0"${tab !== 'reports' ? ' hidden' : ''}><table class="portal-table"><thead><tr><th scope="col">SAMPLE / REFERENCE</th><th scope="col">ANALYSIS</th><th scope="col">STATUS</th><th scope="col">REPORT</th></tr></thead><tbody><tr><td><strong>Reference sample A</strong><small>${DEMO_REPORT.id}</small></td><td>HPLC / LC–MS<small>Fictional sample</small></td><td><span class="state-tag">Completed</span></td><td><button class="text-button" data-action="report">Open COA ${icon('arrow-up', true)}</button></td></tr><tr><td><strong>Reference sample B</strong><small>Illustrative workflow</small></td><td>HPLC<small>Fictional sample</small></td><td><span class="state-tag state-pending">In analysis</span></td><td>—</td></tr></tbody></table><p class="portal-bottom-note">The entries above demonstrate the intended workspace. They do not represent actual samples or live testing activity.</p></div>
    <div class="portal-panel" id="panel-requests" role="tabpanel" aria-labelledby="tab-requests" tabindex="0"${tab !== 'requests' ? ' hidden' : ''}>${requests.length ? `<table class="portal-table"><thead><tr><th scope="col">SAMPLE / REFERENCE</th><th scope="col">REQUESTED SERVICE</th><th scope="col">STATUS</th><th scope="col">DETAILS</th></tr></thead><tbody>${requestRows}</tbody></table><p class="portal-bottom-note">These are local preview requests. They have not been transmitted to a laboratory.</p>` : `<div class="empty-state">${icon('flask')}<h3>Your next sample starts here.</h3><p>Create a demo request to see how this workspace comes together.</p><button class="button button-teal" data-action="submit">Create a demo request ${icon('arrow', true)}</button></div>`}</div></div>`, true);
}

function selectPortalTab(tab, focus = false) {
  dialog.querySelectorAll('[data-tab]').forEach((button) => {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (focus && selected) button.focus();
  });
  for (const name of ['reports', 'requests']) {
    const panel = document.querySelector(`#panel-${name}`);
    if (panel) panel.hidden = name !== tab;
  }
}

function renderRequestDetail(id) {
  const request = readRequests().find((entry) => entry.id === id);
  if (!request) { renderPortal('requests'); return; }
  openDialog(`<div class="dialog-padding"><p class="dialog-eyebrow">SAVED PREVIEW REQUEST</p><h2 class="dialog-title" id="dialog-title">${escape(request.sample)}</h2><div class="reference-box"><p>YOUR PREVIEW REFERENCE</p><strong>${escape(request.id)}</strong></div>
    <dl class="success-details"><div><dt>Contact</dt><dd>${escape(request.name)}</dd></div><div><dt>Email</dt><dd>${escape(request.email)}</dd></div><div><dt>Organization</dt><dd>${escape(request.company || 'Not provided')}</dd></div><div><dt>Service</dt><dd>${escape(SERVICE_NAMES[request.service])}</dd></div><div><dt>Samples</dt><dd>${escape(request.quantity)}</dd></div><div><dt>Status</dt><dd>Draft request · local preview</dd></div><div><dt>Notes</dt><dd>${escape(request.notes || 'No additional notes')}</dd></div></dl><p class="demo-notice">Saved on this device only. Nothing has been sent to a laboratory.</p><div class="dialog-buttons"><button class="button button-dark" data-action="requests">Back to requests ${icon('arrow', true)}</button></div></div>`);
}

async function copyReference() {
  try { await navigator.clipboard.writeText(DEMO_REPORT.id); showToast('Copied: ' + DEMO_REPORT.id); }
  catch { showToast('Report reference: ' + DEMO_REPORT.id); }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  closeMobileNavigation();
  const actions = {
    submit: () => renderSubmission(target.dataset.service),
    report: renderReport,
    portal: () => renderPortal(),
    requests: () => renderPortal('requests'),
    close: closeDialog,
    print: () => window.print(),
    copy: copyReference,
    'request-detail': () => renderRequestDetail(target.dataset.id)
  };
  actions[target.dataset.action]?.();
});
dialog.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) selectPortalTab(tab.dataset.tab);
});
dialog.addEventListener('keydown', (event) => {
  if (!event.target.matches('[data-tab]')) return;
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tab = event.key === 'Home' ? 'reports' : event.key === 'End' ? 'requests' : event.target.dataset.tab === 'reports' ? 'requests' : 'reports';
    selectPortalTab(tab, true);
  }
});

document.querySelector('#verify-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.querySelector('#report-id');
  const report = findDemoReport(input.value);
  const error = document.querySelector('#verify-error');
  input.setAttribute('aria-invalid', String(!report));
  if (report) { error.textContent = ''; renderReport(); }
  else { error.textContent = 'No demo report found. Try AN-2026-0042.'; input.focus(); }
});
document.querySelector('#report-id').addEventListener('input', (event) => {
  document.querySelector('#verify-error').textContent = '';
  event.target.removeAttribute('aria-invalid');
});
document.querySelector('#demo-lookup').addEventListener('click', () => {
  document.querySelector('#report-id').value = DEMO_REPORT.id;
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

const sharedReference = new URL(window.location.href).searchParams.get('coa');
if (sharedReference) {
  document.querySelector('#report-id').value = sharedReference;
  if (findDemoReport(sharedReference)) renderReport();
  else {
    document.querySelector('#verify-error').textContent = 'No demo report found. Try AN-2026-0042.';
    document.querySelector('#report-id').setAttribute('aria-invalid', 'true');
    document.querySelector('#verify').scrollIntoView();
  }
}
