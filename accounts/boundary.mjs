import { isIP } from 'node:net';
import { accountError } from './errors.mjs';

export const accountNamespace = value => value === '/api/account' || value.startsWith('/api/account/');
export function canonicalAccountPath(target) {
  if (typeof target !== 'string' || /[%\\\x00-\x20\x7f]/.test(target) || target.includes('?') || target.includes('#') || target.includes('//') || target.split('/').some(part => part === '.' || part === '..') || !accountNamespace(target)) throw accountError(400, 'INVALID_PATH', 'Account request path was rejected.');
  return target;
}
export const accountBodyLimit = (method, target) => ((method === 'POST' && target === '/api/account/requests') || (method === 'PUT' && /^\/api\/account\/requests\/[a-f0-9]{32}$/.test(target))) ? 65536 : 8192;
export function loopback(address) {
  if (typeof address !== 'string' || !isIP(address)) return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  return isIP(ipv4) === 4 && ipv4.split('.')[0] === '127';
}
export function privatePeer(address) {
  if (typeof address !== 'string' || !isIP(address)) return false;
  const normalized = address.toLowerCase(), ip = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  if (isIP(ip) !== 4) return loopback(ip);
  const [a,b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function canonicalOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Choose a canonical account origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value || url.pathname !== '/' || url.search || url.hash) throw new Error('Choose a canonical account origin.');
  return url;
}
export function requestBoundary(request, origins, allowPrivate = false) {
  const matches = (request.rawHeaders || []).filter((_, index, all) => index % 2 === 0 && all[index].toLowerCase() === 'host').length;
  if ((request.rawHeaders && matches !== 1) || !(allowPrivate ? privatePeer(request.socket?.remoteAddress) : loopback(request.socket?.remoteAddress))) throw accountError(403, 'REQUEST_REJECTED', 'Account request was rejected.');
  const origin = origins.find(value => new URL(value).host === request.headers.host);
  if (!origin || (request.headers.origin !== undefined && request.headers.origin !== origin) || (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin) || (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) throw accountError(403, 'REQUEST_REJECTED', 'Account request was rejected.');
  return origin;
}
export function customerCookies(raw, port) {
  const names = { session: 'an_customer_' + port, csrf: 'an_customer_csrf_' + port };
  const result = { session: '', csrf: '' };
  if (typeof raw !== 'string' || raw.length > 4096) return result;
  for (const kind of Object.keys(names)) {
    const values = raw.split(';').map(part => part.trim()).filter(part => part.split('=')[0].trim() === names[kind]);
    if (values.length === 1 && new RegExp('^' + names[kind] + '=[a-f0-9]{64}$').test(values[0])) result[kind] = values[0].slice(names[kind].length + 1);
  }
  return result;
}
export const accountHeaders = Object.freeze({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
export function accountFailure(response, error, head = false) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  const known = Number.isInteger(error.status) && typeof error.code === 'string' && error.status >= 400 && error.status <= 599;
  response.writeHead(known ? error.status : 503, { ...accountHeaders, ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) });
  response.end(head ? undefined : JSON.stringify({ error: { code: known ? error.code : 'ACCOUNT_UNAVAILABLE', message: known ? error.message : 'Customer accounts are unavailable. Try again later.' } }));
}
