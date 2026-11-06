import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createAccountHandler } from '../../accounts/handler.mjs';
import { createRequestRecord, newSubmission } from '../../dist/submission.js';

export const fixturePassword = 'Synthetic customer fixture password 088';
export const fixtureBase = fileURLToPath(new URL('../../work/accounts-088/test-fixtures/', import.meta.url));
export async function accountFixture({ directory, port = 0, clock = Date.now, authOptions = {}, origins, ...options } = {}) {
  directory ??= path.join(fixtureBase, randomUUID());
  await mkdir(directory, { recursive: true });
  let handler, closed = false;
  const server = http.createServer((request, response) => handler ? handler.handle(request, response) : response.writeHead(503).end());
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  try { handler = await createAccountHandler({ directory, origins: origins ?? [base], port, clock, authOptions, ...options }); }
  catch (error) { server.close(); throw error; }
  return { directory, port, base, server, async close() { if (closed) return; closed = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); handler.close(); } };
}
export function browser(base) {
  const jar = new Map(); let csrf = '';
  const api = {
    jar,
    get csrf() { return csrf; },
    set csrf(value) { csrf = value; },
    cookie() { return [...jar].map(([key, value]) => key + '=' + value).join('; '); },
    async call(route, method = 'GET', input, { headers = {}, raw, cookies = true, origin = true, update = true, ...options } = {}) {
      const requestHeaders = { ...(cookies && jar.size ? { Cookie: api.cookie() } : {}), ...(method !== 'GET' && method !== 'HEAD' && origin ? { Origin: base } : {}), ...(method !== 'GET' && method !== 'HEAD' && csrf ? { 'X-Account-CSRF': csrf } : {}), ...(input !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers };
      const response = await fetch(base + '/api/account' + route, { method, headers: requestHeaders, signal: AbortSignal.timeout(10000), ...(input !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(input) } : {}), ...options });
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
      if (update) {
        for (const value of response.headers.getSetCookie()) { const [pair] = value.split(';'), equals = pair.indexOf('='); const name = pair.slice(0, equals), content = pair.slice(equals + 1); if (content) jar.set(name, content); else jar.delete(name); }
        if (data?.csrfToken) csrf = data.csrfToken;
      }
      return { status: response.status, data, text, headers: response.headers, setCookies: response.headers.getSetCookie() };
    },
    async signup(email = 'fixture@example.invalid', password = fixturePassword) { await api.call('/session'); return api.call('/signup', 'POST', { email, password, name: 'Fixture customer', company: 'Synthetic only' }); }
  };
  return api;
}
export function draftRecord(name = 'Synthetic sample', suffix = 'FIXTURE') {
  const state = newSubmission('sample-1'); state.name = 'Fixture customer'; state.email = 'fixture@example.invalid'; state.samples[0].name = name;
  return createRequestRecord(state, { id: 'AN-REQ-' + suffix, createdAt: '2026-11-07T00:00:00.000Z' });
}
