import { normalizeContact, validateContact } from './contact.js';
import { normalizeSupport, validateSupport } from './support.js';
import { requestDetails, requestKind } from './account-requests.js';
import { createSubmissionIntent, accountErrorMessage } from './customer-account.js';

const bindings = new WeakMap();
// Constructed by app.js with the single account client; importing does no I/O.
export function createContactForm(form, { client, accountEnabled = false, kind = 'contact', onSignIn = () => {}, onView = () => {}, makeId, now, isVisible = () => !form.closest('[hidden]') } = {}) {
  if (!form) return null;
  if (bindings.has(form)) return bindings.get(form);
  const prefix = kind === 'contact' ? 'contact' : 'support';
  const keys = kind === 'contact' ? ['name', 'email', 'topic', 'message'] : ['email', 'reference', 'notes'];
  const fields = Object.fromEntries(keys.map(key => [key, form.querySelector('#' + prefix + '-' + key)]));
  const error = form.querySelector('#' + prefix + '-error'), status = form.querySelector('#' + prefix + '-status');
  const fieldsPanel = form.querySelector('[data-inquiry-fields]');
  const gate = form.querySelector('[data-inquiry-gate]'), submit = form.querySelector('[type="submit"]'), view = form.querySelector('[data-inquiry-action="view"]');
  if ([...Object.values(fields), error, status, gate, submit, view].some(node => !node)) throw new TypeError('Inquiry form controls are incomplete.');
  const intent = createSubmissionIntent({ save: (record, options) => client.saveRequest(record, options), makeId, now });
  let user = null, owner = null, loaded = !accountEnabled, revision = 0, controller = null, busy = false, active = false, pristine = true, editing = false;
  const values = () => Object.fromEntries(keys.map(key => [key, fields[key].value]));
  const live = ticket => active && ticket === revision && !controller?.signal.aborted && form.isConnected && isVisible();
  function feedback() { error.textContent = ''; status.textContent = ''; view.hidden = true; }
  function gateControls() {
    gate.textContent = !accountEnabled ? 'Submissions are unavailable in this view. Public COA lookup remains available.' : !loaded ? 'Checking your account…' : !user ? 'Sign in to submit and manage this request in your account.' : 'Submit and manage this request in My requests.';
    submit.disabled = busy || !accountEnabled || !loaded || !user;
    submit.textContent = busy ? 'Submitting…' : editing ? 'Update request' : kind === 'contact' ? 'Submit message' : 'Submit recovery request';
    const withholdFields = accountEnabled && (!loaded || !!owner && !user);
    if (fieldsPanel) fieldsPanel.hidden = withholdFields;
    for (const field of Object.values(fields)) field.disabled = busy || withholdFields;
    form.setAttribute('aria-busy', String(busy));
    const signIn = form.querySelector('[data-inquiry-action="sign-in"]'); if (signIn) signIn.hidden = !accountEnabled || !loaded || !!user;
  }
  function clear() { revision++; controller?.abort(); controller = null; busy = false; intent.reset(); owner = null; pristine = true; editing = false; for (const field of Object.values(fields)) field.value = ''; if (kind === 'contact') fields.topic.value = ''; feedback(); }
  function setAccountSession(nextUser, reason = 'session') {
    loaded = true;
    if (reason === 'logout' || owner && nextUser?.id && nextUser.id !== owner) clear();
    if (owner && !nextUser) { intent.cancel(); revision++; controller?.abort(); controller = null; busy = false; feedback(); }
    user = nextUser;
    if (user && !owner) owner = user.id;
    if (user && pristine) for (const key of ['name', 'email']) if (fields[key] && !fields[key].value) fields[key].value = user[key] || '';
    gateControls();
  }
  async function onSubmit(event) {
    event.preventDefault();
    if (busy || !active || !user || !loaded || !accountEnabled) return;
    feedback();
    const value = values(), errors = kind === 'contact' ? validateContact(value) : validateSupport(value);
    for (const key of keys) { const node = form.querySelector('#' + prefix + '-error-' + key); if (node) node.textContent = errors[key] || ''; if (errors[key]) fields[key].setAttribute('aria-invalid', 'true'); else fields[key].removeAttribute('aria-invalid'); }
    const first = keys.find(key => errors[key]); if (first) { fields[first].focus(); return; }
    const ownerId = user.id, ticket = ++revision; controller = new AbortController(); const signal = controller.signal; busy = true; gateControls();
    try {
      const document = await intent.submit(kind, kind === 'contact' ? normalizeContact(value) : normalizeSupport(value), ownerId, { signal, current: () => live(ticket) && user?.id === ownerId && owner === ownerId });
      if (!live(ticket) || user?.id !== ownerId) return;
      editing = true; pristine = false; status.textContent = 'Request submitted. Reference: ' + document.record.id; view.hidden = false;
    } catch (problem) { if (live(ticket) && user?.id === ownerId) error.textContent = accountErrorMessage(problem); }
    finally { if (ticket === revision) { busy = false; controller = null; gateControls(); } }
  }
  function onInput(event) { if (!Object.values(fields).includes(event.target) || busy) return; pristine = false; feedback(); event.target.removeAttribute('aria-invalid'); const node = form.querySelector('#' + prefix + '-error-' + keys.find(key => fields[key] === event.target)); if (node) node.textContent = ''; }
  function onClick(event) { const button = event.target.closest('[data-inquiry-action]'); if (!button || busy) return; if (button.dataset.inquiryAction === 'sign-in') onSignIn(); if (button.dataset.inquiryAction === 'view') onView(); if (button.dataset.inquiryAction === 'new') { clear(); setAccountSession(user); } }
  form.addEventListener('submit', onSubmit); form.addEventListener('input', onInput); form.addEventListener('change', onInput); form.addEventListener('click', onClick);
  const api = Object.freeze({
    setAccountSession,
    activate({ checking = false } = {}) { active = true; if (checking) { loaded = false; gateControls(); return; } const snapshot = client?.snapshot(); if (snapshot?.loaded) setAccountSession(snapshot.user); else gateControls(); },
    resume(document, ownerId) { if (!user || user.id !== ownerId || requestKind(document.record) !== kind) return false; clear(); owner = ownerId; intent.resume(document, ownerId); const value = requestDetails(document.record); for (const key of keys) fields[key].value = value[key]; pristine = false; editing = true; active = true; gateControls(); return true; },
    suspend() { active = false; intent.cancel(); revision++; controller?.abort(); controller = null; busy = false; feedback(); gateControls(); },
    destroy() { clear(); active = false; form.removeEventListener('submit', onSubmit); form.removeEventListener('input', onInput); form.removeEventListener('change', onInput); form.removeEventListener('click', onClick); bindings.delete(form); }
  });
  bindings.set(form, api); gateControls(); return api;
}
