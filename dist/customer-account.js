import { parseAccountRequest, createAccountRequest, requestKind } from './account-requests.js';

// Customer-only transport. Importing this module has no DOM/storage/network I/O.
export const safeAccountNext = value => ['/account', '/submit-sample', '/contact', '/contact?request=report-recovery'].includes(value) ? value : '/account';
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
  if (!value || !opaque(value.id) || typeof value.email !== 'string' || value.email.length > 160 || typeof value.emailVerified !== 'boolean' || typeof value.name !== 'string' || value.name.length > 100 || typeof value.company !== 'string' || value.company.length > 160) throw new AccountError('invalid_response');
  if (value.passwordEnabled !== undefined && typeof value.passwordEnabled !== 'boolean' || value.googleLinked !== undefined && typeof value.googleLinked !== 'boolean') throw new AccountError('invalid_response');
  return { id: value.id, email: value.email, emailVerified: value.emailVerified, name: value.name, company: value.company, passwordEnabled: value.passwordEnabled ?? true, googleLinked: value.googleLinked ?? false };
}
const notificationStates = new Set(['not_requested','not_verified','not_configured','unsupported_address','backpressure','unavailable','queued','retrying','accepted','failed','expired','canceled']);
export function accountNotifications(value) {
  if (value === undefined) return { receipt: 'not_requested', support: 'not_requested', retryable: false };
  if (!value || Array.isArray(value) || Object.keys(value).length !== 3 || !notificationStates.has(value.receipt) || !notificationStates.has(value.support) || typeof value.retryable !== 'boolean') throw new AccountError('invalid_response');
  return { receipt: value.receipt, support: value.support, retryable: value.retryable };
}
function mailCapability(value) { if (value === undefined) return false; if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.enabled !== 'boolean') throw new AccountError('invalid_response'); return value.enabled; }
export function accountRequest(value) {
  const record = parseAccountRequest(value?.record);
  if (!value || !opaque(value.id) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !record || !iso(value.createdAt) || !iso(value.updatedAt)) throw new AccountError('invalid_response');
  return { id: value.id, revision: value.revision, record, createdAt: value.createdAt, updatedAt: value.updatedAt, notifications: accountNotifications(value.notifications) };
}
export class AccountError extends Error {
  constructor(code = 'request_failed', status = 0) { super('Customer account request could not be completed.'); this.name = 'AccountError'; this.code = typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code.toLowerCase() : 'request_failed'; this.status = status; }
}
export function accountErrorMessage(error) {
  const message = ({ invalid_action: 'This link is invalid, used or expired. Request a new link.', invalid_credentials: 'The email and password could not be confirmed.', invalid_recovery: 'Those recovery details could not be confirmed.', recovery_failed: 'Those recovery details could not be confirmed.', account_exists: 'An account could not be created with these details. Try signing in or use account recovery.', email_exists: 'An account could not be created with these details. Try signing in or use account recovery.', draft_limit: 'Your account already has 50 requests. Remove an existing request before submitting another.', revision_conflict: 'This request has changed. Your details are still here. Reopen it from My account before replacing a newer version.', idempotency_conflict: 'This submission reference already has different details. Your details are still here. Reopen the request from My account.', request_deleted: 'This request was deleted. Your details are still here. Open My account before starting a new request.', request_not_found: 'This request is no longer available. Open My account to see your current requests.', account_changed: 'Account security changed. Please sign in again before continuing.', invalid_password: 'Use a password of 15–128 characters.', invalid_input: 'Check the details and try again.', validation_error: 'Check the details and try again.', invalid_record: 'Check the request details and try again.', invalid_revision: 'Reopen the request from My account before submitting again.', invalid_response: 'We could not confirm the submitted result. Please retry safely.', owner_changed: 'The signed-in account changed. Open the request again from My account.', network: 'The connection did not confirm the result. Your details are still here; retrying will not create another request.', aborted: 'The result was not confirmed here. Check My account or retry the submission safely.', unavailable: 'Account access is unavailable in this view.' })[error?.code];
  if (['google_flow_invalid','google_identity_conflict'].includes(error?.code)) return error.code === 'google_identity_conflict' ? 'Sign in with an existing method, then link Google in Security.' : 'Confirm with Google again in Security, then retry.';
  if (message) return message;
  if (error?.status === 429) return 'Too many attempts. Please wait a moment and try again.';
  if (error?.status === 401) return 'Please sign in again. Your unsaved details are still here.';
  if (error?.status === 409) return 'This request has changed or was already submitted. Your details are still here. Reopen it from My account before replacing a newer version.';
  if (error?.status === 403) return 'Your sign-in check expired. Please retry the action.';
  return 'We could not complete that action. Please check your details and try again.';
}

