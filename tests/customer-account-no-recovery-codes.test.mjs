import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { googleFixture, googleConfig, syntheticProvider } from './support/fake-google.mjs';
import { fixturePassword, draftRecord } from './support/customer-account-fixture.mjs';
import { digest } from '../accounts/auth.mjs';

const mailConfig = enabled => enabled ? { enabled:true,reportNoticesEnabled:false,publicOrigin:'https://assaynovalabs.com',key:randomBytes(32),smtp:{host:'mail105.invalid',port:587,username:'supports@example.invalid',from:'supports@example.invalid',supportTo:'supports@example.invalid',password:'synthetic-only'} } : {enabled:false,reportNoticesEnabled:false};
const snapshot = f => ({users:f.db.prepare('SELECT * FROM account_users ORDER BY id').all(),sessions:f.db.prepare('SELECT * FROM account_sessions ORDER BY token_hash').all(),identities:f.db.prepare('SELECT * FROM account_identities ORDER BY subject').all(),codes:f.db.prepare('SELECT * FROM account_recovery_codes ORDER BY user_id,code_hash').all(),requests:f.db.prepare('SELECT * FROM account_requests ORDER BY id').all()});

test('new password and Google signup issue no codes and preserve a seeded historical hash',async t=>{
 const f=await googleFixture(t),a=f.client(),created=await a.signup();assert.equal(created.status,201);assert.equal(Object.hasOwn(created.data,'recoveryCodes'),false);assert.equal(f.db.prepare('SELECT count(*) n FROM account_recovery_codes').get().n,0);
 const oldHash=digest(created.data.user.id+'\0'+'A'.repeat(32));f.db.prepare('INSERT INTO account_recovery_codes VALUES(?,?)').run(created.data.user.id,oldHash);
 const b=f.client(),google=await f.login(b,{subject:'no-codes105',email:'no-codes105@gmail.com'});assert.equal(google.status,200);assert.equal(Object.hasOwn(google.data,'recoveryCodes'),false);assert.equal(google.data.user.googleLinked,true);assert.deepEqual(f.db.prepare('SELECT * FROM account_recovery_codes').all().map(row=>({...row})),[{user_id:created.data.user.id,code_hash:oldHash}]);
});

test('all retired routes return404 without user/session/password/request/hash mutation for every provider configuration',async t=>{
 for(const mailEnabled of[false,true])for(const googleEnabled of[false,true]){
  const provider=syntheticProvider(),config={...googleConfig,enabled:googleEnabled};const f=await googleFixture(t,{provider,googleOptions:{config,provider},mailOptions:{config:mailConfig(mailEnabled),transport:{send:async()=>({outcome:'accepted'})}}}),a=f.client();const created=await a.signup('retired105@example.invalid');assert.equal(created.status,201);
  const oldCode='B'.repeat(32);f.db.prepare('INSERT INTO account_recovery_codes VALUES(?,?)').run(created.data.user.id,digest(created.data.user.id+'\0'+oldCode));await a.call('/requests','POST',{record:draftRecord('Preserved request','RETIRED105'),idempotencyKey:'retired105-request-intent'});
  const before=snapshot(f),exchanges=provider.exchanges;
  for(const[route,input]of[['/recover',{email:created.data.user.email,recoveryCode:oldCode,newPassword:'Must not replace this password 105'}],['/recovery-codes',{currentPassword:fixturePassword}],['/oauth/google/recovery-codes',{}]]){const response=await a.call(route,'POST',input);assert.equal(response.status,404);assert.equal(response.data.error.code,'ACCOUNT_ROUTE_NOT_FOUND');assert.equal(response.setCookies.length,0);assert.deepEqual(snapshot(f),before);}
  assert.equal(provider.exchanges,exchanges);assert.equal((await a.call('/requests')).data.requests.length,1);
 }
});

