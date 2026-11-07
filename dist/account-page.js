import { SERVICE_NAMES } from './data.js';
import { SAMPLE_FORMS, IMAGE_CHOICES, IMAGE_STYLES } from './submission.js';
import { REQUEST_KINDS, requestDetails, requestKind, requestStatus, requestSummary } from './account-requests.js';
import { CONTACT_TOPICS } from './contact.js';
import { validAccountPassword, safeAccountNext, accountErrorMessage, AccountError } from './customer-account.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const emailOK = value => typeof value === 'string' && value.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const field = (name, label, { type = 'text', maximum = 160, autocomplete = '', value = '', required = true, help = '' } = {}) => `<div class="ac-field"><label for="ac-${name}">${label}${required ? '' : ' <span>Optional</span>'}</label><input id="ac-${name}" name="${name}" type="${type}" maxlength="${maximum}"${required ? ' required' : ''}${autocomplete ? ` autocomplete="${autocomplete}"` : ''} value="${escape(value)}" aria-describedby="ac-${name}-error${help ? ` ac-${name}-help` : ''}">${help ? `<p class="ac-help" id="ac-${name}-help">${help}</p>` : ''}<p class="ac-field-error" id="ac-${name}-error"></p></div>`;
const password = (name, label, current = false) => field(name, label, { type: 'password', maximum: 256, autocomplete: current ? 'current-password' : 'new-password', help: current ? '' : 'Use 15–128 characters. Spaces are allowed.' });
const submit = label => `<button class="button button-teal" type="submit">${label}<span aria-hidden="true"> →</span></button>`;
const notice = '<p class="ac-note">Manage your submitted requests here. Older saved requests need explicit review and submission.</p>';

