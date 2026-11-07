import { createAccountRequest, requestStatus } from '../dist/account-requests.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, readFile, copyFile, symlink, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { openAccountDatabase, privateDirectory } from '../accounts/database.mjs';
import { accountConfiguration } from '../accounts/config.mjs';
import { loopback, privatePeer } from '../accounts/boundary.mjs';
import { backupAccounts } from '../scripts/account-backup.mjs';
import { accountFixture, browser, fixtureBase, fixturePassword, draftRecord } from './support/customer-account-fixture.mjs';

test('native account backup restores users and owned drafts without copying live WAL files', async t => {
  const f = await accountFixture(); t.after(() => f.close()); const a = browser(f.base); await a.signup(); const created = await a.call('/requests', 'POST', { record: draftRecord(), idempotencyKey: 'backup-fixture-first-088' }); assert.equal(created.status, 201);
  const root = path.join(fixtureBase, randomUUID()), output = path.join(root, 'snapshot.sqlite'); await mkdir(root, { recursive: true });
  assert.deepEqual(await backupAccounts({ directory: f.directory, output }), { ok: true, schemaVersion: 1 });
  await assert.rejects(backupAccounts({ directory: f.directory, output }), /EEXIST/);
  const restored = path.join(root, 'restored'); await mkdir(restored); await copyFile(output, path.join(restored, 'accounts.sqlite'));
  const after = await accountFixture({ directory: restored }); t.after(() => after.close()); const b = browser(after.base); await b.call('/session'); assert.equal((await b.call('/login', 'POST', { email: 'fixture@example.invalid', password: fixturePassword })).status, 200);
  const list = await b.call('/requests'); assert.equal(list.data.requests.length, 1); assert.equal(list.data.requests[0].id, created.data.request.id);
});

test('account migrations reopen idempotently and fail closed on future schema or corruption', async () => {
  const directory = path.join(fixtureBase, randomUUID()); let db = await openAccountDatabase({ directory }); assert.equal(db.get('PRAGMA user_version').user_version, 1); assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1); assert.equal(db.get('PRAGMA synchronous').synchronous, 2); assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal'); db.close();
  db = await openAccountDatabase({ directory }); assert.equal(db.get('SELECT count(*) AS n FROM account_users').n, 0); db.run('PRAGMA user_version=99'); db.close(); await assert.rejects(openAccountDatabase({ directory }), /unavailable/);
  const check = new DatabaseSync(path.join(directory, 'accounts.sqlite'), { readOnly: true }); assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99); check.close();
  const corrupt = path.join(fixtureBase, randomUUID()); await mkdir(corrupt); const filename = path.join(corrupt, 'accounts.sqlite'); await writeFile(filename, 'Synthetic corrupt database fixture'); const before = await readFile(filename); await assert.rejects(openAccountDatabase({ directory: corrupt }), /unavailable/); assert.deepEqual(await readFile(filename), before);
});

test('private account paths reject public data and redirected directories without scanning', async () => {
  const projectRoot = path.join(fixtureBase, randomUUID()); await mkdir(projectRoot, { recursive: true });
  for (const name of ['dist', 'work/admin-auth', 'work/report-studio']) await assert.rejects(privateDirectory(path.join(projectRoot, name), { projectRoot }), /separate/);
  const target = path.join(projectRoot, 'target'), linked = path.join(projectRoot, 'redirect'); await mkdir(target); await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(privateDirectory(linked, { projectRoot }), /redirected/);
});

test('genuine Windows temporary short-name ancestors canonicalize before account directory creation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'assaynova-account-alias-'));
  const canonicalRoot = await realpath(root), canonicalParent = await realpath(tmpdir());
  t.after(async () => {
    const value = path.resolve(canonicalRoot), parent = path.resolve(canonicalParent);
    assert.equal(path.dirname(value).toLowerCase(), parent.toLowerCase()); assert.ok(path.basename(value).startsWith('assaynova-account-alias-')); assert.notEqual(value.toLowerCase(), parent.toLowerCase());
    await rm(value, { recursive: true, force: true });
  });
  const directory = path.join(root, 'new-private', 'accounts'); const db = await openAccountDatabase({ directory });
  assert.equal(db.directory.toLowerCase(), (await realpath(directory)).toLowerCase()); assert.equal(db.get('PRAGMA user_version').user_version, 1); db.close();
});

