import { parseRequestRecord } from './submission.js';

// Customer-only transport. Importing this module has no DOM/storage/network I/O.
export const safeAccountNext = value => ['/account', '/submit-sample'].includes(value) ? value : '/account';
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
export function validAccountPassword(value) {
  if (typeof value !== 'string' || [...value].length < 15 || [...value].length > 128 || new TextEncoder().encode(value).length > 512) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
export function accountUser(value) {
  if (!value || !opaque(value.id) || typeof value.email !== 'string' || value.email.length > 160 || value.emailVerified !== false || typeof value.name !== 'string' || value.name.length > 100 || typeof value.company !== 'string' || value.company.length > 160) throw new AccountError('invalid_response');
  return { id: value.id, email: value.email, emailVerified: false, name: value.name, company: value.company };
}
export function accountDraft(value) {
  const record = parseRequestRecord(value?.record);
  if (!value || !opaque(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !record || !iso(value.createdAt) || !iso(value.updatedAt)) throw new AccountError('invalid_response');
  return { id: value.id, revision: value.revision, record, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
export class AccountError extends Error {
  constructor(code = 'request_failed', status = 0) { super('Customer account request could not be completed.'); this.name = 'AccountError'; this.code = typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code.toLowerCase() : 'request_failed'; this.status = status; }
}
export function accountErrorMessage(error) {
  const message = ({ invalid_credentials: 'The email and password could not be confirmed.', invalid_recovery: 'Those recovery details could not be confirmed.', recovery_failed: 'Those recovery details could not be confirmed.', account_exists: 'An account could not be created with these details. Try signing in or use account recovery.', email_exists: 'An account could not be created with these details. Try signing in or use account recovery.', draft_limit: 'Your account already has 50 drafts. Remove an existing draft before saving another.', revision_conflict: 'This draft has changed. Your details are still here. Reopen it from My account before replacing a newer version.', idempotency_conflict: 'This save reference already has different details. Your details are still here. Reopen the saved draft from My account.', request_deleted: 'This saved draft was deleted. Your details are still here. Open My account before starting a new save.', request_not_found: 'This draft is no longer available. Open My account to see your current drafts.', account_changed: 'Account security changed. Please sign in again before continuing.', invalid_password: 'Use a password of 15–128 characters.', invalid_input: 'Check the details and try again.', validation_error: 'Check the details and try again.', invalid_record: 'Check the request draft details and try again.', invalid_revision: 'Reopen the draft from My account before saving again.', invalid_response: 'We could not confirm the saved result. Please retry safely.', owner_changed: 'The signed-in account changed. Open the draft again from My account.', network: 'The connection did not confirm the result. Your details are still here; retrying will not create another draft.', aborted: 'The result was not confirmed here. Check My account or retry the save safely.', unavailable: 'Account access is unavailable in this view.' })[error?.code];
  if (message) return message;
  if (error?.status === 429) return 'Too many attempts. Please wait a moment and try again.';
  if (error?.status === 401) return 'Please sign in again. Your unsaved details are still here.';
  if (error?.status === 409) return 'This draft has changed or was already saved. Your details are still here. Reopen it from My account before replacing a newer version.';
  if (error?.status === 403) return 'Your sign-in check expired. Please retry the action.';
  return 'We could not complete that action. Please check your details and try again.';
}

export function createCustomerAccountClient({ fetcher = (...args) => globalThis.fetch(...args), timeout = 12000 } = {}) {
  let user = null, csrf = '', loaded = false, revision = 0;
  const listeners = new Set();
  const notify = reason => { for (const listener of listeners) listener(user, reason); };
  function setSession(nextUser, token, reason) { user = nextUser ? accountUser(nextUser) : null; csrf = typeof token === 'string' ? token : ''; loaded = true; notify(reason); }
  async function call(method, suffix, body, { signal, token = csrf } = {}) {
    const requestRevision = revision;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new AccountError('aborted');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const response = await fetcher('/api/account' + suffix, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Account-CSRF': token }) }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json();
      if (controller.signal.aborted || requestRevision !== revision) throw new AccountError('aborted');
      if (!response.ok) {
        const error = new AccountError(value?.error?.code, response.status);
        // Rejected credentials/recovery details do not expire an existing session.
        if (response.status === 401 && !['invalid_credentials', 'invalid_recovery'].includes(error.code)) { revision++; setSession(null, '', 'expired'); }
        if (response.status === 403) csrf = '';
        throw error;
      }
      return value;
    } catch (error) { if (error instanceof AccountError) throw error; throw new AccountError(controller.signal.aborted ? 'aborted' : 'network'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function getSession({ signal } = {}) {
    const ticket = revision;
    const value = await call('GET', '/session', undefined, { signal });
    if (ticket !== revision || signal?.aborted) throw new AccountError('aborted');
    if (typeof value.authenticated !== 'boolean' || typeof value.csrfToken !== 'string' || !value.csrfToken || (!!value.user !== value.authenticated)) throw new AccountError('invalid_response');
    setSession(value.user, value.csrfToken, 'session');
    return user;
  }
  async function mutate(suffix, body, options = {}, method = 'POST') {
    if (!csrf) await getSession(options);
    return call(method, suffix, body, options);
  }
  async function authenticate(suffix, body, options) {
    const ticket = ++revision;
    const value = await mutate(suffix, body, options);
    if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted');
    if (typeof value.csrfToken !== 'string' || !value.csrfToken) throw new AccountError('invalid_response');
    setSession(value.user, value.csrfToken, 'login');
    return value;
  }
  const idPath = id => { if (!opaque(id)) throw new AccountError('invalid_input'); return '/requests/' + id; };
  async function confirmOwner(ownerId, options) {
    const current = await getSession(options);
    if (!ownerId || !current || current.id !== ownerId) throw new AccountError('owner_changed');
  }
  async function readOwnedDrafts(suffix, options) {
    // Capture before refreshing: a cross-tab replacement must never become the
    // implicit owner of a read that was started from the previous account view.
    const ownerId = user?.id;
    await confirmOwner(ownerId, options);
    const value = await call('GET', suffix, undefined, options);
    // GET is not CSRF-bound. Verify again before releasing any private result.
    await confirmOwner(ownerId, options);
    return value;
  }
  return Object.freeze({
    getSession, snapshot: () => ({ user, loaded }), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    signup: (values, options) => authenticate('/signup', values, options), login: (values, options) => authenticate('/login', values, options),
    async logout(all = false, options) { const ticket = ++revision; const value = await mutate(all ? '/logout-all' : '/logout', {}, options); if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted'); if (value.ok !== true) throw new AccountError('invalid_response'); setSession(null, '', 'logout'); },
    async recover(values, options) { const ticket = ++revision; const value = await mutate('/recover', values, options); if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted'); if (value.ok !== true) throw new AccountError('invalid_response'); setSession(null, '', 'recovered'); return value; },
    async profile(values, options) { const ticket = revision; const value = await mutate('/profile', values, options, 'PATCH'); if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted'); setSession(value.user, csrf, 'profile'); return user; },
    async password(values, options) { const ticket = ++revision; const value = await mutate('/password', values, options); if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted'); if (typeof value.csrfToken !== 'string' || !value.csrfToken) throw new AccountError('invalid_response'); setSession(value.user, value.csrfToken, 'password'); return user; },
    async recoveryCodes(values, options) { const ticket = revision; const value = await mutate('/recovery-codes', values, options); if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted'); if (typeof value.csrfToken === 'string') csrf = value.csrfToken; return value; },
    async listDrafts(options) { const value = await readOwnedDrafts('/requests', options); if (!Array.isArray(value.requests) || value.requests.length > 50) throw new AccountError('invalid_response'); return value.requests.map(accountDraft); },
    async getDraft(id, options) { return accountDraft((await readOwnedDrafts(idPath(id), options)).request); },
    async saveDraft(record, { id, expectedRevision, idempotencyKey, ownerId, signal } = {}) {
      // Session-bound CSRF also prevents a cookie changed in another tab from
      // accepting the previous owner's body between this check and the write.
      const current = await getSession({ signal });
      if (!current || current.id !== ownerId) throw new AccountError('owner_changed');
      return accountDraft((await mutate(id ? idPath(id) : '/requests', id ? { record, expectedRevision } : { record, idempotencyKey }, { signal }, id ? 'PUT' : 'POST')).request);
    },
    async deleteDraft(id, expectedRevision, options) { const ownerId = user?.id; await confirmOwner(ownerId, options); const value = await mutate(idPath(id), { expectedRevision }, options, 'DELETE'); if (value.ok !== true) throw new AccountError('invalid_response'); }
  });
}
