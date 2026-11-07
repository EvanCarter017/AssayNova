import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadGoogleConfig } from '../accounts/google-config.mjs';
import { googleConfig } from './support/fake-google.mjs';
import { GOOGLE_ORIGIN } from '../accounts/google-provider.mjs';
async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'assaynova-google102-'))); await chmod(directory, 0o700); const projectRoot = path.join(directory, 'source'); await mkdir(projectRoot);
  const filename = path.join(directory, 'google.json'), clientFile = path.join(directory, 'client.json'), document = { version: 1, enabled: true, publicOrigin: GOOGLE_ORIGIN, clientFile };
  const web = { client_id: googleConfig.clientId, client_secret: googleConfig.clientSecret, redirect_uris: ['http://localhost/obsolete'], auth_uri: 'https://untrusted-metadata.invalid/auth', token_uri: 'https://untrusted-metadata.invalid/token' };
  const options = { filename, projectRoot, accountOptions: { mode: 'authority', directory: path.join(directory, 'accounts'), origins: [GOOGLE_ORIGIN], allowPrivate: false }, bindAddress: '127.0.0.1' };
  return { directory, projectRoot, filename, clientFile, document, web, options, async load(config = document, client = { web }, overrides = {}) { await writeFile(filename, typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 }); await writeFile(clientFile, typeof client === 'string' ? client : JSON.stringify(client), { mode: 0o600 }); return loadGoogleConfig({ ...options, ...overrides }); } };
}
test('absent Google config is off without touching missing project/files; disabled config is exact', async () => {
  assert.deepEqual(await loadGoogleConfig({ filename: '', projectRoot: 'missing102' }), { enabled: false }); const f = await fixture(); assert.deepEqual(await f.load({ version: 1, enabled: false, publicOrigin: null, clientFile: null }), { enabled: false }); await assert.rejects(f.load({ ...f.document, enabled: false }));
});
test('Web-client arrays and stale redirects are accepted but endpoint metadata is never trusted', async () => {
  const f = await fixture(), config = await f.load(); assert.equal(config.enabled, true); assert.deepEqual(Object.keys(config).sort(), ['clientId', 'clientSecret', 'enabled', 'publicOrigin']); assert.equal(config.publicOrigin, GOOGLE_ORIGIN); assert.equal(config.token_uri, undefined);
});
test('config rejects duplicate/large/wrong client/credentials URL/control/unknown metadata with generic errors', async () => {
  const f = await fixture();
  for (const [config, client] of [['{"version":1,"version":1}', { web: f.web }], [' '.repeat(16385), { web: f.web }], [f.document, { installed: f.web }], [f.document, { web: { ...f.web, client_secret: '' } }], [f.document, { web: { ...f.web, auth_uri: 'https://user:password@evil.invalid' } }], [f.document, { web: { ...f.web, extra: true } }], [f.document, '{"web":{"client_id":"one","client_id":"two"}}'], [f.document, { web: { ...f.web, redirect_uris: Array(33).fill('https://example.invalid') } }], [f.document, { web: { ...f.web, project_id: 'line\ncontrol' } }]]) await assert.rejects(f.load(config, client), error => error.message === 'Google sign-in configuration is unavailable.');
});
test('enabled mode requires sole loopback pinned HTTPS authority and private nonredirected files', async () => {
  const f = await fixture();
  for (const overrides of [{ bindAddress: '0.0.0.0' }, { accountOptions: { ...f.options.accountOptions, allowPrivate: true } }, { accountOptions: { ...f.options.accountOptions, mode: 'proxy' } }, { accountOptions: { ...f.options.accountOptions, origins: [GOOGLE_ORIGIN, 'http://localhost'] } }]) await assert.rejects(f.load(f.document, { web: f.web }, overrides));
  for (const publicOrigin of ['http://assaynovalabs.com', GOOGLE_ORIGIN + '/', 'https://evil.invalid']) await assert.rejects(f.load({ ...f.document, publicOrigin }));
  await assert.rejects(f.load({ ...f.document, clientFile: 'relative.json' }));
  const link = path.join(f.directory, 'linked'); await symlink(f.projectRoot, link, process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(f.load({ ...f.document, clientFile: path.join(link, 'secret') }));
  if (process.platform !== 'win32') { await f.load(); await chmod(f.clientFile, 0o644); await assert.rejects(loadGoogleConfig(f.options)); }
});
