// Pure helpers: importing this module never touches a browser or the network.
export const MAIL_ACTION_PATHS = Object.freeze(['/verify-email', '/reset-password']);
const states = Object.freeze({ not_requested: 'Not requested', not_verified: 'Verify email to request a receipt', not_configured: 'Email unavailable', unsupported_address: 'Email unavailable for this address', backpressure: 'Email queue is full', unavailable: 'Email temporarily unavailable', queued: 'Queued', retrying: 'Retrying', accepted: 'Mail server accepted', failed: 'Email failed', expired: 'Email expired', canceled: 'Email canceled' });
export function notificationText(state) { return states[state] || states.unavailable; }
export function captureMailAction(location, history) {
  if (!MAIL_ACTION_PATHS.includes(location?.pathname)) return null;
  const match = !location.search && /^#token=([a-f0-9]{64})$/.exec(location.hash || '');
  // Clear even malformed fragments and query strings before any awaited work.
  history.replaceState(null, '', location.pathname);
  return match ? match[1] : null;
}
export function createMailActionState() {
  let token = null, revision = 0, pending = false;
  return Object.freeze({
    enter(value) { revision++; pending = false; token = typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null; },
    clear() { revision++; pending = false; token = null; },
    ready: () => !!token, current: () => token,
    async submit(work) { if (!token || pending) return null; const ticket = revision, snapshot = token; pending = true; try { const result = await work(snapshot); if (ticket !== revision) return null; token = null; return result; } finally { if (ticket === revision) pending = false; } }
  });
}
