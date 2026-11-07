import { SERVICE_NAMES } from './data.js';
import { SAMPLE_FORMS, IMAGE_CHOICES, IMAGE_STYLES } from './submission.js';
import { REQUEST_KINDS, requestDetails, requestKind, requestStatus, requestSummary } from './account-requests.js';
import { CONTACT_TOPICS } from './contact.js';
import { validAccountPassword, safeAccountNext, accountErrorMessage } from './customer-account.js';
import { createMailActionState, notificationText } from './account-mail.js';
import { createGoogleAccountController } from './account-google.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const emailOK = value => typeof value === 'string' && value.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
const field = (name, label, { type = 'text', maximum = 160, autocomplete = '', value = '', required = true, help = '' } = {}) => `<div class="ac-field"><label for="ac-${name}">${label}${required ? '' : ' <span>Optional</span>'}</label><input id="ac-${name}" name="${name}" type="${type}" maxlength="${maximum}"${required ? ' required' : ''}${autocomplete ? ` autocomplete="${autocomplete}"` : ''} value="${escape(value)}" aria-describedby="ac-${name}-error${help ? ` ac-${name}-help` : ''}">${help ? `<p class="ac-help" id="ac-${name}-help">${help}</p>` : ''}<p class="ac-field-error" id="ac-${name}-error"></p></div>`;
const password = (name, label, current = false) => field(name, label, { type: 'password', maximum: 256, autocomplete: current ? 'current-password' : 'new-password', help: current ? '' : 'Use 15–128 characters. Spaces are allowed.' });
const submit = label => `<button class="button button-teal" type="submit">${label}<span aria-hidden="true"> →</span></button>`;
const notice = '<p class="ac-note">Manage your submitted requests here. Older saved requests need explicit review and submission.</p>';