test('default-on account configuration preserves explicit static opt-out and a DB-free LAN proxy', () => {
  assert.equal(accountConfiguration({ argv: [], env: {}, bindAddress: '127.0.0.1', port: 4317 }).mode, 'authority');
  assert.deepEqual(accountConfiguration({ argv: ['--no-accounts'], env: { NODE_ENV: 'production' }, bindAddress: '0.0.0.0', port: 4318 }), { mode: 'disabled' });
  const proxy = accountConfiguration({ argv: [], env: {}, bindAddress: '0.0.0.0', port: 4318, adminProxy: { upstream: 'http://127.0.0.1:4317', externalOrigin: 'http://192.168.0.60:4318' } }); assert.equal(proxy.mode, 'proxy'); assert.equal(proxy.directory, undefined);
  assert.throws(() => accountConfiguration({ argv: [], env: {}, bindAddress: '0.0.0.0', port: 4318 }), /nonloopback/);
  assert.throws(() => accountConfiguration({ argv: [], env: { NODE_ENV: 'production' }, bindAddress: '127.0.0.1', port: 4317 }), /HTTPS/);
  assert.equal(accountConfiguration({ argv: ['--account-origin=https://accounts.example.invalid'], env: { NODE_ENV: 'production' }, bindAddress: '127.0.0.1', port: 4317 }).mode, 'authority');
  assert.throws(() => accountConfiguration({ argv: ['--account-origin=http://accounts.example.invalid'], env: { NODE_ENV: 'production' }, bindAddress: '127.0.0.1', port: 4317 }), /HTTPS/);
  assert.throws(() => accountConfiguration({ argv: ['--account-store=relative'], env: {}, bindAddress: '127.0.0.1', port: 4317 }), /absolute/);
  for (const address of ['127.tenant.example', '127.evil', '::ffff:127.evil', '192.168.example']) { assert.equal(loopback(address), false); assert.equal(privatePeer(address), false); }
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(loopback(address), true);
  assert.throws(() => accountConfiguration({ argv: ['--account-origin=http://127.tenant.example:4317'], env: {}, bindAddress: '127.0.0.1', port: 4317 }), /limited to local/);
});

test('schema one stores v3 beside exact legacy JSON and reopening never rewrites or promotes old records',async t=>{
 const f=await accountFixture();const a=browser(f.base);await a.signup('legacy099@example.invalid');const legacy=draftRecord('Legacy saved request','LEGACY099');legacy.notes='  exact old representation  ';
 const old=(await a.call('/requests','POST',{record:legacy,idempotencyKey:'legacy099-preserved-key'})).data.request;
 const submitted=createAccountRequest('contact',{name:'Fixture',email:'fixture@example.invalid',topic:'website',message:'Submitted contact'}, {id:'AN-REQ-CONTACT099',createdAt:'2026-11-07T00:00:00.000Z'});
 assert.equal((await a.call('/requests','POST',{record:submitted,idempotencyKey:'legacy099-new-contact-key'})).status,201);await f.close();
 const db=new DatabaseSync(path.join(f.directory,'accounts.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);const before=db.prepare('SELECT record_json FROM account_requests WHERE id=?').get(old.id).record_json;db.close();assert.equal(before,JSON.stringify(legacy));
 const restarted=await accountFixture({directory:f.directory});t.after(()=>restarted.close());const login=browser(restarted.base);await login.call('/session');assert.equal((await login.call('/login','POST',{email:'legacy099@example.invalid',password:fixturePassword})).status,200);const records=(await login.call('/requests')).data.requests;assert.equal(records.length,2);const preserved=records.find(doc=>doc.id===old.id);assert.equal(JSON.stringify(preserved.record),before);assert.equal(requestStatus(preserved.record),'Saved · Not submitted');
 const canonical=(({name,email,company,notes,reportRecipient,samples})=>({name,email,company,notes,reportRecipient,samples}))(legacy);const converted=createAccountRequest('testing',canonical,legacy);const updated=await login.call('/requests/'+old.id,'PUT',{record:converted,expectedRevision:1});assert.equal(updated.status,200);assert.equal(updated.data.request.id,old.id);assert.equal(updated.data.request.revision,2);assert.equal(updated.data.request.record.status,'Submitted');
});
