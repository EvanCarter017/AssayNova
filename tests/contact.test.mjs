import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { CONTACT_DRAFT_KEY, CONTACT_TOPICS, normalizeContact, validateContact, parseContactDraft, formatContactMessage } from '../dist/contact.js';
import { createContactForm } from '../dist/contact-form.js';
const valid={name:'QA Person',email:'qa@example.invalid',topic:'website',message:'A synthetic website question.'};
const serialized=value=>JSON.stringify({version:1,...value});
const user={id:'user-a',name:'Synthetic user',email:'qa@example.invalid'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const documentFor=(record,revision=1)=>({id:'doc-a',revision,record,createdAt:record.createdAt,updatedAt:record.createdAt});
function fixture({kind='contact',save=async record=>documentFor(record),enabled=true,signedIn=true}={}) {
  const prefix=kind==='contact'?'contact':'support', keys=kind==='contact'?['name','email','topic','message']:['email','reference','notes'];
  const events=new Map(), nodes=new Map();let serial=0;
  const node=id=>{const n={id,value:'',textContent:'',hidden:false,disabled:false,attributes:new Map(),dataset:{},setAttribute(k,v){this.attributes.set(k,String(v));},removeAttribute(k){this.attributes.delete(k);},getAttribute(k){return this.attributes.get(k)||null;},focus(){},closest(selector){return selector==='[data-inquiry-action]'&&this.dataset.inquiryAction?this:null;}};nodes.set('#'+id,n);return n;};
  for(const key of keys){node(prefix+'-'+key);node(prefix+'-error-'+key);}for(const id of ['error','status'])node(prefix+'-'+id);
  const panel=node('fields');nodes.set('[data-inquiry-fields]',panel);
  const gate=node('gate'),submit=node('submit'),view=node('view'),signIn=node('sign-in'),fresh=node('new');view.dataset.inquiryAction='view';signIn.dataset.inquiryAction='sign-in';fresh.dataset.inquiryAction='new';
  for(const [selector,n] of [['[data-inquiry-gate]',gate],['[type="submit"]',submit],['[data-inquiry-action="view"]',view],['[data-inquiry-action="sign-in"]',signIn]])nodes.set(selector,n);
  const form={isConnected:true,hidden:false,setAttribute(){},closest(){return this.hidden?{}:null;},querySelector:selector=>nodes.get(selector)||null,addEventListener(type,callback){events.set(type,[...events.get(type)||[],callback]);},removeEventListener(type,callback){events.set(type,(events.get(type)||[]).filter(fn=>fn!==callback));}};
  const config={client:{snapshot:()=>({loaded:true,user:signedIn?user:null}),saveRequest:save},accountEnabled:enabled,kind,makeId:()=> 'synthetic-id-'+(++serial),now:()=> '2026-11-07T00:00:00.000Z'};
  const controller=createContactForm(form,config);controller.setAccountSession(signedIn?user:null);controller.activate();
  const emit=async(type,target)=>Promise.all((events.get(type)||[]).map(fn=>fn({target,preventDefault(){}})));
  return {form,controller,config,events,nodes,panel,gate,submit,view,fill(value=kind==='contact'?valid:{email:'qa@example.invalid',reference:'Synthetic project',notes:'Synthetic context'}){for(const[key,text]of Object.entries(value))nodes.get('#'+prefix+'-'+key).value=text;},input(key,value){const field=nodes.get('#'+prefix+'-'+key);field.value=value;return emit('input',field);},send:()=>emit('submit',form),action:action=>emit('click',action==='new'?fresh:action==='view'?view:signIn),status:()=>nodes.get('#'+prefix+'-status').textContent,error:()=>nodes.get('#'+prefix+'-error').textContent,values:()=>Object.fromEntries(keys.map(key=>[key,nodes.get('#'+prefix+'-'+key).value]))};
}

test('contact validation normalizes known fields and rejects raw types, blanks, topic choices and overlong values', () => {
  assert.deepEqual(normalizeContact({ ...valid, name: ' QA Person ', email: ' QA@example.invalid ', message: ' Question\n details ' }), { name: 'QA Person', email: 'QA@example.invalid', topic: 'website', message: 'Question\n details' });
  assert.deepEqual(validateContact(valid), {});
  for (const key of Object.keys(valid)) for (const value of [null, false, 12, {}, []]) assert.ok(validateContact({ ...valid, [key]: value })[key]);
  for (const [key, limit] of [['name', 120], ['email', 160], ['message', 4000]]) assert.ok(validateContact({ ...valid, [key]: ' ' + 'x'.repeat(limit) })[key]);
  for (const topic of ['', 'unknown', 'toString', ' website ']) assert.ok(validateContact({ ...valid, topic }).topic);
  assert.ok(validateContact({ ...valid, name: ' \n ' }).name);
  assert.ok(validateContact({ ...valid, message: '\t ' }).message);
  assert.ok(validateContact({ ...valid, email: 'missing@domain' }).email);
  assert.deepEqual(Object.keys(CONTACT_TOPICS), ['testing', 'report', 'website', 'other']);
});

test('strict contact draft parsing supports maximum escaped JSON and rejects corrupt schemas without partial values', () => {
  const maximum = { ...valid, name: 'N' + '\u0001'.repeat(119), message: 'M' + '\u0001'.repeat(3999) };
  assert.ok(serialized(maximum).length > 24000);
  assert.deepEqual(parseContactDraft(serialized(maximum)), maximum);
  for (const raw of [null, undefined, {}, '', '{broken', '[]', 'null', ' '.repeat(30000), JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, version: 1, extra: true }), serialized({ ...valid, message: 'x'.repeat(4001) }), serialized({ ...valid, email: 7 }), serialized({ ...valid, topic: '' })]) assert.equal(parseContactDraft(raw), null);
  assert.equal(formatContactMessage(valid), 'AssayNova / Contact enquiry\n\nName: QA Person\nEmail: qa@example.invalid\nTopic: Website issue\n\nMessage:\nA synthetic website question.');
});