test('seeded started/exchanging/ready legacy Google code purposes cannot exchange, complete or create a grant',async t=>{
 for(const state of['started','exchanging','ready']){
  const f=await googleFixture(t),a=f.client();const created=await f.login(a);f.db.prepare('UPDATE account_sessions SET google_reauth_at=NULL,google_reauth_purpose=NULL').run();
  const flow=await f.start(a,{},'reauth',{purpose:'password_setup'});if(state==='ready')await f.callback(a,flow);
  f.db.prepare('UPDATE account_google_flows SET reauth_purpose=?,status=?').run('recovery_codes',state);
  const before=snapshot(f),exchanges=f.provider.exchanges;assert.deepEqual((await a.call('/oauth/google/status')).data,{ready:false,intent:null});
  if(state==='started')await f.callback(a,flow);assert.equal(f.provider.exchanges,exchanges);
  assert.equal((await a.call('/oauth/google/complete','POST',{})).status,400);assert.equal(f.db.prepare('SELECT count(*) n FROM account_google_flows').get().n,0);assert.deepEqual(snapshot(f),before);
  f.db.prepare("UPDATE account_sessions SET google_reauth_at=?,google_reauth_purpose='recovery_codes' WHERE user_id=?").run(f.now,created.data.user.id);const old=snapshot(f);assert.equal((await a.call('/password/setup','POST',{newPassword:fixturePassword})).status,400);assert.deepEqual(snapshot(f),old);
 }
});

test('verified email reset advances both epochs, clears mail/Google actions and grants even when Google is disabled, without deleting old hashes',async t=>{
 for(const enabled of[true,false]){
  const provider=syntheticProvider(),config={...googleConfig},messages=[];
  const f=await googleFixture(t,{provider,googleOptions:{config,provider},mailOptions:{config:mailConfig(true),transport:{send:async payload=>{messages.push(payload);return{outcome:'accepted'};}}}}),a=f.client();const created=await a.signup();const id=created.data.user.id;
  f.db.prepare('UPDATE account_users SET email_verified_at=? WHERE id=?').run(f.now,id);f.db.prepare('INSERT INTO account_recovery_codes VALUES(?,?)').run(id,digest(id+'\0'+'C'.repeat(32)));
  const flow=await f.start(a,{},'link',{currentPassword:fixturePassword});await f.callback(a,flow);f.db.prepare("UPDATE account_sessions SET google_reauth_at=?,google_reauth_purpose='recovery_codes' WHERE user_id=?").run(f.now,id);config.enabled=enabled;
  const before=f.db.prepare('SELECT security_version,recovery_version FROM account_users WHERE id=?').get(id),hashes=f.db.prepare('SELECT * FROM account_recovery_codes').all(),b=f.client();await b.call('/session');assert.equal((await b.call('/password/reset-request','POST',{email:created.data.user.email})).status,202);
  for(let count=0;count<5&&!messages.some(item=>item.body.includes('/reset-password#token='));count++)await f.handler.pumpMail();const message=messages.find(item=>item.body.includes('/reset-password#token='));assert.ok(message);assert.match(message.body,/signs out all sessions/);assert.doesNotMatch(message.body,/recovery codes/i);const token=/#token=([a-f0-9]{64})/.exec(message.body)[1];
  const reset=await b.call('/password/reset','POST',{token,newPassword:'New verified mailbox password 105'});assert.equal(reset.status,200);assert.deepEqual(reset.data,{ok:true});assert.ok(reset.setCookies.every(cookie=>cookie.includes('Max-Age=0')));const after=f.db.prepare('SELECT security_version,recovery_version FROM account_users WHERE id=?').get(id);assert.equal(after.security_version,before.security_version+1);assert.equal(after.recovery_version,before.recovery_version+1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM account_sessions WHERE user_id=?').get(id).n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM account_google_flows').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM account_mail_tokens').get().n,0);assert.deepEqual(f.db.prepare('SELECT * FROM account_recovery_codes').all(),hashes);assert.equal((await b.call('/session')).data.authenticated,false);assert.equal((await b.call('/password/reset','POST',{token,newPassword:fixturePassword})).status,400);
 }
});
