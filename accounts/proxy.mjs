import http from 'node:http';
import { createHash } from 'node:crypto';
import { accountError } from './errors.mjs';
import { accountFailure, accountBodyLimit, canonicalAccountPath, canonicalOrigin, customerCookies, requestBoundary, privatePeer } from './boundary.mjs';

const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const allowed = ['accept', 'content-type', 'x-account-csrf', 'sec-fetch-site'];
export function createAccountProxy({ upstream, externalOrigin, port, bindAddress, production = false, timeout = 15000, clock = Date.now, peerMaximum = 100, peerWindowMs = 900000 } = {}) {
  const primary = canonicalOrigin(upstream), external = canonicalOrigin(externalOrigin);
  if (production || primary.protocol !== 'http:' || primary.hostname !== '127.0.0.1' || !primary.port || Number(primary.port) === port || external.protocol !== 'http:' || !privatePeer(external.hostname) || external.hostname.startsWith('127.') || Number(external.port) !== port || (bindAddress !== '0.0.0.0' && !privatePeer(bindAddress))) throw new Error('Customer account bridge requires a fixed loopback upstream and explicit private LAN origin.');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000 || !Number.isInteger(peerMaximum) || peerMaximum < 1 || !Number.isInteger(peerWindowMs) || peerWindowMs < 1) throw new Error('Invalid customer bridge limits.');
  const origins = [external.origin, `http://127.0.0.1:${port}`], peers = new Map(), issuedCsrf = new Map();
  const nonceHash = value => createHash('sha256').update(value).digest('hex');
  function limit(request) {
    const now = clock(), key = request.socket.remoteAddress;
    for (const [name, value] of peers) if (now - value.start >= peerWindowMs) peers.delete(name);
    const value = peers.get(key);
    if ((!value && peers.size >= 2048) || (value && value.count >= peerMaximum)) throw accountError(429, 'RATE_LIMITED', 'Too many account attempts. Try again later.', Math.max(1, Math.ceil((value ? value.start + peerWindowMs - now : peerWindowMs) / 1000)));
    if (value) value.count++; else peers.set(key, { start: now, count: 1 });
  }
  async function handle(request, response) {
    const head = request.method === 'HEAD';
    try {
      requestBoundary(request, origins, true);
      const target = canonicalAccountPath(request.url);
      const excluded = new Set((request.headers.connection || '').split(',').map(value => value.trim().toLowerCase()));
      const cookies = !excluded.has('cookie') ? customerCookies(request.headers.cookie, port) : {};
      for (const [key, expires] of issuedCsrf) if (clock() >= expires) issuedCsrf.delete(key);
      const knownNonce = cookies.csrf && issuedCsrf.has(nonceHash(cookies.csrf));
      if ((!['GET', 'HEAD'].includes(request.method)) || (target === '/api/account/session' && !knownNonce)) limit(request);
      const limitBytes = accountBodyLimit(request.method, target), chunks = []; let length = 0, oversized = false;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) { length += chunk.length; if (length > limitBytes) { oversized = true; break; } chunks.push(chunk); }
      if (oversized) { request.resume(); throw accountError(413, 'BODY_TOO_LARGE', 'Account request exceeds its size limit.'); }
      if (request.aborted || response.destroyed) return true;
      const headers = { host: primary.host, 'content-length': String(length) };
      for (const name of allowed) if (!excluded.has(name) && request.headers[name] !== undefined) headers[name] = request.headers[name];
      if (!excluded.has('origin') && request.headers.origin !== undefined) headers.origin = primary.origin;
      const forwarded = [];
      if (cookies.session) forwarded.push(`an_customer_${primary.port}=${cookies.session}`);
      if (cookies.csrf) forwarded.push(`an_customer_csrf_${primary.port}=${cookies.csrf}`);
      if (forwarded.length) headers.cookie = forwarded.join('; ');
      await new Promise(resolve => {
        let incoming;
        const outgoing = http.request({ hostname: '127.0.0.1', port: primary.port, method: request.method, path: target, headers, agent: false }, upstreamResponse => {
          incoming = upstreamResponse;
          if (response.destroyed) { incoming.destroy(); return; }
          const removed = new Set([...hop, ...(incoming.headers.connection || '').split(',').map(value => value.trim().toLowerCase())]);
          const output = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !removed.has(name) && name !== 'set-cookie' && !name.startsWith('access-control-')));
          const setCookies = [];
          if (!removed.has('set-cookie')) for (const kind of ['session', 'csrf']) {
            const from = `${kind === 'session' ? 'an_customer_' : 'an_customer_csrf_'}${primary.port}`, to = `${kind === 'session' ? 'an_customer_' : 'an_customer_csrf_'}${port}`;
            const values = (incoming.headers['set-cookie'] || []).filter(value => value.startsWith(from + '='));
            if (values.length === 1) {
              setCookies.push(to + values[0].slice(from.length));
              if (kind === 'csrf') {
                const next = values[0].slice(from.length + 1).split(';')[0], seconds = Number(/(?:^|;)\s*Max-Age=(\d+)/i.exec(values[0])?.[1] ?? 0);
                if (cookies.csrf && next !== cookies.csrf) issuedCsrf.delete(nonceHash(cookies.csrf));
                if (/^[a-f0-9]{64}$/.test(next) && seconds > 0) {
                  while (issuedCsrf.size >= 8192) issuedCsrf.delete(issuedCsrf.keys().next().value);
                  issuedCsrf.set(nonceHash(next), clock() + Math.min(seconds, 604800) * 1000);
                }
              }
            }
          }
          if (setCookies.length) output['set-cookie'] = setCookies;
          response.writeHead(incoming.statusCode, output);
          incoming.on('error', () => { accountFailure(response, accountError(502, 'ACCOUNT_UNAVAILABLE', 'Customer accounts are unavailable.'), head); resolve(); });
          incoming.pipe(response);
        });
        const close = () => { if (!response.writableFinished) { outgoing.destroy(); incoming?.destroy(); } resolve(); };
        response.once('close', close);
        response.once('finish', () => { response.removeListener('close', close); resolve(); });
        outgoing.setTimeout(timeout, () => { accountFailure(response, accountError(504, 'ACCOUNT_TIMEOUT', 'The account request timed out.'), head); outgoing.destroy(); });
        outgoing.on('error', () => { accountFailure(response, accountError(502, 'ACCOUNT_UNAVAILABLE', 'Customer accounts are unavailable.'), head); resolve(); });
        outgoing.end(Buffer.concat(chunks, length));
      });
      return true;
    } catch (error) { if (!request.complete && !request.destroyed) request.resume(); accountFailure(response, error, head); return true; }
  }
  return { handle };
}