export function createAccountPage({ roots, client, navigate, onResume, onNewRequest, onRegistrationNotice = () => {} }) {
  const mailAction = createMailActionState();
  let resendAt = 0;
  let path = '', root = null, revision = 0, actionRevision = 0, controller = null, busy = false;
  let user = null, documents = [], tab = 'requests', selected = null, pendingDelete = null, next = '/account';
  let returnSecurity = false;
  const googleButton = (emailAlternative = true) => client.snapshot().google?.enabled ? '<div class="ac-google-choice"><button class="ac-google-button" type="button" data-account-action="google-login" aria-label="Continue with Google"><img src="/assets/google-signin-light.png" alt=""></button><p class="ac-help">Google shares your basic identity with AssayNova. <a href="/privacy-policy">Privacy policy</a></p>' + (emailAlternative ? '<p class="ac-divider">or use your email</p>' : '') + '</div>' : '';
  const googleController = createGoogleAccountController({ client, onComplete(result) {
    user = client.snapshot().user;
    returnSecurity = result.intent !== 'login'; navigate(result.next, { replace: true });
  }, onState(state, error) {
    if (!root) return;
    if (path !== '/google-signin') { setBusy(state === 'pending'); if (error) report(accountErrorMessage(error)); return; }
    shell('<section class="ac-card"><h2>' + (state === 'pending' ? 'Confirming your sign-in…' : state === 'confirmed' ? 'Your account is ready.' : 'Let’s reconnect safely.') + '</h2><p role="status">' + (state === 'pending' ? 'Checking this browser’s requested Google action.' : state === 'confirmed' ? 'The account session is confirmed. Open My account to continue.' : 'This Google action could not be completed here. Start again from sign-in or account Security.') + '</p>' + (state === 'retryable' ? '<button class="button button-outline" type="button" data-account-action="google-retry">Retry this action</button>' : '') + '<p class="ac-links"><a href="/login">Sign in</a><a href="/account">My account</a></p></section>');
    if (error) report(accountErrorMessage(error));
  } });
  const current = (ticket, action) => root && ticket === revision && (action === undefined || action === actionRevision) && !controller?.signal.aborted;
  function leave() { googleController.leave(); mailAction.clear(); revision++; actionRevision++; controller?.abort(); controller = null; for (const node of Object.values(roots)) if (node) node.innerHTML = ''; path = ''; root = null; busy = false; user = null; documents = []; selected = null; pendingDelete = null; }
  const errorNode = () => root?.querySelector('[data-account-error]');
  function report(message) { const node = errorNode(); if (node) { node.textContent = message; node.focus?.({ preventScroll: true }); } }
  function status(message) { const node = root?.querySelector('[data-account-status]'); if (node) node.textContent = message; }
  function shell(content) { root.innerHTML = `<div class="ac-content" data-request-private><p class="ac-error" data-account-error role="alert" tabindex="-1"></p><p class="ac-status" data-account-status role="status"></p>${content}</div>`; }
  function form(kind, content) { const unique = content.replace(/((?:id|for)=")ac-/g, '$1ac-' + kind + '-').replace(/(aria-describedby=")([^"]+)/g, (_, prefix, ids) => prefix + ids.replace(/\bac-/g, 'ac-' + kind + '-')); return `<form data-account-form="${kind}" novalidate><fieldset class="ac-form-lock">${unique}</fieldset></form>`; }
  function auth() {
    if (path === '/verify-email' || path === '/reset-password') {
      const valid = mailAction.ready();
      shell('<section class="ac-card"><h2>' + (path === '/verify-email' ? 'Confirm your email' : 'Choose a new password') + '</h2>' + (valid ? '<p>' + (path === '/verify-email' ? 'Confirm your email to receive account email.' : 'Choose a new password to regain access.') + '</p>' + (path === '/verify-email' ? '<button class="button button-teal" type="button" data-account-action="verify-email">Verify email</button>' : form('reset', password('newPassword', 'New password') + password('confirmPassword', 'Repeat new password') + submit('Reset password'))) : '<p>This link is invalid, used or expired. Reopen the email or request a new link.</p>') + '<p class="ac-links"><a href="/recover-account">Request a password reset</a><a href="/login">Sign in</a></p></section>'); return;
    }
    if (path === '/recover-account') {
      const mailEnabled = client.snapshot().mail?.enabled;
      shell('<section class="ac-card"><h2>' + (mailEnabled ? 'Reset your password by email.' : 'Account recovery') + '</h2>' + googleButton(!!mailEnabled) + (mailEnabled ? '<p>Enter your account email. If it is eligible, you will receive a reset link.</p>' + form('reset-request', field('email', 'Account email', { type: 'email', maximum: 160, autocomplete: 'email' }) + submit('Request reset link')) : '<p>Password reset by email is currently unavailable. You can sign in with your existing password' + (client.snapshot().google?.enabled ? ' or linked Google account' : '') + '.</p>') + '<p class="ac-links"><a href="/login?next=' + encodeURIComponent(next) + '">Back to sign in</a></p></section>'); return;
    }
    if (path === '/login') shell(`<div class="ac-card"><p class="ac-kicker">WELCOME BACK</p><h2>Sign in to your workspace.</h2><p class="ac-intro">Submit and manage your requests in one account.</p>${googleButton()}${form('login', field('email', 'Email', { type: 'email', maximum: 160, autocomplete: 'email' }) + password('password', 'Password', true) + submit('Sign in'))}<p class="ac-links"><a href="/register?next=${encodeURIComponent(next)}">Create an account</a><a href="/recover-account?next=${encodeURIComponent(next)}">Recover your account</a></p></div>`);
    else if (path === '/register') shell(`<div class="ac-card"><p class="ac-kicker">YOUR NEXT ANALYSIS</p><h2>A place for your requests.</h2><p class="ac-intro">Create an account to submit and manage testing, contact and report recovery requests.</p>${googleButton()}${form('register', `<div class="ac-field-grid">${field('name', 'Your name', { maximum: 100, autocomplete: 'name', required: false })}${field('company', 'Company', { autocomplete: 'organization', required: false })}</div>` + field('email', 'Email', { type: 'email', maximum: 160, autocomplete: 'email' }) + password('password', 'Password') + password('confirmPassword', 'Repeat password') + submit('Create account'))}<p class="ac-links">Already have an account? <a href="/login?next=${encodeURIComponent(next)}">Sign in</a></p>${notice}</div>`);
  }
  function dashboard(focusHeading = false) {
    const navigation = `<div class="ac-workspace-bar"><div><p class="ac-kicker">YOUR WORKSPACE</p><p class="ac-user-name">${escape(user.name || 'My account')}</p><p class="ac-help">${escape(user.email)} · ${user.emailVerified ? 'Email verified' : 'Email not verified'}</p></div><button type="button" class="text-button" data-account-action="logout">Sign out</button></div><nav class="ac-tabs" aria-label="Account sections">${[['requests', 'My requests'], ['profile', 'Profile'], ['security', 'Security']].map(([key, label]) => `<button type="button" data-account-tab="${key}"${key === tab ? ' aria-current="page"' : ''}>${label}</button>`).join('')}</nav>`;
    let content;
    if (tab === 'profile') content = `<section class="ac-card"><h2>Your profile</h2><p class="ac-help">Your sign-in email stays ${escape(user.email)}. Email verification does not grant access to laboratory reports.</p>${form('profile', field('name', 'Your name', { maximum: 100, autocomplete: 'name', required: false, value: user.name }) + field('company', 'Company', { autocomplete: 'organization', required: false, value: user.company }) + submit('Save profile'))}</section>`;
    else if (tab === 'security') {
      const enabled = client.snapshot().google?.enabled;
      const google = enabled ? '<section class="ac-card"><h2>Google sign-in</h2><p>' + (user.googleLinked ? 'Linked to your account.' : 'Not linked.') + '</p>' + (user.googleLinked ? user.passwordEnabled !== false ? form('google-unlink', password('currentPassword', 'Current password', true) + submit('Disconnect Google')) : '<p class="ac-help">Set a password before disconnecting your only sign-in method.</p>' : form('google-link', password('currentPassword', 'Current password', true) + submit('Link Google'))) + '</section>' : '';
      const passwordPanel = user.passwordEnabled !== false ? '<h2>Change your password</h2>' + form('password', password('currentPassword', 'Current password', true) + password('newPassword', 'New password') + password('confirmPassword', 'Repeat new password') + submit('Update password')) : '<h2>Set a password</h2><p>Use a recent Google confirmation to add an email-and-password sign-in method.</p>' + (enabled ? '<button class="text-button" type="button" data-account-action="google-password-proof">Confirm with Google</button>' + form('password-setup', password('newPassword', 'New password') + password('confirmPassword', 'Repeat new password') + submit('Set password')) : '<p>Google sign-in is currently unavailable. Use account recovery.</p>');
      content = '<section class="ac-card"><h2>Email verification</h2><p>' + (user.emailVerified ? 'Email verified' : 'Email not verified') + '</p>' + (!user.emailVerified && client.snapshot().mail?.enabled ? '<button class="button button-outline" type="button" data-account-action="resend-verification">Send verification email</button>' : '') + '</section>' + google + '<div class="ac-security-grid"><section class="ac-card">' + passwordPanel + '<p class="ac-help">Updating your password signs out your other sessions.</p></section><section class="ac-card"><h2>Sessions</h2><p>Sign out everywhere, including this device.</p><button class="text-button" type="button" data-account-action="logout-all">Sign out of all devices</button></section></div>';
    }
    else if (selected) {
      const record = selected.record, details = requestDetails(record), kind = requestKind(record);
      const body = kind === 'testing' ? '<p>' + escape(details.name) + ' · ' + escape(details.email) + '</p><p>' + escape(details.company || '') + '</p><p>Report recipient: ' + escape(details.reportRecipient || details.name) + '</p><p>' + escape(details.notes || 'No additional notes.') + '</p><div class="ac-sample-list">' + details.samples.map((sample, index) => '<article><h3>Sample ' + (index + 1) + ' · ' + escape(sample.name) + '</h3><p>' + escape(SERVICE_NAMES[sample.service]) + ' · ' + sample.quantity + ' planned units · ' + escape(SAMPLE_FORMS[sample.form]) + '</p>' + (sample.batch ? '<p>Batch: ' + escape(sample.batch) + '</p>' : '') + (sample.amount ? '<p>Amount: ' + escape(sample.amount) + '</p>' : '') + '<p>Product image: ' + escape(IMAGE_CHOICES[sample.image]) + (sample.image === 'include' ? ' · ' + escape(IMAGE_STYLES[sample.imageStyle]) : '') + '</p></article>').join('') + '</div>' : kind === 'contact' ? '<p>' + escape(details.name) + ' · ' + escape(details.email) + '</p><p>' + escape(CONTACT_TOPICS[details.topic]) + '</p><p>' + escape(details.message) + '</p>' : '<p>Testing email: ' + escape(details.email) + '</p><p>Company or project: ' + escape(details.reference) + '</p><p>' + escape(details.notes || 'No additional context.') + '</p><p>Manual identity verification is required before a report can be shared.</p>';
      content = '<section class="ac-card"><button class="text-button" type="button" data-account-action="back">← My requests</button><h2>' + escape(requestSummary(record)) + '</h2><p>' + escape(REQUEST_KINDS[kind]) + ' · ' + escape(requestStatus(record)) + '</p><p class="ac-reference">' + escape(record.id) + '</p>' + body + notificationMarkup(selected) + notice + '<div class="ac-actions"><button class="button button-teal" type="button" data-account-action="resume" data-id="' + escape(selected.id) + '">' + (record.version === 2 ? 'Review and submit' : 'Edit request') + '</button><button class="text-button" type="button" data-account-action="delete" data-id="' + escape(selected.id) + '">Delete request</button></div>' + (pendingDelete ? '<div class="ac-delete-confirm"><p>Delete this account request?</p><button type="button" class="button button-dark" data-account-action="delete-confirm" data-id="' + escape(selected.id) + '">Delete request</button><button type="button" class="text-button" data-account-action="cancel-delete">Keep request</button></div>' : '') + '</section>';
    } else content = '<section class="ac-card"><div class="ac-list-heading"><div><h2>My requests</h2><p>Testing, contact and report recovery in one place.</p></div><button class="button button-teal" type="button" data-account-action="new-request">New request →</button></div>' + (documents.length ? '<ul class="ac-drafts">' + documents.map(doc => '<li><div><strong>' + escape(requestSummary(doc.record)) + '</strong><span>' + escape(doc.record.id) + ' · ' + escape(REQUEST_KINDS[requestKind(doc.record)]) + '</span><small>' + escape(requestStatus(doc.record)) + '</small>' + notificationMarkup(doc) + '</div><button class="text-button" type="button" data-account-action="details" data-id="' + escape(doc.id) + '">View request →</button></li>').join('') + '</ul>' : '<div class="ac-empty"><h3>A clear starting point.</h3><p>Your submitted requests will appear here.</p></div>') + notice + '</section>';
    shell(navigation + content);
    if (focusHeading) { const heading = root.querySelector('h2'); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); }
  }
  function notificationMarkup(doc) {
    const meta = doc.notifications || { receipt: 'not_requested', support: 'not_requested', retryable: false };
    return '<div class="ac-mail-status"><p>Receipt: ' + escape(notificationText(meta.receipt)) + '</p><p>Support alert: ' + escape(notificationText(meta.support)) + '</p>' + ([meta.receipt,meta.support].includes('accepted') ? '<p class="ac-help">Inbox delivery is not confirmed.</p>' : '') + (meta.receipt === 'not_verified' ? '<button type="button" class="text-button" data-account-action="verification-tab">Verify email</button>' : '') + (meta.retryable ? '<button type="button" class="text-button" data-account-action="retry-notifications" data-id="' + escape(doc.id) + '">Retry notifications</button>' : '') + '<button type="button" class="text-button" data-account-action="refresh-notifications" data-id="' + escape(doc.id) + '">Refresh status</button></div>';
  }
  function values(formNode) { return Object.fromEntries([...formNode.elements].filter(item => item.name).map(item => [item.name, item.value])); }
  function validate(formNode, data, kind) {
    const errors = {};
    if (['login', 'register', 'reset-request'].includes(kind) && !emailOK(data.email)) errors.email = 'Enter a valid email address.';
    if (kind === 'login' && !validAccountPassword(data.password)) errors.password = 'Enter your 15–128 character password.';
    const newKey = kind === 'register' ? 'password' : ['password', 'reset', 'password-setup'].includes(kind) ? 'newPassword' : null;
    if (newKey && !validAccountPassword(data[newKey])) errors[newKey] = 'Use 15–128 characters.';
    if (newKey && data.confirmPassword !== data[newKey]) errors.confirmPassword = 'Repeat the same password.';
    if (['password', 'google-link', 'google-unlink'].includes(kind) && !validAccountPassword(data.currentPassword)) errors.currentPassword = 'Enter your current 15–128 character password.';
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
    } catch (error) { if (current(ticket, action)) { if (error.retryAfter) resendAt = Date.now() + Math.min(error.retryAfter, 86400) * 1000; setBusy(false); status(''); report(accountErrorMessage(error)); } }
  }
  function onSubmit(event) {
    const formNode = event.target.closest('[data-account-form]');
    if (!formNode || !root?.contains(formNode)) return;
    event.preventDefault(); if (busy) return;
    const kind = formNode.dataset.accountForm, data = values(formNode);
    if (!validate(formNode, data, kind)) return;
    const options = signal => ({ signal });
    if (kind === 'login') void execute(signal => client.login({ email: data.email, password: data.password }, options(signal)), () => navigate(next), false);
    if (kind === 'register') void execute(signal => client.signup({ email: data.email, password: data.password, name: data.name, company: data.company }, options(signal)), result => { const registrationNotice = client.snapshot().mail?.enabled ? result.verification?.status === 'queued' ? 'Check your email to verify your mailbox.' : 'Your account is ready. Verification email is currently unavailable.' : ''; navigate(next); if (registrationNotice) onRegistrationNotice(registrationNotice); }, false);
    if (kind === 'reset-request') void execute(signal => client.requestPasswordReset(data.email, { signal }), () => { shell('<section class="ac-card"><h2>Check your email</h2><p>If that account is eligible, a reset link will arrive.</p><p class="ac-links"><a href="/login">Sign in</a></p></section>'); }, false);
    if (kind === 'reset') void execute(signal => mailAction.submit(token => client.resetPassword(token, data.newPassword, { signal })), result => { if (result) shell('<section class="ac-card"><h2>Password updated</h2><p>Sign in with your new password to continue.</p><p class="ac-links"><a href="/login">Sign in</a></p></section>'); }, false);
    if (kind === 'profile') void execute(signal => client.profile({ name: data.name, company: data.company }, options(signal)), value => { user = value; dashboard(); status('Profile saved.'); });
    if (kind === 'password') void execute(signal => client.password({ currentPassword: data.currentPassword, newPassword: data.newPassword }, options(signal)), value => { user = value; dashboard(); status('Password updated. Other sessions are signed out.'); });
    if (kind === 'google-link') void googleController.begin('link', data.currentPassword);
    if (kind === 'google-unlink') void execute(signal => client.googleUnlink(data.currentPassword, { signal }), value => { user = value; dashboard(); status('Google disconnected.'); });
    if (kind === 'password-setup') void execute(signal => client.setupPassword(data.newPassword, { signal }), value => { user = value; dashboard(); status('Password is ready.'); });
  }
  function onClick(event) {
    const button = event.target.closest('[data-account-action],[data-account-tab]');
    if (!button || !root?.contains(button) || button.disabled || busy) return;
    if (button.dataset.accountTab) { tab = button.dataset.accountTab; selected = null; pendingDelete = null; actionRevision++; dashboard(true); return; }
    const action = button.dataset.accountAction, id = button.dataset.id;
    if (action === 'google-login') { void googleController.begin('login', next); return; }
    if (action === 'google-retry') { void googleController.retry(); return; }
    if (action === 'google-password-proof') { void googleController.begin('reauth', 'password_setup'); return; }
    if (action === 'verify-email') { void execute(signal => mailAction.submit(token => client.verifyEmail(token, { signal })), result => { if (result) shell('<section class="ac-card"><h2>Email verified</h2><p>You can now receive account email.</p><a href="/account">My account</a><a href="/login">Sign in</a></section>'); }, false); return; }
    if (action === 'verification-tab') { tab = 'security'; selected = null; dashboard(true); return; }
    if (action === 'resend-verification') {
      if (Date.now() < resendAt) { status('Please wait before requesting another verification email.'); return; }
      void execute(signal => client.requestVerification({ signal }), result => { resendAt = Date.now() + 60000; status(result.status === 'queued' ? 'Check your email for a verification link.' : result.status === 'verified' ? 'Email already verified.' : 'Verification email is currently unavailable.'); }); return;
    }
    if (action === 'retry-notifications' || action === 'refresh-notifications') { const doc = documents.find(item => item.id === id); if (!doc) return; void execute(signal => action === 'retry-notifications' ? client.retryNotifications(id, doc.revision, { signal }) : client.getRequest(id, { signal }), updated => { documents = documents.map(item => item.id === id ? updated : item); if (selected?.id === id) selected = updated; dashboard(); status('Notification status refreshed.'); }); return; }
    if (action === 'retry') { void api.activate(path, next, mailAction.current()); return; }
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
  }
  for (const node of Object.values(roots)) if (node) { node.addEventListener('submit', onSubmit); node.addEventListener('click', onClick); }
  const unsubscribe = client.subscribe((nextUser, reason) => {
    if (['/recover-account', '/reset-password'].includes(path) && reason === 'recovered' && busy) return;
    if (user && nextUser?.id !== user.id && ['logout', 'expired', 'login', 'recovered', 'session'].includes(reason)) { leave(); navigate(nextUser ? '/account' : '/login'); }
  });
  const api = Object.freeze({
    async activate(route, returnTo, actionToken) {
      leave(); path = route; root = roots[route]; if (!root) return; mailAction.enter(actionToken);
      next = safeAccountNext(returnTo); controller = new AbortController(); const ticket = revision;
      if (path === '/google-signin') { await googleController.enter(); return; }
      shell('<div class="ac-card"><p role="status">Opening your account…</p></div>');
      try {
        const confirmedUser = await client.getSession({ signal: controller.signal });
        if (!current(ticket)) return;
        user = confirmedUser;
        if (path === '/account' && !user) { navigate('/login?next=' + encodeURIComponent('/account'), { replace: true }); return; }
        if (user && ['/login', '/register'].includes(path)) { navigate(next, { replace: true }); return; }
        if (path === '/account') { const loaded = await client.listRequests({ signal: controller.signal }); if (current(ticket)) { documents = loaded; tab = returnSecurity ? 'security' : 'requests'; returnSecurity = false; dashboard(); } }
        else auth();
      } catch (error) { if (current(ticket)) { shell('<div class="ac-card"><h2>Let’s try that again.</h2><button type="button" class="button button-outline" data-account-action="retry">Retry</button><a href="/submit-sample">Return to testing</a></div>'); report(accountErrorMessage(error)); } }
    },
    leave,
    destroy() { leave(); unsubscribe(); for (const node of Object.values(roots)) if (node) { node.removeEventListener('submit', onSubmit); node.removeEventListener('click', onClick); } }
  });
  return api;
}