export function createAccountPage({ roots, client, navigate, onResume, onNewRequest, clipboard = value => globalThis.navigator.clipboard.writeText(value) }) {
  let path = '', root = null, revision = 0, actionRevision = 0, controller = null, busy = false;
  let user = null, documents = [], tab = 'requests', selected = null, pendingDelete = null, codes = null, codesNext = '/account', next = '/account';
  const current = (ticket, action) => root && ticket === revision && (action === undefined || action === actionRevision) && !controller?.signal.aborted;
  function clearCodes() { if (codes) codes.fill(''); codes = null; }
  function leave() { revision++; actionRevision++; controller?.abort(); controller = null; clearCodes(); for (const node of Object.values(roots)) if (node) node.innerHTML = ''; path = ''; root = null; busy = false; user = null; documents = []; selected = null; pendingDelete = null; }
  const errorNode = () => root?.querySelector('[data-account-error]');
  function report(message) { const node = errorNode(); if (node) { node.textContent = message; node.focus?.({ preventScroll: true }); } }
  function status(message) { const node = root?.querySelector('[data-account-status]'); if (node) node.textContent = message; }
  function shell(content) { root.innerHTML = `<div class="ac-content" data-request-private><p class="ac-error" data-account-error role="alert" tabindex="-1"></p><p class="ac-status" data-account-status role="status"></p>${content}</div>`; }
  function form(kind, content) { const unique = content.replace(/((?:id|for)=")ac-/g, '$1ac-' + kind + '-').replace(/(aria-describedby=")([^"]+)/g, (_, prefix, ids) => prefix + ids.replace(/\bac-/g, 'ac-' + kind + '-')); return `<form data-account-form="${kind}" novalidate><fieldset class="ac-form-lock">${unique}</fieldset></form>`; }
  function auth() {
    if (path === '/login') shell(`<div class="ac-card"><p class="ac-kicker">WELCOME BACK</p><h2>Sign in to your workspace.</h2><p class="ac-intro">Submit and manage your requests in one account.</p>${form('login', field('email', 'Email', { type: 'email', maximum: 160, autocomplete: 'email' }) + password('password', 'Password', true) + submit('Sign in'))}<p class="ac-links"><a href="/register?next=${encodeURIComponent(next)}">Create an account</a><a href="/recover-account?next=${encodeURIComponent(next)}">Use a recovery code</a></p></div>`);
    else if (path === '/register') shell(`<div class="ac-card"><p class="ac-kicker">YOUR NEXT ANALYSIS</p><h2>A place for your requests.</h2><p class="ac-intro">Create an account to submit and manage testing, contact and report recovery requests.</p>${form('register', `<div class="ac-field-grid">${field('name', 'Your name', { maximum: 100, autocomplete: 'name', required: false })}${field('company', 'Company', { autocomplete: 'organization', required: false })}</div>` + field('email', 'Email', { type: 'email', maximum: 160, autocomplete: 'email' }) + password('password', 'Password') + password('confirmPassword', 'Repeat password') + submit('Create account'))}<p class="ac-links">Already have an account? <a href="/login?next=${encodeURIComponent(next)}">Sign in</a></p>${notice}</div>`);
    else shell(`<div class="ac-card"><p class="ac-kicker">ACCOUNT RECOVERY</p><h2>Find your way back.</h2><p class="ac-intro">Use one of your saved recovery codes to set a new password. Email reset links are not available.</p>${form('recover', field('email', 'Account email', { type: 'email', maximum: 160, autocomplete: 'email' }) + field('recoveryCode', 'Recovery code', { maximum: 128, autocomplete: 'off' }) + password('newPassword', 'New password') + password('confirmPassword', 'Repeat new password') + submit('Recover account'))}<p class="ac-links"><a href="/login?next=${encodeURIComponent(next)}">Back to sign in</a></p><p class="ac-help">Report recovery is separate. Nova Support can help prepare a report enquiry, but cannot reset an account password.</p></div>`);
  }
  function dashboard(focusHeading = false) {
    const navigation = `<div class="ac-workspace-bar"><div><p class="ac-kicker">YOUR WORKSPACE</p><p class="ac-user-name">${escape(user.name || 'My account')}</p><p class="ac-help">${escape(user.email)} · Email not verified</p></div><button type="button" class="text-button" data-account-action="logout">Sign out</button></div><nav class="ac-tabs" aria-label="Account sections">${[['requests', 'My requests'], ['profile', 'Profile'], ['security', 'Security']].map(([key, label]) => `<button type="button" data-account-tab="${key}"${key === tab ? ' aria-current="page"' : ''}>${label}</button>`).join('')}</nav>`;
    let content;
    if (tab === 'profile') content = `<section class="ac-card"><h2>Your profile</h2><p class="ac-help">Your sign-in email stays ${escape(user.email)}. It is not verified and does not grant access to laboratory reports.</p>${form('profile', field('name', 'Your name', { maximum: 100, autocomplete: 'name', required: false, value: user.name }) + field('company', 'Company', { autocomplete: 'organization', required: false, value: user.company }) + submit('Save profile'))}</section>`;
    else if (tab === 'security') content = `<div class="ac-security-grid"><section class="ac-card"><h2>Change your password</h2>${form('password', password('currentPassword', 'Current password', true) + password('newPassword', 'New password') + password('confirmPassword', 'Repeat new password') + submit('Update password'))}<p class="ac-help">Changing your password signs out your other sessions.</p></section><section class="ac-card"><h2>Recovery codes</h2><p>Keep a private copy of your eight one-time codes. Each replacement set invalidates the previous codes.</p>${form('codes', password('currentPassword', 'Current password', true) + submit('Replace recovery codes'))}<p class="ac-help">Email delivery is not connected. Save your codes so you can recover access without an email reset link.</p><button class="text-button" type="button" data-account-action="logout-all">Sign out of all devices</button></section></div>`;
    else if (selected) {
      const record = selected.record, details = requestDetails(record), kind = requestKind(record);
      const body = kind === 'testing' ? '<p>' + escape(details.name) + ' · ' + escape(details.email) + '</p><p>' + escape(details.company || '') + '</p><p>Report recipient: ' + escape(details.reportRecipient || details.name) + '</p><p>' + escape(details.notes || 'No additional notes.') + '</p><div class="ac-sample-list">' + details.samples.map((sample, index) => '<article><h3>Sample ' + (index + 1) + ' · ' + escape(sample.name) + '</h3><p>' + escape(SERVICE_NAMES[sample.service]) + ' · ' + sample.quantity + ' planned units · ' + escape(SAMPLE_FORMS[sample.form]) + '</p>' + (sample.batch ? '<p>Batch: ' + escape(sample.batch) + '</p>' : '') + (sample.amount ? '<p>Amount: ' + escape(sample.amount) + '</p>' : '') + '<p>Product image: ' + escape(IMAGE_CHOICES[sample.image]) + (sample.image === 'include' ? ' · ' + escape(IMAGE_STYLES[sample.imageStyle]) : '') + '</p></article>').join('') + '</div>' : kind === 'contact' ? '<p>' + escape(details.name) + ' · ' + escape(details.email) + '</p><p>' + escape(CONTACT_TOPICS[details.topic]) + '</p><p>' + escape(details.message) + '</p>' : '<p>Testing email: ' + escape(details.email) + '</p><p>Company or project: ' + escape(details.reference) + '</p><p>' + escape(details.notes || 'No additional context.') + '</p><p>Manual identity verification is required before a report can be shared.</p>';
      content = '<section class="ac-card"><button class="text-button" type="button" data-account-action="back">← My requests</button><h2>' + escape(requestSummary(record)) + '</h2><p>' + escape(REQUEST_KINDS[kind]) + ' · ' + escape(requestStatus(record)) + '</p><p class="ac-reference">' + escape(record.id) + '</p>' + body + notice + '<div class="ac-actions"><button class="button button-teal" type="button" data-account-action="resume" data-id="' + escape(selected.id) + '">' + (record.version === 2 ? 'Review and submit' : 'Edit request') + '</button><button class="text-button" type="button" data-account-action="delete" data-id="' + escape(selected.id) + '">Delete request</button></div>' + (pendingDelete ? '<div class="ac-delete-confirm"><p>Delete this account request?</p><button type="button" class="button button-dark" data-account-action="delete-confirm" data-id="' + escape(selected.id) + '">Delete request</button><button type="button" class="text-button" data-account-action="cancel-delete">Keep request</button></div>' : '') + '</section>';
    } else content = '<section class="ac-card"><div class="ac-list-heading"><div><h2>My requests</h2><p>Testing, contact and report recovery in one place.</p></div><button class="button button-teal" type="button" data-account-action="new-request">New request →</button></div>' + (documents.length ? '<ul class="ac-drafts">' + documents.map(doc => '<li><div><strong>' + escape(requestSummary(doc.record)) + '</strong><span>' + escape(doc.record.id) + ' · ' + escape(REQUEST_KINDS[requestKind(doc.record)]) + '</span><small>' + escape(requestStatus(doc.record)) + '</small></div><button class="text-button" type="button" data-account-action="details" data-id="' + escape(doc.id) + '">View request →</button></li>').join('') + '</ul>' : '<div class="ac-empty"><h3>A clear starting point.</h3><p>Your submitted requests will appear here.</p></div>') + notice + '</section>';
    shell(navigation + content);
    if (focusHeading) { const heading = root.querySelector('h2'); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); }
  }
  function showCodes(value, destination) {
    if (!Array.isArray(value) || value.length !== 8 || value.some(code => typeof code !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(code)) || new Set(value).size !== 8) throw new AccountError('invalid_response');
    clearCodes(); codes = value.slice(); codesNext = destination;
    user = client.snapshot().user;
    shell(`<section class="ac-card ac-code-card"><p class="ac-kicker">SAVE THESE NOW</p><h2>Your eight recovery codes</h2><p>Each code works once. Store them privately before continuing. This set will not be shown again.</p><ul class="ac-codes">${codes.map(code => `<li><code>${escape(code)}</code></li>`).join('')}</ul><button class="button button-outline" type="button" data-account-action="copy-codes">Copy codes</button><div class="ac-manual-copy" data-account-copy-fallback hidden><label for="ac-code-copy">Recovery codes — manual copy</label><textarea id="ac-code-copy" readonly></textarea></div><label class="ac-code-ack"><input type="checkbox" data-account-confirm-codes> I have saved my recovery codes.</label><button class="button button-teal" type="button" data-account-action="ack-codes" data-account-ack disabled>Continue →</button></section>`);
    const heading = root.querySelector('h2'); heading?.setAttribute('tabindex', '-1'); heading?.focus?.({ preventScroll: true });
  }
  function values(formNode) { return Object.fromEntries([...formNode.elements].filter(item => item.name).map(item => [item.name, item.value])); }
  function validate(formNode, data, kind) {
    const errors = {};
    if (['login', 'register', 'recover'].includes(kind) && !emailOK(data.email)) errors.email = 'Enter a valid email address.';
    if (kind === 'login' && !validAccountPassword(data.password)) errors.password = 'Enter your 15–128 character password.';
    const newKey = kind === 'register' ? 'password' : ['password', 'recover'].includes(kind) ? 'newPassword' : null;
    if (newKey && !validAccountPassword(data[newKey])) errors[newKey] = 'Use 15–128 characters.';
    if (newKey && data.confirmPassword !== data[newKey]) errors.confirmPassword = 'Repeat the same password.';
    if (['password', 'codes'].includes(kind) && !validAccountPassword(data.currentPassword)) errors.currentPassword = 'Enter your current 15–128 character password.';
    if (kind === 'recover' && (!data.recoveryCode || data.recoveryCode.length > 128)) errors.recoveryCode = 'Enter a saved recovery code.';
    if (data.name?.length > 100) errors.name = 'Use 100 characters or fewer.';
    if (data.company?.length > 160) errors.company = 'Use 160 characters or fewer.';
    for (const input of [...formNode.elements].filter(item => item.name)) {
      const problem = errors[input.name]; const node = formNode.querySelector('#ac-' + kind + '-' + input.name + '-error');
      if (node) node.textContent = problem || '';
      if (problem) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
    const first = Object.keys(errors)[0];
    if (first) { report('Check the highlighted details.'); formNode.elements.namedItem(first)?.focus(); return false; }
    return true;
  }
  function setBusy(value) { busy = value; root?.querySelector('.ac-content')?.setAttribute('aria-busy', String(value)); for (const control of root?.querySelectorAll('button,input,select,textarea,fieldset') || []) control.disabled = value; }
  async function execute(work, after, bindOwner = true) {
    if (busy || !root) return;
    const ticket = revision, action = ++actionRevision, owner = user?.id;
    setBusy(true); report(''); status('Saving…');
    try {
      const result = await work(controller.signal);
      if (!current(ticket, action) || bindOwner && client.snapshot().user?.id !== owner) return;
      setBusy(false); status(''); after(result);
    } catch (error) { if (current(ticket, action)) { setBusy(false); status(''); report(accountErrorMessage(error)); } }
  }
  function onSubmit(event) {
    const formNode = event.target.closest('[data-account-form]');
    if (!formNode || !root?.contains(formNode)) return;
    event.preventDefault(); if (busy) return;
    const kind = formNode.dataset.accountForm, data = values(formNode);
    if (!validate(formNode, data, kind)) return;
    const options = signal => ({ signal });
    if (kind === 'login') void execute(signal => client.login({ email: data.email, password: data.password }, options(signal)), () => navigate(next), false);
    if (kind === 'register') void execute(signal => client.signup({ email: data.email, password: data.password, name: data.name, company: data.company }, options(signal)), result => showCodes(result.recoveryCodes, next), false);
    if (kind === 'recover') void execute(signal => client.recover({ email: data.email, recoveryCode: data.recoveryCode, newPassword: data.newPassword }, options(signal)), result => showCodes(result.recoveryCodes, '/login?next=' + encodeURIComponent(next)), false);
    if (kind === 'profile') void execute(signal => client.profile({ name: data.name, company: data.company }, options(signal)), value => { user = value; dashboard(); status('Profile saved.'); });
    if (kind === 'password') void execute(signal => client.password({ currentPassword: data.currentPassword, newPassword: data.newPassword }, options(signal)), value => { user = value; dashboard(); status('Password updated. Other sessions are signed out.'); });
    if (kind === 'codes') void execute(signal => client.recoveryCodes({ currentPassword: data.currentPassword }, options(signal)), value => showCodes(value.recoveryCodes, '/account'));
  }
  function onClick(event) {
    const button = event.target.closest('[data-account-action],[data-account-tab]');
    if (!button || !root?.contains(button) || button.disabled || busy) return;
    if (button.dataset.accountTab) { tab = button.dataset.accountTab; selected = null; pendingDelete = null; actionRevision++; dashboard(true); return; }
    const action = button.dataset.accountAction, id = button.dataset.id;
    if (action === 'retry') { void api.activate(path, next); return; }
    if (action === 'new-request') { onNewRequest(); return; }
    if (action === 'logout' || action === 'logout-all') { void execute(signal => client.logout(action === 'logout-all', { signal }), () => navigate('/login'), false); return; }
    if (action === 'details') { selected = documents.find(doc => doc.id === id); if (selected) dashboard(true); return; }
    if (action === 'back') { selected = null; pendingDelete = null; dashboard(true); return; }
    if (action === 'resume') { const doc = documents.find(item => item.id === id); if (doc && client.snapshot().user?.id === user?.id) onResume(doc, user.id); return; }
    if (action === 'delete') { pendingDelete = id; dashboard(); root.querySelector('[data-account-action="delete-confirm"]')?.focus(); return; }
    if (action === 'cancel-delete') { pendingDelete = null; dashboard(true); return; }
    if (action === 'delete-confirm') {
      const doc = documents.find(item => item.id === id); if (!doc || id !== pendingDelete) return;
      void execute(signal => client.deleteRequest(doc.id, doc.revision, { signal }), () => { documents = documents.filter(item => item.id !== id); selected = null; pendingDelete = null; dashboard(); status('Account request deleted.'); }); return;
    }
    if (action === 'ack-codes' && codes && root.querySelector('[data-account-confirm-codes]')?.checked) { const destination = codesNext; clearCodes(); navigate(destination); return; }
    if (action === 'copy-codes' && codes) {
      const ticket = revision, actionTicket = ++actionRevision, snapshot = codes;
      Promise.resolve().then(() => clipboard(snapshot.join('\n'))).then(() => { if (current(ticket, actionTicket) && codes === snapshot) status('Recovery codes copied. Store them privately.'); }, () => { if (!current(ticket, actionTicket) || codes !== snapshot) return; const fallback = root.querySelector('[data-account-copy-fallback]'); fallback.hidden = false; const input = fallback.querySelector('textarea'); input.value = snapshot.join('\n'); input.focus(); input.select(); });
    }
  }
  function onChange(event) { if (event.target.matches('[data-account-confirm-codes]')) { const button = root?.querySelector('[data-account-ack]'); if (button) button.disabled = !event.target.checked; } }
  for (const node of Object.values(roots)) if (node) { node.addEventListener('submit', onSubmit); node.addEventListener('click', onClick); node.addEventListener('change', onChange); }
  const unsubscribe = client.subscribe((nextUser, reason) => {
    if (path === '/recover-account' && reason === 'recovered' && busy) return;
    if (user && nextUser?.id !== user.id && ['logout', 'expired', 'login', 'recovered', 'session'].includes(reason)) { leave(); navigate(nextUser ? '/account' : '/login'); }
  });
  const api = Object.freeze({
    async activate(route, returnTo) {
      leave(); path = route; root = roots[route]; if (!root) return;
      next = safeAccountNext(returnTo); controller = new AbortController(); const ticket = revision;
      shell('<div class="ac-card"><p role="status">Opening your account…</p></div>');
      try {
        const confirmedUser = await client.getSession({ signal: controller.signal });
        if (!current(ticket)) return;
        user = confirmedUser;
        if (path === '/account' && !user) { navigate('/login?next=' + encodeURIComponent('/account'), { replace: true }); return; }
        if (user && ['/login', '/register'].includes(path)) { navigate(next, { replace: true }); return; }
        if (path === '/account') { const loaded = await client.listRequests({ signal: controller.signal }); if (current(ticket)) { documents = loaded; tab = 'requests'; dashboard(); } }
        else auth();
      } catch (error) { if (current(ticket)) { shell('<div class="ac-card"><h2>Let’s try that again.</h2><button type="button" class="button button-outline" data-account-action="retry">Retry</button><a href="/submit-sample">Return to testing</a></div>'); report(accountErrorMessage(error)); } }
    },
    leave,
    destroy() { leave(); unsubscribe(); for (const node of Object.values(roots)) if (node) { node.removeEventListener('submit', onSubmit); node.removeEventListener('click', onClick); node.removeEventListener('change', onChange); } }
  });
  return api;
}
