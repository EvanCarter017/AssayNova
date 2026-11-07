import { AccountError, safeAccountNext } from './customer-account.js';

// No import-time requests or persistence. The callback carries no identity in its URL.
export function googleNavigation(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new AccountError('invalid_response');
  let url;
  try { url = new URL(value); } catch { throw new AccountError('invalid_response'); }
  if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.port || url.username || url.password || url.pathname !== '/o/oauth2/v2/auth' || url.hash) throw new AccountError('invalid_response');
  return url.href;
}

export function createGoogleAccountController({ client, navigateExternal = url => globalThis.location.assign(url), onComplete, onState = () => {} }) {
  let revision = 0, controller = null, attempted = false, retryable = false, busy = false;
  const owner = () => client.snapshot().user?.id || null;
  function leave() { revision++; controller?.abort(); controller = null; busy = false; retryable = false; }
  const current = ticket => ticket === revision && !controller?.signal.aborted;
  async function begin(intent, value) {
    leave(); attempted = false; controller = new AbortController(); const ticket = revision, originalOwner = owner(); busy = true; onState('pending');
    try {
      const options = { signal: controller.signal };
      const result = intent === 'login' ? await client.googleStart(safeAccountNext(value), options) : intent === 'link' ? await client.googleLink(value, options) : intent === 'reauth' ? await client.googleReauth(value, options) : null;
      if (!current(ticket) || owner() !== originalOwner) return;
      if (!result || Object.keys(result).length !== 1) throw new AccountError('invalid_response');
      navigateExternal(googleNavigation(result.url));
    } catch (error) { if (current(ticket)) onState('error', error); }
    finally { if (current(ticket)) busy = false; }
  }
  async function complete(ticket, originalOwner) {
    attempted = true; retryable = false; busy = true; onState('pending');
    try {
      const result = await client.googleComplete({ signal: controller.signal });
      if (current(ticket)) onComplete(result);
    } catch (error) {
      if (!current(ticket)) return;
      // A lost completion acknowledgement can have created a session. Recheck it
      // before offering a bounded manual retry; never repeat automatically.
      if (['network', 'aborted'].includes(error?.code)) {
        try {
          await client.getSession({ signal: controller.signal });
          if (!current(ticket)) return;
          const status = await client.googleStatus({ signal: controller.signal });
          if (!current(ticket)) return;
          if (owner() === originalOwner && status.ready) retryable = true;
          else if (!status.ready && owner()) { onState('confirmed'); return; }
        } catch { /* retain a neutral failure without private provider details */ }
      }
      if (current(ticket)) onState(retryable ? 'retryable' : 'error', error);
    } finally { if (current(ticket)) busy = false; }
  }
  async function enter() {
    leave(); controller = new AbortController(); const ticket = revision;
    onState('pending');
    try {
      await client.getSession({ signal: controller.signal });
      if (!current(ticket)) return;
      const originalOwner = owner(), status = await client.googleStatus({ signal: controller.signal });
      if (!current(ticket) || owner() !== originalOwner) return;
      if (!status.ready) { onState('unavailable'); return; }
      if (!attempted) await complete(ticket, originalOwner);
      else onState('error', new AccountError('google_flow_invalid'));
    } catch (error) { if (current(ticket)) onState('error', error); }
  }
  async function retry() {
    if (!retryable || busy || !controller) return;
    retryable = false; const ticket = revision, originalOwner = owner();
    try {
      await client.getSession({ signal: controller.signal });
      if (!current(ticket) || owner() !== originalOwner) return;
      const status = await client.googleStatus({ signal: controller.signal });
      if (!current(ticket) || owner() !== originalOwner) return;
      if (!status.ready) { onState('unavailable'); return; }
      await complete(ticket, originalOwner);
    } catch (error) { if (current(ticket)) onState('error', error); }
  }
  return Object.freeze({ begin, enter, retry, leave });
}
