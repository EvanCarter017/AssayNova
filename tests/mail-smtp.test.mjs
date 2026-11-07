import test from 'node:test';
import assert from 'node:assert/strict';
import { createSMTPTransport, formatSMTPMessage } from '../accounts/mail-smtp.mjs';
import { fakeSMTP } from './support/fake-smtp.mjs';
import * as resendTLS from './support/resend-tls-fixtures.mjs';

const smtp = { host: 'mail101.invalid', port: 587, username: 'supports@example.invalid', from: 'supports@example.invalid', supportTo: 'supports@example.invalid', password: 'fabricated test only' };
const payload = { version: 1, to: 'recipient+test@example.invalid', messageId: '<' + 'a'.repeat(64) + '@example.invalid>', date: 'Sat, 07 Nov 2026 00:00:00 GMT', subject: 'Verify your AssayNova email', body: 'Synthetic UTF-8 测试\r\n.one\n..two\rthree' };
async function send(t, options = {}, transport = {}, extra = {}) { const fake = await fakeSMTP(options); t.after(() => fake.close()); const client = createSMTPTransport({ smtp, ca: fake.ca, dial: fake.dial, phaseTimeout: 1000, totalTimeout: 5000, ...transport }); return { fake, result: await client.send(payload, extra) }; }

test('STARTTLS wire sequence is serial, verified, re-EHLOs and encodes Unicode MIME once', async t => {
 const {fake,result}=await send(t,{fragment:true});assert.equal(result.outcome,'accepted');assert.deepEqual(fake.states,['plain:EHLO','plain:STARTTLS','tls:EHLO','tls:AUTH','tls:MAIL','tls:RCPT','tls:DATA','message','tls:QUIT']);
 const message=fake.messages[0];assert.match(message,/Content-Transfer-Encoding: base64/);const body=Buffer.from(message.split('\r\n\r\n')[1].replaceAll('\r\n',''),'base64').toString('utf8');assert.equal(body,'Synthetic UTF-8 测试\r\n.one\r\n..two\r\nthree');assert.ok(message.split('\r\n').every(line=>line.length<=998));assert.ok(!fake.states.some(state=>state==='plain:AUTH'));
});
test('LOGIN and final250 remain accepted when QUIT loses acknowledgement',async t=>{assert.equal((await send(t,{login:true,quitLoss:true})).result.outcome,'accepted');});
test('mandatory STARTTLS and authentication fail closed without plaintext AUTH',async t=>{
 for(const options of[{noStartTLS:true},{refuseTLS:true},{extraTLS:true},{authFailure:true}]){const {fake,result}=await send(t,options);assert.equal(result.outcome,'cooldown');assert.equal(fake.states.includes('plain:AUTH'),false);assert.equal(fake.messages.length,0);}
});
test('certificate CA, hostname and expiry are enforced with no TLS bypass',async t=>{
 assert.equal((await send(t,{}, {ca:undefined})).result.code,'tls');assert.equal((await send(t,{}, {smtp:{...smtp,host:'wrong101.invalid'}})).result.code,'tls');assert.equal((await send(t,{expired:true})).result.code,'tls');
});
test('SIZE and recipient 5xx are terminal; recipient 4xx retries without DATA',async t=>{
 for(const [options,outcome,code]of[[{size:100},'failed','message_too_large'],[{recipient:'550 rejected'},'failed','permanent'],[{recipient:'450 later'},'retry','temporary']]){const {fake,result}=await send(t,options);assert.equal(result.outcome,outcome);assert.equal(result.code,code);assert.equal(fake.messages.length,0);}
});
test('malformed, mixed-code, oversized, queued and incomplete replies are bounded',async t=>{
 for(const malformed of['250 bad\n','250-one\r\n550 mixed\r\n','250 '+ 'x'.repeat(510)+'\r\n','250 okay\r\n250 extra\r\n',Array(65).fill('250-more\r\n').join(''),'250 incomplete']){const {result}=await send(t,{malformed},{phaseTimeout:50,totalTimeout:200});assert.notEqual(result.outcome,'accepted');}
});
test('loss during or after DATA is uncertain; phase deadlines and cancellation clean up',async t=>{
 for(const options of[{lostAck:true},{midData:true}]){const {result}=await send(t,options);assert.equal(result.outcome,'retry');assert.equal(result.code,'uncertain');assert.equal(result.uncertain,true);}
 const started=Date.now();const silent=await send(t,{silent:true},{phaseTimeout:30,totalTimeout:100});assert.equal(silent.result.outcome,'retry');assert.ok(Date.now()-started<1500);
 const canceled=await send(t,{}, {}, {beforeData:async()=>false});assert.equal(canceled.result.outcome,'canceled');assert.equal(canceled.fake.messages.length,0);
});
test('mailbox/header injection and non-ASCII routing are rejected before dialing',()=>{
 for(const to of['a@example.invalid\r\nBcc: victim@example.invalid','Name <a@example.invalid>','a@example.invalid,b@example.invalid','ümlaut@example.invalid','"quoted"@example.invalid'])assert.throws(()=>formatSMTPMessage({...payload,to},smtp.from,smtp.supportTo));
 assert.throws(()=>formatSMTPMessage({...payload,subject:'bad\r\nheader'},smtp.from,smtp.supportTo));
 const message=formatSMTPMessage(payload,smtp.from,smtp.supportTo);assert.ok(message.length<131072);assert.match(message.toString(),/Message-ID: <a{64}@example.invalid>/);
});
test('total deadline during eligibility check is retryable, while explicit false is canceled',async t=>{const {result,fake}=await send(t,{}, {phaseTimeout:50,totalTimeout:75},{beforeData:()=>new Promise(()=>{})});assert.equal(result.outcome,'retry');assert.equal(result.uncertain,false);assert.equal(fake.messages.length,0);});
const resendSMTP={...smtp,host:'smtp.resend.com',username:'resend',from:'supports@assaynovalabs.com',supportTo:'supports@assaynovalabs.com',password:'synthetic-resend-password-only'};
for(const login of [false,true])test('Resend '+(login?'LOGIN':'PLAIN')+' authenticates exact identity over verified loopback TLS without changing mail routing',async t=>{
 const {fake,result}=await send(t,{login,tlsFixture:resendTLS,expected:{username:'resend',password:resendSMTP.password,from:resendSMTP.from,to:payload.to}},{smtp:resendSMTP});
 assert.equal(result.outcome,'accepted');assert.deepEqual(fake.checks,{auth:true,mailFrom:true,recipient:true});assert.equal(fake.messages.length,1);assert.equal(fake.states.includes('plain:AUTH'),false);assert.equal(fake.states.filter(state=>state==='tls:EHLO').length,1);
 assert.match(fake.messages[0],/^From: AssayNova <supports@assaynovalabs\.com>\r\n/);assert.match(fake.messages[0],/\r\nReply-To: <supports@assaynovalabs\.com>\r\n/);assert.match(fake.messages[0],/\r\nTo: <recipient\+test@example\.invalid>\r\n/);assert.equal(fake.messages[0].includes(resendSMTP.password),false);assert.equal(JSON.stringify(fake.states).includes(resendSMTP.password),false);
});
test('Resend auth keeps mandatory hostname/CA/STARTTLS/authentication failure boundaries',async t=>{
 for(const [options,transport,code] of [[{}, {}, 'tls'],[{tlsFixture:resendTLS},{ca:undefined},'tls'],[{tlsFixture:resendTLS,noStartTLS:true},{},'tls'],[{tlsFixture:resendTLS,authFailure:true},{},'authentication'],[{tlsFixture:resendTLS,expected:{username:'resend',password:'different-synthetic-password',from:resendSMTP.from,to:payload.to}},{},'authentication']]){
  const {fake,result}=await send(t,options,{smtp:resendSMTP,...transport});assert.equal(result.code,code);assert.equal(result.outcome,'cooldown');assert.equal(fake.messages.length,0);assert.equal(fake.states.includes('plain:AUTH'),false);
 }
});
test('constructor retains legacy mailbox identity flexibility and rejects Resend aliases before dialing',()=>{
 assert.doesNotThrow(()=>createSMTPTransport({smtp:{...smtp,username:'legacy-other@example.invalid'}}));
 let dials=0;for(const patch of[{host:'mail101.invalid'},{host:'SMTP.resend.com'},{host:'smtp.resend.com.evil.invalid'},{host:'smtp.resend.com\0'},{username:'Resend'},{username:'resend '},{username:'resend+alias'},{username:'resend\r\n'},{username:'ｒesend'},{username:{}},{port:465}])assert.throws(()=>createSMTPTransport({smtp:{...resendSMTP,...patch},dial:()=>{dials++;}}),/unavailable/);
 assert.equal(dials,0);
});
