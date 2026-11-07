import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { accountFixture, fixturePassword } from './customer-account-fixture.mjs';
import { GOOGLE_CALLBACK, GOOGLE_ORIGIN, googleAuthorizationURL } from '../../accounts/google-provider.mjs';

export const googleConfig = Object.freeze({ enabled: true, publicOrigin: GOOGLE_ORIGIN, clientId: 'synthetic102.apps.googleusercontent.com', clientSecret: 'synthetic-secret-only-102' });
export const hash = value => createHash('sha256').update(value).digest('hex');
export function signingKey(kid = 'synthetic-key-102') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } };
}
export function signedToken(key, claims, header = { alg: 'RS256', kid: key.jwk.kid, typ: 'JWT' }) {
  const encoded = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const content = encoded(header) + '.' + encoded(claims);
  return content + '.' + sign('RSA-SHA256', Buffer.from(content), key.privateKey).toString('base64url');
}
export const responseJSON = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', ...headers } });
export function syntheticProvider() {
  const codes = new Map(); let exchanges = 0, gate = null, waiting = null, holdRelease = null;
  return {
    authorization: input => googleAuthorizationURL(googleConfig, input),
    prepare(url, claims = {}) {
      const auth = new URL(url), code = randomBytes(12).toString('hex');
      assert.equal(auth.searchParams.get('redirect_uri'), GOOGLE_CALLBACK);
      codes.set(code, { nonce: auth.searchParams.get('nonce'), challenge: auth.searchParams.get('code_challenge'), claims: { subject: 'subject-102', email: 'synthetic102@gmail.com', emailVerified: true, name: 'Synthetic person', hd: '', ...claims } });
      return { code, state: auth.searchParams.get('state') };
    },
    hold() { let release; gate = new Promise(resolve => { release = resolve; holdRelease = resolve; }); let began; waiting = new Promise(resolve => { began = resolve; }); return { release, waiting, began }; },
    onExchange: null,
    async exchange(input) {
      exchanges++; const item = codes.get(input.code); codes.delete(input.code);
      if (!item || hash('nonce\0' + item.nonce) !== input.nonceHash || createHash('sha256').update(input.verifier).digest('base64url') !== item.challenge) throw new Error('Synthetic exchange rejected.');
      this.onExchange?.(); if (gate) { const pending = gate; gate = null; await pending; }
      return item.claims;
    },
    get exchanges() { return exchanges; },
    async close() { holdRelease?.(); }
  };
}
export function canonicalBrowser(port) {
    const jar = new Map(); let csrf = '';
    const a = { jar, get csrf() { return csrf; }, set csrf(value) { csrf = value; }, cookie: () => [...jar].map(([k,v]) => k+'='+v).join('; '),
      async call(route, method = 'GET', input, opts = {}) {
        const headers = { Host: 'assaynovalabs.com', ...(jar.size && opts.cookies !== false ? { Cookie: a.cookie() } : {}), ...(!['GET','HEAD'].includes(method) ? { Origin: GOOGLE_ORIGIN, 'X-Account-CSRF': csrf } : {}), ...(input !== undefined || opts.raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers };
        const result = await new Promise((resolve, reject) => {
          const req = http.request({ hostname: '127.0.0.1', port, path: '/api/account'+route, method, headers }, res => {
            let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => { const responseHeaders = new Headers(); for (const [key,value] of Object.entries(res.headers)) for (const entry of Array.isArray(value)?value:[value]) if (entry !== undefined) responseHeaders.append(key,entry); let data; try { data=JSON.parse(text); } catch { data=null; } resolve({ status: res.statusCode, text, data, headers: responseHeaders, setCookies: res.headers['set-cookie'] || [] }); });
          }); req.on('error', reject); req.setTimeout(10000, () => req.destroy(Error('Synthetic HTTP timeout'))); req.end(opts.raw ?? (input === undefined ? undefined : JSON.stringify(input)));
        });
        if (opts.update !== false) { for (const cookie of result.setCookies) { const [pair] = cookie.split(';'), split = pair.indexOf('='), key = pair.slice(0,split), value = pair.slice(split+1); if (value) jar.set(key,value); else jar.delete(key); } if (result.data?.csrfToken) csrf=result.data.csrfToken; }
        return result;
      },
      async signup(email='fixture@example.invalid',password=fixturePassword) { await a.call('/session'); return a.call('/signup','POST',{email,password,name:'Fixture customer',company:'Synthetic only'}); }
    }; return a;
  }

export async function googleFixture(t, options = {}) {
  let now = Date.parse('2026-11-08T00:00:00Z');
  const provider = options.provider || syntheticProvider();
  const f = await accountFixture({ origins: [GOOGLE_ORIGIN], clock: () => now, googleOptions: { config: googleConfig, provider }, ...options });
  const db = new DatabaseSync(path.join(f.directory, 'accounts.sqlite'));
  t.after(async () => { db.close(); await f.close(); });
  function client() { return canonicalBrowser(f.port); }
  async function start(a, claims, intent = 'start', input = { next: '/account' }) {
    await a.call('/session');
    const r = await a.call('/oauth/google/' + intent, 'POST', input); assert.equal(r.status, 200, r.text);
    const prepared = provider.prepare(r.data.url, claims); return { ...prepared, started: r };
  }
  async function callback(a, flow, opts = {}) { return a.call('/oauth/google/callback?' + new URLSearchParams({ state: flow.state, code: flow.code }), 'GET', undefined, { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site', ...opts.headers }, ...opts }); }
  async function login(a, claims) { const flow = await start(a, claims); const cb = await callback(a, flow); assert.equal(cb.status, 303, cb.text); const result = await a.call('/oauth/google/complete', 'POST', {}); assert.equal(result.status, 200, result.text); return result; }
  return { ...f, db, provider, client, start, callback, login, get now() { return now; }, advance(ms) { now += ms; } };
}
