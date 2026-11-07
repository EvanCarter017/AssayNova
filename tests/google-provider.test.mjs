import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleProvider, parseGoogleJSON, GOOGLE_TOKEN, GOOGLE_JWKS, GOOGLE_CALLBACK, googleAuthorizationURL } from '../accounts/google-provider.mjs';
import { googleConfig, signingKey, signedToken, responseJSON, hash } from './support/fake-google.mjs';

const key = signingKey(), rotated = signingKey('rotated102');
const time = Date.parse('2026-11-08T00:00:00Z'), nonce = 'a'.repeat(64);
const input = () => ({ code: 'synthetic-code-102', verifier: 'A'.repeat(43), nonceHash: hash('nonce\0' + nonce), createdAt: time });
const claims = (extra = {}) => ({ iss: 'https://accounts.google.com', aud: googleConfig.clientId, sub: 'synthetic-subject', exp: time / 1000 + 3600, iat: time / 1000, nonce, email: 'synthetic102@gmail.com', email_verified: true, name: '<Synthetic>\n person', ...extra });
function fixture({ token = signedToken(key, claims()), keys = [key.jwk], age = 'max-age=30', fetcher } = {}) {
  let now = time, hits = [], currentToken = token, currentKeys = keys;
  const client = createGoogleProvider({ config: googleConfig, clock: () => now, fetcher: fetcher || (async (url, options) => {
    hits.push(url); assert.equal(options.redirect, 'error');
    if (url === GOOGLE_TOKEN) { const data = new URLSearchParams(options.body); assert.equal(data.get('redirect_uri'), GOOGLE_CALLBACK); assert.equal(data.get('code_verifier'), input().verifier); assert.equal(data.get('client_secret'), googleConfig.clientSecret); return responseJSON({ id_token: currentToken, access_token: 'discard102', refresh_token: 'discard102' }); }
    assert.equal(url, GOOGLE_JWKS); return responseJSON({ keys: currentKeys }, { 'Cache-Control': age });
  }) });
  return { client, hits, setToken(value) { currentToken = value; }, setKeys(value) { currentKeys = value; }, advance(ms) { now += ms; } };
}
test('bounded array-aware JSON rejects decoded duplicate keys and grammar/resource attacks', () => {
  assert.equal(parseGoogleJSON('{"arrays":[1,true,null,{"v":"ok"}]}').arrays[3].v, 'ok');
  for (const value of ['{"a":1,"\\u0061":2}', '{"a":01}', '{"a":true,}', '[1,]', '[ '.repeat(10) + '0' + ']'.repeat(10), JSON.stringify(Array(33).fill(0)), JSON.stringify({ long: 'x'.repeat(4097) }), ' '.repeat(65537), '{"x":"\\ud800"}']) assert.throws(() => parseGoogleJSON(value), /unavailable/);
});
test('authorization is fixed code/PKCE/basic scopes with no offline or mailbox access', () => {
  const url = new URL(googleAuthorizationURL(googleConfig, { state: 'b'.repeat(64), nonce, verifier: input().verifier }));
  assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('scope'), 'openid email profile'); assert.equal(url.searchParams.get('response_type'), 'code'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('prompt'), 'select_account'); assert.equal(url.searchParams.has('access_type'), false); assert.equal(url.searchParams.has('login_hint'), false);
});
test('native RS256 verifies synthetic signature and returns only bounded identity fields, coalescing cached JWKS', async () => {
  const f = fixture(); const results = await Promise.all([f.client.exchange(input()), f.client.exchange(input()), f.client.exchange(input())]);
  assert.deepEqual(results[0], { subject: 'synthetic-subject', email: 'synthetic102@gmail.com', emailVerified: true, name: '<Synthetic>  person', hd: '' });
  assert.equal(f.hits.filter(url => url === GOOGLE_JWKS).length, 1); assert.equal(Object.keys(results[0]).some(key => /token/i.test(key)), false); await f.client.close();
});
test('native signature, algorithms, key URLs and canonical segment grammar fail closed', async () => {
  const invalid = [signedToken(rotated, claims(), { alg: 'RS256', kid: key.jwk.kid }), signedToken(key, claims(), { alg: 'HS256', kid: key.jwk.kid }), signedToken(key, claims(), { alg: 'none', kid: key.jwk.kid }), signedToken(key, claims(), { alg: 'RS256', kid: key.jwk.kid, jku: 'https://evil.invalid' }), signedToken(key, claims(), '{"alg":"RS256","alg":"RS256","kid":"' + key.jwk.kid + '"}'), signedToken(key, claims()) + '=', 'a.b.c', 'x'.repeat(16385)];
  for (const token of invalid) { const f = fixture({ token }); await assert.rejects(f.client.exchange(input()), /unavailable/); await f.client.close(); }
});
test('issuer/audience/azp/nonce/time/mail claims are validated without truthy coercion', async () => {
  for (const extra of [{ iss: 'https://evil.invalid' }, { aud: [googleConfig.clientId] }, { aud: 'other' }, { azp: 'other' }, { sub: '' }, { nonce: 'wrong' }, { exp: time / 1000 - 61 }, { iat: time / 1000 + 61 }, { iat: time / 1000 - 61 }, { exp: time / 1000 + 7201 }, { nbf: time / 1000 + 61 }, { email_verified: 'true' }, { email: 'bad@localhost' }]) {
    const f = fixture({ token: signedToken(key, claims(extra)) }); await assert.rejects(f.client.exchange(input()), /unavailable/); await f.client.close();
  }
});
test('public RSA signing keys reject private material, duplicate IDs and wrong type/strength/use', async () => {
  for (const keys of [[{ ...key.jwk, d: 'private' }], [key.jwk, key.jwk], [{ ...key.jwk, kty: 'EC' }], [{ ...key.jwk, use: 'enc' }], [{ ...key.jwk, alg: 'HS256' }], [{ ...key.jwk, n: 'AA' }], [{ ...key.jwk, e: 'Ag' }], []]) {
    const f = fixture({ keys }); await assert.rejects(f.client.exchange(input()), /unavailable/); await f.client.close();
  }
});
test('key rotation is bounded, unknown-kid floods cannot force refresh, expired caches never fail open', async () => {
  const f = fixture(); await f.client.exchange(input()); f.setToken(signedToken(rotated, claims())); f.setKeys([rotated.jwk]);
  await assert.rejects(f.client.exchange(input())); await assert.rejects(f.client.exchange(input())); assert.equal(f.hits.filter(v => v === GOOGLE_JWKS).length, 1);
  f.advance(30001); assert.equal((await f.client.exchange(input())).subject, 'synthetic-subject'); assert.equal(f.hits.filter(v => v === GOOGLE_JWKS).length, 2);
  f.advance(30001); f.setKeys([]); await assert.rejects(f.client.exchange(input())); await f.client.close();
});
test('response size/encoding/content type/redirect/network errors are sanitized and bounded', async () => {
  const responses = [() => new Response('x'.repeat(32769), { headers: { 'Content-Type': 'application/json' } }), () => new Response('{"id_token":', { headers: { 'Content-Type': 'application/json' } }), () => new Response('{}', { headers: { 'Content-Type': 'text/html' } }), () => new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/json' } }), () => { const r = responseJSON({}); Object.defineProperty(r, 'redirected', { value: true }); return r; }, () => { throw Error('Synthetic TLS failure contains private material'); }];
  for (const response of responses) { const f = fixture({ fetcher: async () => response() }); await assert.rejects(f.client.exchange(input()), error => error.message === 'Google sign-in is unavailable. Try again.'); await f.client.close(); }
});
test('concurrency has immediate cap four, cancellation and shutdown abort/drain exchanges', async () => {
  let calls = 0;
  const f = fixture({ fetcher: async (url, options) => { calls++; return new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(Error('Synthetic cancellation')), { once: true }); }); } });
  const running = Array.from({ length: 4 }, () => f.client.exchange(input())); await assert.rejects(f.client.exchange(input())); assert.equal(calls, 4); await f.client.close(); for (const item of running) await assert.rejects(item); await assert.rejects(f.client.exchange(input()));
  const abort = new AbortController(); abort.abort(); const c = fixture(); await assert.rejects(c.client.exchange({ ...input(), signal: abort.signal })); await c.client.close();
});

test('native request deadline cancels a stalled synthetic TLS request at five seconds', async () => {
  const started = Date.now(); let aborted = false;
  const f = fixture({ fetcher: async (url, options) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => reject(Error('Synthetic watchdog')), 7000);
    options.signal.addEventListener('abort', () => { aborted = true; clearTimeout(keepAlive); reject(Error('Synthetic request deadline')); }, { once: true });
  }) });
  await assert.rejects(f.client.exchange(input()), /unavailable/); assert.equal(aborted, true); assert.ok(Date.now() - started >= 4500 && Date.now() - started < 7000); await f.client.close();
});
