import http from 'node:http';
import { isIP } from 'node:net';

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const forwardedHeaders = ['accept', 'content-type', 'x-admin-csrf', 'x-studio-token', 'sec-fetch-site'];
const inNamespace = pathname => pathname === '/admin' || pathname.startsWith('/admin/');

export function isPrivateIPv4(address) {
  if (typeof address !== 'string' || isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function isAdminProxyPeer(address) {
  if (typeof address !== 'string') return false;
  if (address.startsWith('::ffff:')) address = address.slice(7);
  return isIP(address) === 4 && (address.startsWith('127.') || isPrivateIPv4(address));
}

function literalOrigin(value) {
  const match = /^http:\/\/(\d+\.\d+\.\d+\.\d+):([1-9]\d*)$/.exec(value ?? '');
  if (!match || isIP(match[1]) !== 4 || Number(match[2]) > 65535) throw new Error('Use a canonical plain HTTP IPv4 origin with an explicit port.');
  return { origin: value, hostname: match[1], port: Number(match[2]), host: match[1] + ':' + match[2] };
}

// This bridge owns no catalog, credentials, sessions or report store.
export function createAdminProxy({ upstream, externalOrigin, port, bindAddress, timeout = 60000 } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Admin proxy is disabled in production.');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (bindAddress !== '0.0.0.0' && !isPrivateIPv4(bindAddress))) throw new Error('Admin proxy requires a wildcard or private IPv4 bind.');
  const primary = literalOrigin(upstream), external = literalOrigin(externalOrigin);
  if (primary.hostname !== '127.0.0.1' || primary.port === port) throw new Error('Admin proxy requires a distinct fixed 127.0.0.1 upstream port.');
  if (!isPrivateIPv4(external.hostname) || external.port !== port) throw new Error('Admin proxy origin must be a private IPv4 address on the listener port.');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw new Error('Invalid admin proxy timeout.');
  const hosts = new Set([external.host, '127.0.0.1:' + port]);
  const primaryCookie = 'an_admin_' + primary.port, bridgeCookie = 'an_admin_' + port;

  function cookieForPrimary(raw) {
    if (typeof raw !== 'string' || raw.length > 4096) return undefined;
    const matches = raw.split(';').map(value => value.trim()).filter(value => value.split('=')[0].trim() === bridgeCookie);
    if (matches.length !== 1 || !new RegExp('^' + bridgeCookie + '=[a-f0-9]{64}$').test(matches[0])) return undefined;
    return primaryCookie + matches[0].slice(bridgeCookie.length);
  }
  function safeHeaders(source) {
    const excluded = new Set([...hopHeaders, ...(source.connection || '').split(',').map(value => value.trim().toLowerCase())]);
    return Object.fromEntries(Object.entries(source).filter(([name]) => !excluded.has(name) && name !== 'set-cookie' && !name.startsWith('access-control-')));
  }
  function fail(response, status, head = false) {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    response.end(head ? undefined : status === 504 ? 'Administration request timed out.' : status === 502 ? 'Administration is unavailable.' : 'Administration request rejected.');
  }

  async function handle(request, response) {
    const target = request.url || '', pathname = target.split('?')[0], head = request.method === 'HEAD';
    // Check the unmodified peer, Host and Origin before rewriting any header.
    const externalRequestOrigin = 'http://' + request.headers.host;
    if (!isAdminProxyPeer(request.socket?.remoteAddress) || !hosts.has(request.headers.host) ||
        (request.headers.origin !== undefined && request.headers.origin !== externalRequestOrigin) ||
        (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== externalRequestOrigin) ||
        (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) {
      fail(response, 403, head); return true;
    }
    if (!inNamespace(pathname) || /[%\\\x00-\x20\x7f]/.test(pathname) || /[\x00-\x20\x7f]/.test(target) || pathname.includes('//') || pathname.split('/').some(part => part === '.' || part === '..')) {
      fail(response, 400, head); return true;
    }
    if (pathname === '/admin/auth/setup' || pathname === '/admin/auth/setup/') { fail(response, 403, head); return true; }
    const chunks = []; let length = 0;
    try {
      // Do not destroy IncomingMessage's socket on a normal completed request.
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > 8192) { request.resume(); fail(response, 413, head); return true; }
        chunks.push(chunk);
      }
    } catch { fail(response, 400, head); return true; }
    if (request.aborted || response.destroyed) return true;
    const excluded = new Set((request.headers.connection || '').split(',').map(value => value.trim().toLowerCase()));
    const headers = { host: primary.host, 'content-length': String(length) };
    for (const name of forwardedHeaders) if (!excluded.has(name) && request.headers[name] !== undefined) headers[name] = request.headers[name];
    const cookie = !excluded.has('cookie') && cookieForPrimary(request.headers.cookie);
    if (cookie) headers.cookie = cookie;
    if (!excluded.has('origin') && request.headers.origin !== undefined) headers.origin = primary.origin;
    await new Promise(resolve => {
      let incoming;
      const outgoing = http.request({ hostname: primary.hostname, port: primary.port, method: request.method, path: target, headers, agent: false }, upstreamResponse => {
        incoming = upstreamResponse;
        if (response.destroyed) { incoming.destroy(); return; }
        const headers = safeHeaders(incoming.headers);
        const nominated = (incoming.headers.connection || '').split(',').map(value => value.trim().toLowerCase());
        const cookies = nominated.includes('set-cookie') ? [] : (incoming.headers['set-cookie'] || []).filter(value => value.startsWith(primaryCookie + '='));
        if (cookies.length === 1) headers['set-cookie'] = cookies[0].replace(primaryCookie + '=', bridgeCookie + '=');
        response.writeHead(incoming.statusCode, headers);
        incoming.on('error', () => { fail(response, 502, head); resolve(); });
        incoming.pipe(response);
      });
      const close = () => { if (!response.writableFinished) { outgoing.destroy(); incoming?.destroy(); } resolve(); };
      response.once('close', close);
      response.once('finish', () => { response.removeListener('close', close); resolve(); });
      outgoing.setTimeout(timeout, () => { fail(response, 504, head); outgoing.destroy(); });
      outgoing.on('error', () => { fail(response, 502, head); resolve(); });
      outgoing.end(Buffer.concat(chunks, length));
    });
    return true;
  }
  return { handle };
}
