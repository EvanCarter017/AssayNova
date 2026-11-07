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
  assert.deepEqual(await backupAccounts({ directory: f.directory, output }), { ok: true, schemaVersion: 2 });
  await assert.rejects(backupAccounts({ directory: f.directory, output }), /EEXIST/);
  const restored = path.join(root, 'restored'); await mkdir(restored); await copyFile(output, path.join(restored, 'accounts.sqlite'));
  const after = await accountFixture({ directory: restored }); t.after(() => after.close()); const b = browser(after.base); await b.call('/session'); assert.equal((await b.call('/login', 'POST', { email: 'fixture@example.invalid', password: fixturePassword })).status, 200);
  const list = await b.call('/requests'); assert.equal(list.data.requests.length, 1); assert.equal(list.data.requests[0].id, created.data.request.id);
});

test('account migrations reopen idempotently and fail closed on future schema or corruption', async () => {
  const directory = path.join(fixtureBase, randomUUID()); let db = await openAccountDatabase({ directory }); assert.equal(db.get('PRAGMA user_version').user_version, 2); assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1); assert.equal(db.get('PRAGMA synchronous').synchronous, 2); assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal'); db.close();
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
  assert.equal(db.directory.toLowerCase(), (await realpath(directory)).toLowerCase()); assert.equal(db.get('PRAGMA user_version').user_version, 2); db.close();
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

test('schema two stores v3 beside exact legacy JSON and reopening never rewrites or promotes old records',async t=>{
 const f=await accountFixture();const a=browser(f.base);await a.signup('legacy099@example.invalid');const legacy=draftRecord('Legacy saved request','LEGACY099');legacy.notes='  exact old representation  ';
 const old=(await a.call('/requests','POST',{record:legacy,idempotencyKey:'legacy099-preserved-key'})).data.request;
 const submitted=createAccountRequest('contact',{name:'Fixture',email:'fixture@example.invalid',topic:'website',message:'Submitted contact'}, {id:'AN-REQ-CONTACT099',createdAt:'2026-11-07T00:00:00.000Z'});
 assert.equal((await a.call('/requests','POST',{record:submitted,idempotencyKey:'legacy099-new-contact-key'})).status,201);await f.close();
 const db=new DatabaseSync(path.join(f.directory,'accounts.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);const before=db.prepare('SELECT record_json FROM account_requests WHERE id=?').get(old.id).record_json;db.close();assert.equal(before,JSON.stringify(legacy));
 const restarted=await accountFixture({directory:f.directory});t.after(()=>restarted.close());const login=browser(restarted.base);await login.call('/session');assert.equal((await login.call('/login','POST',{email:'legacy099@example.invalid',password:fixturePassword})).status,200);const records=(await login.call('/requests')).data.requests;assert.equal(records.length,2);const preserved=records.find(doc=>doc.id===old.id);assert.equal(JSON.stringify(preserved.record),before);assert.equal(requestStatus(preserved.record),'Saved · Not submitted');
 const canonical=(({name,email,company,notes,reportRecipient,samples})=>({name,email,company,notes,reportRecipient,samples}))(legacy);const converted=createAccountRequest('testing',canonical,legacy);const updated=await login.call('/requests/'+old.id,'PUT',{record:converted,expectedRevision:1});assert.equal(updated.status,200);assert.equal(updated.data.request.id,old.id);assert.equal(updated.data.request.revision,2);assert.equal(updated.data.request.record.status,'Submitted');
});

const schemaOne = "CREATE TABLE account_users (\n  id TEXT PRIMARY KEY CHECK(length(id)=32),\n  email TEXT NOT NULL UNIQUE,\n  name TEXT NOT NULL,\n  company TEXT NOT NULL,\n  password_salt TEXT NOT NULL CHECK(length(password_salt)=32),\n  password_hash TEXT NOT NULL CHECK(length(password_hash)=64),\n  security_version INTEGER NOT NULL CHECK(security_version>0),\n  recovery_version INTEGER NOT NULL CHECK(recovery_version>0),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n) STRICT;\nCREATE TABLE account_sessions (\n  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),\n  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,\n  csrf_hash TEXT NOT NULL CHECK(length(csrf_hash)=64),\n  security_version INTEGER NOT NULL,\n  created_at INTEGER NOT NULL,\n  last_seen INTEGER NOT NULL,\n  expires_at INTEGER NOT NULL\n) STRICT;\nCREATE INDEX account_sessions_user ON account_sessions(user_id);\nCREATE TABLE account_challenges (\n  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),\n  expires_at INTEGER NOT NULL\n) STRICT;\nCREATE TABLE account_recovery_codes (\n  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,\n  code_hash TEXT NOT NULL CHECK(length(code_hash)=64),\n  PRIMARY KEY(user_id,code_hash)\n) STRICT;\nCREATE TABLE account_requests (\n  id TEXT PRIMARY KEY CHECK(length(id)=32),\n  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,\n  revision INTEGER NOT NULL CHECK(revision>0),\n  record_json TEXT NOT NULL CHECK(json_valid(record_json)),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n) STRICT;\nCREATE INDEX account_requests_user ON account_requests(user_id,updated_at DESC,id);\nCREATE TABLE account_idempotency (\n  user_id TEXT NOT NULL REFERENCES account_users(id) ON DELETE CASCADE,\n  request_key TEXT NOT NULL,\n  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),\n  request_id TEXT REFERENCES account_requests(id) ON DELETE SET NULL,\n  PRIMARY KEY(user_id,request_key)\n) STRICT;\nCREATE TABLE account_rates (\n  bucket_hash TEXT PRIMARY KEY CHECK(length(bucket_hash)=64),\n  window_start INTEGER NOT NULL,\n  count INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n) STRICT;\nPRAGMA user_version=1;\n";

async function legacyFixture() {
 const directory=path.join(fixtureBase,randomUUID());await mkdir(directory,{recursive:true});const raw=new DatabaseSync(path.join(directory,'accounts.sqlite'));raw.exec(schemaOne);
 const user='a'.repeat(32),id='b'.repeat(32),record=JSON.stringify(draftRecord('Exact legacy representation','MIGRATE101'));
 raw.prepare('INSERT INTO account_users VALUES(?,?,?,?,?,?,1,1,?,?)').run(user,'legacy101@example.invalid','Fixture','Company','c'.repeat(32),'d'.repeat(64),1,1);
 raw.prepare('INSERT INTO account_requests VALUES(?,?,1,?,?,?)').run(id,user,record,1,1);raw.prepare('INSERT INTO account_sessions VALUES(?,?,?,1,1,1,9999999999999)').run('e'.repeat(64),user,'f'.repeat(64));raw.close();return{directory,user,id,record};
}
test('real schema-one migration preserves IDs, session bindings and raw JSON without notification backfill',async()=>{
 const f=await legacyFixture();const output=path.join(fixtureBase,randomUUID()+'.sqlite');assert.deepEqual(await backupAccounts({directory:f.directory,output}),{ok:true,schemaVersion:1});
 const original=new DatabaseSync(output,{readOnly:true});assert.equal(original.prepare('PRAGMA user_version').get().user_version,1);assert.equal(original.prepare('SELECT record_json FROM account_requests').get().record_json,f.record);original.close();
 const [a,b]=await Promise.all([openAccountDatabase({directory:f.directory}),openAccountDatabase({directory:f.directory})]);
 for(const db of[a,b]){assert.equal(db.get('PRAGMA user_version').user_version,2);assert.equal(db.get('SELECT email_verified_at FROM account_users WHERE id=?',f.user).email_verified_at,null);assert.deepEqual({...db.get('SELECT record_json,notification_revision FROM account_requests WHERE id=?',f.id)},{record_json:f.record,notification_revision:null});assert.equal(db.get('SELECT user_id FROM account_sessions').user_id,f.user);assert.equal(db.get('SELECT count(*) AS n FROM account_mail_events').n,0);db.close();}
});
test('partial migration DDL rolls back atomically and unknown constraint shapes remain rejected',async()=>{
 const f=await legacyFixture(),moduleDirectory=path.join(fixtureBase,randomUUID());await mkdir(moduleDirectory);await copyFile(new URL('../accounts/database.mjs',import.meta.url),path.join(moduleDirectory,'database.mjs'));await copyFile(new URL('../accounts/schema.sql',import.meta.url),path.join(moduleDirectory,'schema.sql'));
 await writeFile(path.join(moduleDirectory,'migrate-1-to-2.sql'),'ALTER TABLE account_users ADD COLUMN email_verified_at INTEGER; SELECT missing_column FROM missing_table;');
 const {openAccountDatabase:broken}=await import(new URL('file:///'+path.join(moduleDirectory,'database.mjs').replaceAll('\\','/')).href);await assert.rejects(broken({directory:f.directory}),/unavailable/);
 const unchanged=new DatabaseSync(path.join(f.directory,'accounts.sqlite'),{readOnly:true});assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version,1);assert.equal(unchanged.prepare('PRAGMA table_info(account_users)').all().some(column=>column.name==='email_verified_at'),false);assert.equal(unchanged.prepare('SELECT record_json FROM account_requests').get().record_json,f.record);unchanged.close();
 const damaged=await legacyFixture();const raw=new DatabaseSync(path.join(damaged.directory,'accounts.sqlite'));raw.exec('DROP INDEX account_requests_user');raw.close();await assert.rejects(openAccountDatabase({directory:damaged.directory}),/unavailable/);
});
test('native schema-two backup restores retained ciphertext with its original key and queue identity',async t=>{
 const {createMailOutbox}=await import('../accounts/mail-outbox.mjs'),{randomBytes}=await import('node:crypto');const f=await legacyFixture(),db=await openAccountDatabase({directory:f.directory});t.after(()=>db.close());db.run('UPDATE account_users SET email_verified_at=1');const config={enabled:true,reportNoticesEnabled:false,publicOrigin:'https://backup101.example.invalid',key:randomBytes(32),smtp:{host:'mail101.invalid',port:587,username:'supports@example.invalid',from:'supports@example.invalid',supportTo:'supports@example.invalid',password:'synthetic only'}};
 const {createAccountRequests}=await import('../accounts/requests.mjs');const mail=createMailOutbox({db,config,transport:{send:async()=>({outcome:'accepted'})}}),requests=createAccountRequests({db,mail});const user=db.get('SELECT * FROM account_users'),record=createAccountRequest('contact',{name:'Fixture',email:user.email,topic:'testing',message:'Encrypted backup fixture'},{id:'AN-REQ-BACKUP101',createdAt:'2026-11-07T00:00:00.000Z'});requests.create(user,{record,idempotencyKey:'mail101-native-backup-key'});const before=db.all('SELECT event_key,ciphertext FROM account_mail_outbox ORDER BY event_key'),parent=path.join(fixtureBase,randomUUID());await mkdir(parent);const output=path.join(parent,'backup.sqlite');assert.deepEqual(await backupAccounts({directory:f.directory,output}),{ok:true,schemaVersion:2});const restored=path.join(parent,'restored');await mkdir(restored);await copyFile(output,path.join(restored,'accounts.sqlite'));const after=await openAccountDatabase({directory:restored});t.after(()=>after.close());assert.deepEqual(after.all('SELECT event_key,ciphertext FROM account_mail_outbox ORDER BY event_key'),before);let accepted=0;const worker=createMailOutbox({db:after,config,transport:{send:async()=>{accepted++;return{outcome:'accepted'};}}});await worker.pump();await worker.pump();assert.equal(accepted,2);assert.equal(after.get('SELECT count(*) AS n FROM account_mail_outbox').n,0);assert.equal(after.get('SELECT record_json FROM account_requests WHERE id=?',f.id).record_json,f.record);
});