test('module import has no DOM/storage/network I/O and static markup cannot submit private named values before boot', async () => {
  const source = await readFile(new URL('../dist/contact.js', import.meta.url), 'utf8');
  let calls = 0;
  const context = { fetch() { calls++; throw new Error('No network'); } };
  for (const key of ['document', 'localStorage', 'navigator']) Object.defineProperty(context, key, { get() { calls++; throw new Error('No import I/O'); } });
  runInNewContext(source.replace(/^export /gm, ''), context);
  assert.equal(calls, 0);
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const form = html.match(/<form id="contact-form"[\s\S]*?<\/form>/)[0];
  for (const control of form.match(/<(?:input|select|textarea)\b[^>]*>/g)) assert.ok(!/\bname\s*=/.test(control), control);
  assert.match(form.match(/<button[^>]*type="submit"[^>]*>/)[0], /\bdisabled(?:\s|>)/);
  assert.ok(!/onsubmit\s*=/.test(form));
  assert.equal((html.match(/src="\/contact-form\.js"/g) || []).length, 0);
});


test('one shared controller binds once and both inquiry kinds submit durable account requests without touching legacy storage',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');let storageCalls=0;Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){storageCalls++;throw Error('No legacy storage access');}});
 try{for(const kind of ['contact','report-recovery']){const calls=[];const h=fixture({kind,save:async(record,options)=>{calls.push({record,options});return documentFor(record);}});h.fill();assert.equal(createContactForm(h.form,h.config),h.controller);for(const list of h.events.values())assert.equal(list.length,1);await h.send();assert.equal(calls.length,1);assert.equal(calls[0].record.version,3);assert.equal(calls[0].record.kind,kind);assert.equal(calls[0].options.ownerId,user.id);assert.match(h.status(),/^Request submitted/);assert.equal(h.view.hidden,false);assert.equal(storageCalls,0);}}
 finally{if(original)Object.defineProperty(globalThis,'localStorage',original);else delete globalThis.localStorage;}
});

test('contact and recovery gate guest and unavailable capability without losing validation bounds',async()=>{
 for(const kind of ['contact','report-recovery'])for(const options of [{signedIn:false},{enabled:false}]){let calls=0;const h=fixture({kind,...options,save:async()=>{calls++;}});h.fill();await h.send();assert.equal(calls,0);assert.equal(h.submit.disabled,true);assert.match(h.gate.textContent,options.enabled===false?/unavailable/:/Sign in/);}
 const h=fixture();h.fill({...valid,message:'x'.repeat(4001)});await h.send();assert.equal(h.status(),'');assert.match(h.nodes.get('#contact-error-message').textContent,/4000/);
});

test('both inquiry flows block double clicks, replay lost acknowledgement and update latest edits with one identity',async()=>{
 for(const kind of ['contact','report-recovery']){const calls=[];let remote;const h=fixture({kind,save:async(record,options)=>{calls.push({record:structuredClone(record),options});if(!remote){remote=documentFor(record);throw Object.assign(Error('lost ack'),{code:'network'});}if(!options.id)return remote;remote=documentFor(record,2);return remote;}});h.fill();await h.send();assert.equal(h.status(),'');await h.input(kind==='contact'?'message':'notes','Latest edited context');await h.send();assert.equal(calls.length,3);assert.deepEqual(calls[0].record,calls[1].record);assert.equal(calls[0].options.idempotencyKey,calls[1].options.idempotencyKey);assert.equal(calls[2].options.expectedRevision,1);assert.equal(remote.record.details[kind==='contact'?'message':'notes'],'Latest edited context');assert.match(h.status(),/Request submitted/);}
 let resolve,calls=0;const h=fixture({save:record=>{calls++;return new Promise(r=>resolve=()=>r(documentFor(record)));}});h.fill();const pending=h.send();await h.send();assert.equal(calls,1);resolve();await pending;
});

