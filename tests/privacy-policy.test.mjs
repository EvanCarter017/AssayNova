import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolvePageRoute } from '../dist/routes.js';

test('public privacy route has factual account/Google/storage/retention disclosure and a separate ordinary footer link', async () => {
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8'), page = html.slice(html.indexOf('<section id="privacy-policy-view"'), html.indexOf('<section id="account-view"'));
  assert.equal(resolvePageRoute('/privacy-policy').heading, 'privacy-policy-title'); assert.match(html, /<footer[\s\S]*href="\/privacy-policy">Privacy policy<\/a>/); assert.match(page, /supports@assaynovalabs\.com/);
  for (const text of ['provider identifier', 'Gmail', 'Google password', 'refresh tokens', 'does not establish ownership', 'SameSite=Lax', '/api/account/oauth/google', '10 minutes', 'backups', 'handled manually', 'does not itself erase']) assert.ok(page.includes(text), text);
  assert.doesNotMatch(page, /GDPR compliant|certified|automatically approved|delete.{0,15}30 days/i); assert.equal(resolvePageRoute('/privacy-policy-extra'), null);
});
test('factual cookie inventory and fallback both disclose conditional same bounded Google flow cookie', async () => {
  const source = await readFile(new URL('../dist/privacy/consent.js', import.meta.url), 'utf8');
  assert.equal((source.match(/an_google_flow_\[port\]/g) || []).length, 2); assert.equal((source.match(/Secure\/HttpOnly\/SameSite=Lax browser binding and PKCE/g) || []).length, 2); assert.doesNotMatch(source, /two necessary cookies/); assert.match(source, /10 minutes maximum/); assert.match(source, /at most 10 minutes/);
});