export function createCustomerAccountClient({ fetcher = (...args) => globalThis.fetch(...args), timeout = 12000 } = {}) {
  let user = null, csrf = '', loaded = false, revision = 0, mailEnabled = false, googleEnabled = false;
  const listeners = new Set();
  const notify = reason => { for (const listener of listeners) listener(user, reason); };
  function setSession(nextUser, token, reason, capability = mailEnabled, googleCapability = googleEnabled) { mailEnabled = capability; googleEnabled = googleCapability; user = nextUser ? accountUser(nextUser) : null; csrf = typeof token === 'string' ? token : ''; loaded = true; notify(reason); }
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
        const error = new AccountError(value?.error?.code, response.status); const retry = Number(response.headers?.get?.('Retry-After')); if (Number.isSafeInteger(retry) && retry > 0 && retry <= 86400) error.retryAfter = retry;
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
    setSession(value.user, value.csrfToken, 'session', mailCapability(value.mail), mailCapability(value.google));
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
    if (suffix === '/signup') return confirmAuthenticationResult(value, ticket, options);
    if (typeof value.csrfToken !== 'string' || !value.csrfToken) throw new AccountError('invalid_response');
    setSession(value.user, value.csrfToken, 'login', mailCapability(value.mail), mailCapability(value.google));
    return value;
  }
  const idPath = id => { if (!opaque(id)) throw new AccountError('invalid_input'); return '/requests/' + id; };
  async function confirmOwner(ownerId, options) {
    const current = await getSession(options);
    if (!ownerId || !current || current.id !== ownerId) throw new AccountError('owner_changed');
  }
  async function confirmAuthenticationResult(value, ticket, options, ownerId = null) {
    if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted');
    const returnedUser = accountUser(value.user);
    if (ownerId && returnedUser.id !== ownerId) throw new AccountError('owner_changed');
    if (typeof value.csrfToken !== 'string' || !value.csrfToken) throw new AccountError('invalid_response');
    mailCapability(value.mail); mailCapability(value.google);
    // A successful POST can precede a cross-tab cookie replacement. Its JSON
    // is not proof that the returned owner still controls this browser.
    const confirmedUser = await getSession(options);
    if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted');
    if (!confirmedUser || confirmedUser.id !== returnedUser.id) throw new AccountError('owner_changed');
    // Preserve the fresh session's user, CSRF and capabilities; an older POST
    // acknowledgement must not overwrite a rotated or replacement session.
    setSession(confirmedUser, csrf, 'login');
    return { ...value, user: confirmedUser, csrfToken: csrf };
  }
  async function authenticateCurrentOwner(suffix, body, options) {
    const ownerId = user?.id;
    await confirmOwner(ownerId, options);
    const ticket = ++revision, value = await mutate(suffix, body, options);
    if (user?.id !== ownerId) throw new AccountError('owner_changed');
    return confirmAuthenticationResult(value, ticket, options, ownerId);
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
  const client = {
    getSession, snapshot: () => ({ user, loaded, mail: { enabled: mailEnabled }, google: { enabled: googleEnabled } }), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    signup: (values, options) => authenticate('/signup', values, options), login: (values, options) => authenticate('/login', values, options),
    async googleStart(next,options) { return mutate('/oauth/google/start',{next:safeAccountNext(next)},options); },
    async googleLink(currentPassword,options) { const owner=user?.id;await confirmOwner(owner,options);const value=await mutate('/oauth/google/link',{currentPassword},options);await confirmOwner(owner,options);return value; },
    async googleReauth(purpose,options) { const owner=user?.id;await confirmOwner(owner,options);const value=await mutate('/oauth/google/reauth',{purpose},options);await confirmOwner(owner,options);return value; },
    async googleStatus(options) { const value=await call('GET','/oauth/google/status',undefined,options);if(!value || Object.keys(value).length!==2 || typeof value.ready!=='boolean' || ![null,'login','link','reauth'].includes(value.intent) || value.ready!==(value.intent!==null))throw new AccountError('invalid_response');return value; },
    async googleComplete(options) {
      const owner=user?.id || null,ticket=++revision;const value=await mutate('/oauth/google/complete',{},options);
      if(ticket!==revision || options?.signal?.aborted)throw new AccountError('aborted');
      const nextUser=accountUser(value.user);
      if(!['login','link','reauth'].includes(value.intent) || safeAccountNext(value.next)!==value.next || typeof value.csrfToken!=='string' || !value.csrfToken || (value.intent==='login'?owner!==null:!owner || nextUser.id!==owner) || (user?.id || null)!==owner)throw new AccountError('owner_changed');
      return confirmAuthenticationResult(value,ticket,options,owner);
    },
    async setupPassword(newPassword,options) {return (await authenticateCurrentOwner('/password/setup',{newPassword},options)).user;},
    async googleUnlink(currentPassword,options) {return (await authenticateCurrentOwner('/oauth/google/unlink',{currentPassword},options)).user;},

    async logout(all = false, options) { const ticket = ++revision; const value = await mutate(all ? '/logout-all' : '/logout', {}, options); if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted'); if (value.ok !== true) throw new AccountError('invalid_response'); setSession(null, '', 'logout'); },
    async profile(values, options) { const ticket = revision; const value = await mutate('/profile', values, options, 'PATCH'); if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted'); setSession(value.user, csrf, 'profile', mailCapability(value.mail), mailCapability(value.google)); return user; },
    async password(values, options) { const ticket = ++revision; const value = await mutate('/password', values, options); if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted'); if (typeof value.csrfToken !== 'string' || !value.csrfToken) throw new AccountError('invalid_response'); setSession(value.user, value.csrfToken, 'password', mailCapability(value.mail), mailCapability(value.google)); return user; },
    async requestVerification(options) { const ownerId = user?.id; await confirmOwner(ownerId, options); const value = await mutate('/email/verification', {}, options); await confirmOwner(ownerId, options); if (value.ok !== true || !['verified','queued','not_configured','unsupported_address','backpressure','unavailable'].includes(value.status)) throw new AccountError('invalid_response'); return value; },
    async requestPasswordReset(email, options) { const value = await mutate('/password/reset-request', { email }, options); if (value.ok !== true || Object.keys(value).length !== 1) throw new AccountError('invalid_response'); return value; },
    async verifyEmail(token, options) { const ownerId = (await getSession(options))?.id || null; const value = await mutate('/email/verify', { token }, options); if (value.ok !== true || Object.keys(value).length !== 1) throw new AccountError('invalid_response'); const current = await getSession(options); if ((current?.id || null) !== ownerId) throw new AccountError('owner_changed'); return value; },
    async resetPassword(token, newPassword, options) { const ticket = ++revision; const value = await mutate('/password/reset', { token, newPassword }, options); if (ticket !== revision || options?.signal?.aborted) throw new AccountError('aborted'); if (value.ok !== true) throw new AccountError('invalid_response'); setSession(null, '', 'recovered'); return value; },
    async retryNotifications(id, expectedRevision, options) { const ownerId = user?.id; await confirmOwner(ownerId, options); const value = await mutate(idPath(id) + '/notifications', { expectedRevision }, options); await confirmOwner(ownerId, options); return accountRequest(value.request); },
    async listDrafts(options) { const value = await readOwnedDrafts('/requests', options); if (!Array.isArray(value.requests) || value.requests.length > 50) throw new AccountError('invalid_response'); return value.requests.map(accountDraft); },
    async getDraft(id, options) { return accountRequest((await readOwnedDrafts(idPath(id), options)).request); },
    async saveDraft(record, { id, expectedRevision, idempotencyKey, ownerId, signal } = {}) {
      // Session-bound CSRF also prevents a cookie changed in another tab from
      // accepting the previous owner's body between this check and the write.
      const current = await getSession({ signal });
      if (!current || current.id !== ownerId) throw new AccountError('owner_changed');
      const value = await mutate(id ? idPath(id) : '/requests', id ? { record, expectedRevision } : { record, idempotencyKey }, { signal }, id ? 'PUT' : 'POST');
      await confirmOwner(ownerId, { signal });
      return accountRequest(value.request);
    },
    async deleteDraft(id, expectedRevision, options) { const ownerId = user?.id; await confirmOwner(ownerId, options); const value = await mutate(idPath(id), { expectedRevision }, options, 'DELETE'); if (value.ok !== true) throw new AccountError('invalid_response'); await confirmOwner(ownerId, options); }
  };
  client.listRequests = client.listDrafts; client.getRequest = client.getDraft; client.saveRequest = client.saveDraft; client.deleteRequest = client.deleteDraft;
  return Object.freeze(client);
}

export const accountDraft = accountRequest;

// One in-memory intent state machine for all forms. A lost acknowledgement is
// replayed exactly before applying current edits with the acknowledged revision.
export function createSubmissionIntent({ save, makeId = () => crypto.randomUUID(), now = () => new Date().toISOString() }) {
  let reference = null, remote = null, pending = null, owner = null, busy = false, generation = 0;
  return Object.freeze({
    cancel() { generation++; busy = false; },
    reset() { generation++; reference = remote = pending = owner = null; busy = false; },
    resume(document, ownerId) { generation++; const doc = accountRequest(document); reference = { id: doc.record.id, createdAt: doc.record.createdAt }; remote = { ...doc, ownerId }; pending = null; owner = ownerId; },
    async submit(kind, details, ownerId, { signal, current = () => true } = {}) {
      if (busy) throw new AccountError('aborted');
      if (!ownerId || owner && owner !== ownerId) throw new AccountError('owner_changed');
      owner = ownerId;
      if (remote && requestKind(remote.record) !== kind) throw new AccountError('invalid_record');
      if (!reference) reference = { id: 'AN-REQ-' + makeId().toUpperCase().slice(0, 64), createdAt: now() };
      const latest = createAccountRequest(kind, details, reference);
      if (!remote && !pending) pending = { record: latest, key: 'request-' + makeId(), ownerId };
      busy = true; const ticket = generation;
      const check = () => { if (ticket !== generation || signal?.aborted || !current() || owner !== ownerId) throw new AccountError('aborted'); };
      try {
        if (!remote) {
          const attempt = pending;
          const ack = accountRequest(await save(attempt.record, { ownerId, idempotencyKey: attempt.key, signal }));
          check();
          if (ack.revision !== 1 || JSON.stringify(ack.record) !== JSON.stringify(attempt.record)) throw new AccountError('invalid_response');
          remote = { ...ack, ownerId }; pending = null;
        }
        if (JSON.stringify(latest) !== JSON.stringify(remote.record)) {
          const previous = remote;
          const ack = accountRequest(await save(latest, { id: previous.id, expectedRevision: previous.revision, ownerId, signal }));
          check();
          if (ack.id !== previous.id || ack.revision !== previous.revision + 1 || JSON.stringify(ack.record) !== JSON.stringify(latest)) throw new AccountError('invalid_response');
          remote = { ...ack, ownerId };
        }
        check(); return remote;
      } finally { if (ticket === generation) busy = false; }
    }
  });
}