test('late inquiry acknowledgements are ignored after suspend, close, logout and owner replacement; profile never overwrites edits',async()=>{
 for(const action of ['suspend','destroy','logout','other']){let resolve;const h=fixture({save:record=>new Promise(r=>resolve=()=>r(documentFor(record)))});h.fill();const pending=h.send();if(action==='suspend'||action==='destroy')h.controller[action]();else h.controller.setAccountSession(action==='logout'?null:{...user,id:'user-b'},action==='logout'?'logout':'login');resolve();await pending;assert.equal(h.status(),'');assert.equal(h.view.hidden,true);if(action==='logout'||action==='other')assert.equal(h.values().message,'');}
 const h=fixture();await h.input('name','User edited');h.controller.setAccountSession({...user,name:'Updated profile'},'profile');assert.equal(h.values().name,'User edited');
});

test('invalid inquiry acknowledgement cannot claim success and raw HTML remains field text',async()=>{
 const h=fixture({save:async record=>documentFor({...record,id:'AN-REQ-ALTERED'})});h.fill({...valid,message:'<img onerror=alert(1)>'});await h.send();assert.equal(h.status(),'');assert.match(h.error(),/could not confirm/);assert.equal(h.values().message,'<img onerror=alert(1)>');
});

test('inquiry session refresh gates private fields until the current owner is confirmed',()=>{
 const h=fixture();h.fill();h.controller.activate({checking:true});assert.equal(h.submit.disabled,true);assert.match(h.gate.textContent,/Checking your account/);h.controller.setAccountSession({...user,id:'user-b',email:'b@example.invalid'});assert.equal(h.values().message,'');assert.equal(h.values().email,'b@example.invalid');assert.equal(h.submit.disabled,false);
});

test('bound Contact and Recovery fields stay hidden on expiry while same-owner retry preserves its exact intent',async()=>{
 for(const kind of ['contact','report-recovery']){
  const writes=[];let remote;
  const h=fixture({kind,save:async(record,options)=>{writes.push({record:structuredClone(record),key:options.idempotencyKey});if(!remote){remote=documentFor(record);throw Object.assign(Error('Synthetic lost acknowledgement'),{code:'network'});}return remote;}});
  h.fill();const before=h.values();await h.send();assert.equal(writes.length,1);
  h.controller.setAccountSession(null,'expired');assert.equal(h.panel.hidden,true);assert.equal(h.submit.disabled,true);assert.deepEqual(h.values(),before);for(const key of Object.keys(before))assert.equal(h.nodes.get('#'+(kind==='contact'?'contact':'support')+'-'+key).disabled,true);
  assert.equal(h.nodes.get('[data-inquiry-action="sign-in"]').hidden,false);
  h.controller.setAccountSession(user,'login');assert.equal(h.panel.hidden,false);assert.equal(h.submit.disabled,false);assert.deepEqual(h.values(),before);await h.send();assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.match(h.status(),/Request submitted/);
  h.controller.setAccountSession({...user,id:'user-b',email:'b@example.invalid'},'login');assert.equal(h.panel.hidden,false);assert.equal(h.values()[kind==='contact'?'message':'notes'],'');assert.equal(h.values().email,'b@example.invalid');
  h.fill();h.controller.setAccountSession(null,'logout');assert.equal(h.panel.hidden,false);assert.ok(Object.values(h.values()).every(value=>value===''));assert.equal(h.status(),'');
 }
 const guest=fixture({signedIn:false});assert.equal(guest.panel.hidden,false);guest.fill();assert.equal(guest.values().message,valid.message);assert.equal(guest.nodes.get('#contact-message').disabled,false);
});

test('public contact links use the selected supports mailbox without changing report-master contact',async()=>{const {readFile}=await import('node:fs/promises');const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');assert.equal((html.match(/href="mailto:supports@assaynovalabs.com"/g)||[]).length,2);assert.doesNotMatch(html,/mailto:(?:hello|reports)@assaynova\.com/);const master=await readFile(new URL('../templates/coa/lab-contact.json',import.meta.url),'utf8');assert.match(master,/reports@assaynovalabs.com/);});
