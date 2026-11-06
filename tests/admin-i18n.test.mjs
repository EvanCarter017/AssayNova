import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LOCALE_KEY, DICTIONARIES, resolveLocale, translate, translateError, createAdminI18n } from '../conference/admin-i18n.mjs';
import { filterProducts } from '../conference/product-search.mjs';
import { catalogDTO, parseProduct } from '../conference/catalog.mjs';
import { createStudio } from '../conference/studio.mjs';
import { createImportUI } from '../conference/import-ui.mjs';

const operatorHTML = await readFile(new URL('../conference/operator.html', import.meta.url), 'utf8');
const loginHTML = await readFile(new URL('../conference/login.html', import.meta.url), 'utf8');
const operatorJS = await readFile(new URL('../conference/operator.js', import.meta.url), 'utf8');
const loginJS = await readFile(new URL('../conference/login.js', import.meta.url), 'utf8');
const moduleJS = await readFile(new URL('../conference/admin-i18n.mjs', import.meta.url), 'utf8');
const importJS = await readFile(new URL('../conference/import-ui.mjs', import.meta.url), 'utf8');
const project = fileURLToPath(new URL('../', import.meta.url));

test('dictionaries cover all declared UI bindings and import without browser/storage/network side effects', () => {
  assert.deepEqual(Object.keys(DICTIONARIES.en).sort(), Object.keys(DICTIONARIES['zh-CN']).sort());
  for (const dictionary of Object.values(DICTIONARIES)) for (const value of Object.values(dictionary)) assert.ok(typeof value === 'string' && value.length > 0);
  for (const html of [operatorHTML, loginHTML]) for (const [, key] of html.matchAll(/data-i18n(?:-placeholder|-aria-label|-alt)?="([^"]+)"/g)) assert.ok(Object.hasOwn(DICTIONARIES.en, key), key);
  for (const source of [operatorJS, loginJS, importJS]) for (const [, key] of source.matchAll(/(?:\bt|language\.t|\bstatus)\('([a-zA-Z]+)'/g)) assert.ok(Object.hasOwn(DICTIONARIES.en, key), key);
  for (const key of ['setupTitle','setupIntro','loginTitle','loginIntro','unavailableTitle','unavailableIntro','unlock','unavailable','loading','noMatches','selectedReady','chooseBelow','publishing','previewing','publishedReady','previewReady','authFallback','generateFallback','historyFallback','logoutFallback','sessionFallback']) assert.ok(DICTIONARIES['zh-CN'][key]);
  const context = {};
  for (const key of ['localStorage','sessionStorage','document','navigator','fetch']) Object.defineProperty(context, key, { get() { throw new Error('Import touched ' + key); } });
  runInNewContext(moduleJS.replace(/\bexport\s+/g, ''), context);
  assert.equal(translate('zh-CN','reports'), '报告管理'); assert.equal(translate('en','openHistory',{name:'KLOW 80mg',code:'AN-TEST-0001'}),'Open KLOW 80mg, Lookup Code AN-TEST-0001');
});

test('locale defaults, persistence and blocked storage use only an explicit allowlisted locale value', () => {
  assert.equal(resolveLocale(undefined,'zh-Hans-CN'),'zh-CN'); assert.equal(resolveLocale('en','zh-CN'),'en'); assert.equal(resolveLocale('zh-CN','en-US'),'zh-CN'); assert.equal(resolveLocale('bad','en-US'),'en');
  const calls=[], storage={getItem(key){calls.push(['get',key]);return 'invalid';},setItem(key,value){calls.push(['set',key,value]);}};
  const controller=createAdminI18n({storage,browserLanguage:'zh-TW'}); assert.equal(controller.locale,'zh-CN'); assert.equal(calls.length,1);
  assert.equal(controller.setLocale('password-or-form-value'),false); controller.setLocale('en'); controller.setLocale('zh-CN');
  assert.deepEqual(calls,[['get',LOCALE_KEY],['set',LOCALE_KEY,'en'],['set',LOCALE_KEY,'zh-CN']]);
  const blocked=createAdminI18n({storage:()=>{throw new Error('blocked getter');},browserLanguage:'en'}); blocked.setLocale('zh-CN'); assert.equal(blocked.t('reports'),'报告管理');
  const denied=createAdminI18n({storage:{getItem(){throw new Error('read');},setItem(){throw new Error('write');}}}); denied.setLocale('zh-CN'); assert.equal(denied.locale,'zh-CN');
});

test('known backend errors translate, field validation stays specific, and unknown errors never expose paths/stacks', () => {
  for (const message of ['Administrator password was not accepted.','Too many attempts. Try again later.','Another sign-in attempt is being processed. Try again shortly.','Use a password with 10 to 128 characters (at most 512 UTF-8 bytes).','The administrator password is already configured.','Set the administrator password first.','Administrator credential storage is unavailable.','Sign-in request rejected.','Use a valid ISO date.','Reported date must be on or after received date.','Purity must be 99.05-99.95 with at most two decimal places.','Another report is being generated. Wait for it to finish.','Report renderer timed out.','Report renderer failed; no report was published.','Could not allocate a unique Lookup Code.']) {
    assert.match(translateError('zh-CN',message),/[\u3400-\u9fff]/); assert.notEqual(translateError('en',message),'');
  }
  assert.match(translateError('zh-CN','client must be short printable ASCII text.'),/客户.*ASCII/); assert.match(translateError('zh-CN','lot must be short printable ASCII text.'),/批次.*ASCII/);
  const raw='Error: C:\\private\\password-file at stack:27'; assert.equal(translateError('zh-CN',raw,'generateFallback'),DICTIONARIES['zh-CN'].generateFallback); assert.equal(translateError('en',raw,'generateFallback'),DICTIONARIES.en.generateFallback);
});

function documentFixture(html) {
  const all=[], ids=new Map(); let document;
  const decode=value=>value.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
  function make(tag,attributes,parent,text='') {
    const attrs=new Map(attributes);let inputValue=attrs.get('value')||'';
    const node={tagName:tag.toUpperCase(),parent,children:[],attributes:attrs,dataset:{},events:new Map(),isConnected:true,hidden:attrs.has('hidden'),disabled:attrs.has('disabled'),text:decode(text),html:'',focusCalls:0,
      get value(){return inputValue;},set value(value){inputValue=this.tagName==='SELECT'&&!this.options.some(option=>option.getAttribute('value')===value)?'':value;},
      getAttribute(key){return attrs.get(key)??null;},setAttribute(key,value){attrs.set(key,String(value));},get content(){return attrs.get('content')??'';},addEventListener(type,callback){this.events.set(type,callback);},focus(){document.activeElement=this;this.focusCalls++;},select(){},classList:{toggle(){}},
      get textContent(){return this.text;},set textContent(value){for(const child of this.children)disconnect(child);this.children=[];this.text=String(value);},
      get innerHTML(){return this.html;},set innerHTML(value){for(const child of this.children)disconnect(child);this.children=[];this.html=String(value);parse(this.html,this);},
      get options(){return this.children.filter(child=>child.tagName==='OPTION'&&child.isConnected);},
      get elements(){return {namedItem:name=>all.find(item=>item.isConnected&&item.getAttribute('name')===name&&within(item,this))};},
      querySelectorAll(selector){return all.filter(item=>item.isConnected&&within(item,this)&&matches(item,selector));}
    };
    for(const [key,value] of attrs) if(key.startsWith('data-'))node.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
    if(attrs.has('id')){node.id=attrs.get('id');ids.set(node.id,node);} if(parent)parent.children.push(node);all.push(node);return node;
  }
  function disconnect(node){node.isConnected=false;for(const child of node.children)disconnect(child);}
  function within(node,parent){for(let current=node.parent;current;current=current.parent)if(current===parent)return true;return false;}
  function matches(node,selector){
    if(selector.includes(','))return selector.split(',').some(item=>matches(node,item.trim()));
    const descendant=/^main (input|select|button)$/.exec(selector);if(descendant)return node.tagName===descendant[1].toUpperCase()&&all.some(parent=>parent.tagName==='MAIN'&&within(node,parent));
    if(selector==='#generate button')return node.tagName==='BUTTON'&&within(node,ids.get('generate'));
    const attr=/^\[([^\]]+)\]$/.exec(selector);return !!attr&&node.attributes.has(attr[1]);
  }
  function parse(source,parent){
    const stack=[parent];for(const match of source.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)){
      const tag=match[1].toLowerCase();if(match[0].startsWith('</')){if(stack.length>1)stack.pop();continue;}
      const attrs=[...match[2].matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g)].map(([,key,value])=>[key,decode(value||'')]);
      const node=make(tag,attrs,stack.at(-1),source.slice(match.index+match[0].length).split('<')[0]);
      if(!['meta','link','input','img','br','hr'].includes(tag))stack.push(node);
    }
  }
  parse(html,null);
  document={title:'',activeElement:null,documentElement:all.find(node=>node.tagName==='HTML'),getElementById:id=>ids.get(id),querySelectorAll:selector=>all.filter(node=>node.isConnected&&matches(node,selector)),querySelector(selector){if(selector==='.brand span')return all.find(node=>node.tagName==='SPAN'&&node.text==='ADMIN');const meta=/^meta\[name="([^"]+)"\]$/.exec(selector);return meta?all.find(node=>node.tagName==='META'&&node.getAttribute('name')===meta[1]):null;}};
  const brand=all.find(node=>node.tagName==='SPAN'&&node.text==='ADMIN');const query=document.querySelector;document.querySelector=selector=>selector==='.brand span'?brand:query.call(document,selector);
  return {document,node:id=>ids.get(id)};
}
function storageFixture(saved) {const writes=[],values=new Map(saved?[[LOCALE_KEY,saved]]:[]);return {writes,values,getItem:key=>values.get(key)??null,setItem(key,value){writes.push([key,value]);values.set(key,value);}};}
async function boot(source,html,{storage=storageFixture(),fetch,language='en',extra=''}={}) {
  const dom=documentFixture(html),navigation=[],window={addEventListener(){}},location={replace:value=>navigation.push(value),reload:()=>navigation.push('reload')};
  const context={document:dom.document,window,location,localStorage:storage,navigator:{language,clipboard:{writeText:async()=>{}}},fetch,createAdminI18n,createImportUI,filterProducts};
  await runInNewContext('(async()=>{'+source.replace(/^import .*;\s*$/gm,'')+'\n'+extra+'})()',context);
  return {...dom,context,storage,navigation};
}

test('actual Reports locale switch preserves values, selection, snapshot, manual copy, focus and in-flight work', async () => {
  const product={...catalogDTO({id:'klow',name:'KLOW 80mg',...parseProduct('KLOW 80mg')}),imageURL:'/admin/images/klow'};
  const calls=[];let finish;
  const app=await boot(operatorJS,operatorHTML,{fetch:async(url,options)=>{calls.push([url,options]);if(url.endsWith('/session'))return {status:200,ok:true,json:async()=>({products:[product],customers:[{id:'fixture',name:'Saved Customer',directory:'/srv/products'}],defaultCustomerId:'fixture',token:'synthetic',publicOrigin:'http://customer.invalid'})};if(url.endsWith('/history'))return {status:200,ok:true,json:async()=>[]};return new Promise(resolve=>finish=resolve);},extra:'globalThis.ui={language,filter,showResult,statusError};'});
  assert.equal(app.node('customer-config'),undefined);assert.equal(app.node('customer-form'),undefined);assert.equal(app.node('customer-directory'),undefined);assert.equal(app.node('catalog-import').getAttribute('open'),null);assert.equal(app.node('import-folder').getAttribute('type'),'file');assert.notEqual(app.node('import-folder').getAttribute('webkitdirectory'),null);assert.equal(app.node('import-sheet').getAttribute('type'),'file');
  const {ui}=app.context; app.node('generate').elements.namedItem('lot').value='QA-084-LOT';app.node('search').value='KLOW80';ui.filter();
  ui.showResult({published:false,label:'KLOW 80mg',report:{lookupCode:'AN-TEST-0001'},previewURL:'/admin/bundles/previews/AN-TEST-0001/report.svg',pdfURL:'/admin/bundles/previews/AN-TEST-0001/report.pdf',publicURL:'http://customer.invalid/coa/AN-TEST-0001'});
  app.node('manual-copy').value='AN-TEST-0001';app.node('manual-label').hidden=false;const field=app.node('generate').elements.namedItem('lot');field.focus();const focusCount=field.focusCalls,before=calls.length;
  ui.language.setLocale('zh-CN');assert.equal(calls.length,before);assert.equal(app.document.documentElement.lang,'zh-CN');assert.match(app.document.title,/报告管理/);assert.equal(app.node('search').getAttribute('placeholder'),DICTIONARIES['zh-CN'].searchPlaceholder);assert.equal(app.node('paper').getAttribute('alt'),'报告预览');
  assert.equal(field.value,'QA-084-LOT');assert.equal(field.isConnected,true);assert.equal(app.node('search').value,'KLOW80');assert.equal(app.node('product').value,'klow');assert.equal(app.node('code').textContent,'AN-TEST-0001');assert.match(app.node('paper').src,/AN-TEST-0001/);assert.equal(app.node('manual-copy').value,'AN-TEST-0001');assert.equal(app.node('manual-label').hidden,false);assert.equal(app.document.activeElement,field);assert.equal(field.focusCalls,focusCount);assert.deepEqual(app.navigation,[]);
  const submit=app.node('generate').events.get('submit')({preventDefault(){},submitter:{value:'preview'}});assert.equal(field.disabled,true);assert.match(app.node('status').textContent,/正在/);const pendingCalls=calls.length;
  const payload=JSON.parse(calls.find(([url])=>url.endsWith('/generate'))[1].body);assert.deepEqual(Object.keys(payload).sort(),['customerId','fields','productId','publish']);assert.equal(payload.customerId,'fixture');assert.equal(Object.hasOwn(payload.fields,'client'),false);assert.equal(payload.productId,'klow');assert.equal(payload.fields.lot,'QA-084-LOT');
  ui.language.setLocale('en');assert.equal(calls.length,pendingCalls);assert.equal(field.disabled,true);assert.equal(app.node('status').textContent,DICTIONARIES.en.previewing);
  finish({status:400,ok:false,json:async()=>({error:'Use a valid ISO date.'})});await submit;assert.match(app.node('status').textContent,/ISO date/);ui.language.setLocale('zh-CN');assert.match(app.node('status').textContent,/有效日期/);assert.equal(field.disabled,false);assert.equal(app.node('code').textContent,'AN-TEST-0001');
  assert.ok(app.storage.writes.every(([key,value])=>key===LOCALE_KEY&&['en','zh-CN'].includes(value)));
});

test('actual customer handlers preserve reload selection, stale/failure guards, upload fields and snapshots through generation', async () => {
  const product=name=>catalogDTO({id:name,...parseProduct(name),name});
  const bpc=product('BPC-157 10mg'),sema=product('Semaglutide 5mg'),kpv=product('KPV 10mg');
  const a={id:'a',name:'Aster',directory:'/srv/a'},b={id:'b',name:'Cedar',directory:'/srv/b'};
  let customers=[a,b],catalogRequests=[],mutationRequests=[],calls=[];
  const ok=value=>({status:200,ok:true,json:async()=>value});
  const app=await boot(operatorJS,operatorHTML,{fetch:async(url,options)=>{
    calls.push([url,options]);if(url.endsWith('/session'))return ok({customers,defaultCustomerId:a.id,products:[bpc,sema],token:'fixture',publicOrigin:'http://customer.invalid'});
    if(url.endsWith('/history'))return ok([]);
    return new Promise(resolve=>(url.includes('/catalog?')?catalogRequests:mutationRequests).push({url,options,resolve}));
  },extra:'globalThis.ui={language,loadCustomer,filter,selectProduct,showResult,selected:()=>selected};'});
  const {ui}=app.context;
  app.node('product').value=bpc.id;ui.selectProduct();
  ui.showResult({published:false,label:'Old report',report:{lookupCode:'AN-OLD0-0001'},previewURL:'/admin/bundles/previews/AN-OLD0-0001/report.svg',pdfURL:'/admin/bundles/previews/AN-OLD0-0001/report.pdf'});
  const reload=app.node('reload-products').events.get('click')();assert.equal(app.node('product').value,'');assert.equal(app.node('customer').disabled,false);
  catalogRequests.shift().resolve(ok({customer:a,products:[bpc,sema]}));await reload;assert.equal(app.node('product').value,bpc.id,'native select must regain a still-valid option after rebuilding');
  const oldB=ui.loadCustomer(b.id),newA=ui.loadCustomer(a.id);assert.equal(app.node('customer').value,a.id);
  const first=catalogRequests.shift(),second=catalogRequests.shift();second.resolve(ok({customer:a,products:[sema]}));await newA;
  first.resolve(ok({customer:b,products:[kpv]}));await oldB;assert.equal(app.node('customer').value,a.id);assert.equal(ui.selected().id,sema.id);
  const staleFailure=ui.loadCustomer(b.id),latest=ui.loadCustomer(a.id),oldFailure=catalogRequests.shift(),latestRequest=catalogRequests.shift();
  latestRequest.resolve(ok({customer:a,products:[sema]}));await latest;const latestStatus=app.node('status').textContent;
  oldFailure.resolve({status:400,ok:false,json:async()=>({error:'Customer directory could not be read. Check the saved server directory and reload products.'})});await staleFailure;assert.equal(app.node('status').textContent,latestStatus);
  const failed=ui.loadCustomer(b.id);assert.equal(app.node('customer').value,b.id);
  catalogRequests.shift().resolve({status:400,ok:false,json:async()=>({error:'Customer directory could not be read. Check the saved server directory and reload products.'})});await failed;
  assert.equal(ui.selected(),undefined);assert.equal(app.node('import-target').disabled,false);assert.equal(app.node('import-folder').disabled,false);assert.equal(app.node('import-sheet').disabled,false);assert.equal(app.node('code').textContent,'AN-OLD0-0001');assert.match(app.node('status').textContent,/Upload/);
  app.node('import-name').value='Future customer';app.node('import-name').focus();
  const focus=app.document.activeElement,io=calls.length;ui.language.setLocale('zh-CN');assert.equal(calls.length,io);assert.equal(app.document.activeElement,focus);assert.equal(app.node('import-name').value,'Future customer');
  const recover=app.node('reload-products').events.get('click')();assert.equal(app.node('generate').elements.namedItem('lot').disabled,true);
  const inFlightCalls=calls.length;ui.language.setLocale('en');assert.equal(calls.length,inFlightCalls);assert.equal(app.node('generate').elements.namedItem('lot').disabled,true);assert.equal(app.document.activeElement,focus);
  catalogRequests.shift().resolve(ok({customer:b,products:[kpv]}));await recover;
  assert.equal(app.node('customer').value,b.id);assert.equal(ui.selected().id,kpv.id);assert.equal(app.node('code').textContent,'AN-OLD0-0001');assert.equal(app.node('import-name').value,'Future customer');
  const generate=app.node('generate').events.get('submit')({preventDefault(){},submitter:{value:'preview'}}),generation=mutationRequests.shift(),payload=JSON.parse(generation.options.body);
  assert.equal(payload.customerId,b.id);assert.equal(payload.productId,kpv.id);assert.equal(Object.hasOwn(payload.fields,'client'),false);assert.equal(app.node('customer').disabled,true);
  generation.resolve({status:400,ok:false,json:async()=>({error:'Use a valid ISO date.'})});await generate;assert.equal(app.node('code').textContent,'AN-OLD0-0001');assert.equal(app.node('customer').disabled,false);
  app.node('search').value='SM2';ui.filter();assert.equal(ui.selected(),undefined);assert.equal(app.node('paper').src,'/admin/bundles/previews/AN-OLD0-0001/report.svg');
});

test('actual login stays English with Chinese saved/browser locales and no locale reads or writes', async () => {
  assert.doesNotMatch(loginHTML, /<select\b|id="admin-language"/);
  const storage=storageFixture('zh-CN');let reads=0;const getItem=storage.getItem;storage.getItem=key=>{reads++;return getItem(key);};let finish;const calls=[];
  const html=loginHTML.replaceAll('{{MODE}}','login').replaceAll('{{CSRF}}','synthetic').replaceAll('{{DISABLED}}','');
  const app=await boot(loginJS,html,{storage,language:'zh-CN',fetch:async(...args)=>{calls.push(args);return new Promise(resolve=>finish=resolve);},extra:'globalThis.ui={showFeedback};'});
  const input=app.node('admin-password');input.value='Synthetic password fixture';input.focus();const count=input.focusCalls;
  app.context.ui.showFeedback({key:'unlocking'});assert.equal(input.value,'Synthetic password fixture');assert.equal(input.focusCalls,count);assert.equal(app.document.activeElement,input);assert.equal(calls.length,0);assert.equal(app.node('unlock').textContent,'Unlock admin');assert.equal(app.document.documentElement.lang,'en');assert.equal(reads,0);
  const pending=app.node('admin-login-form').events.get('submit')({preventDefault(){}});assert.equal(input.disabled,true);assert.equal(calls.length,1);assert.equal(app.node('login-status').textContent,DICTIONARIES.en.unlocking);assert.equal(calls[0][0],'/admin/auth/login');assert.equal(calls[0][1].headers['X-Admin-CSRF'],'synthetic');
  finish({ok:false,json:async()=>({error:'Administrator password was not accepted.'})});await pending;assert.equal(app.node('login-status').textContent,DICTIONARIES.en.passwordRejected);assert.equal(input.value,'');assert.equal(input.disabled,false);assert.deepEqual(storage.writes,[]);
  // Even a fresh page ignores the persisted Chinese Reports preference.
  const fresh=await boot(loginJS,html,{storage,language:'zh-CN',fetch:async()=>({ok:true,json:async()=>({ok:true})})});assert.equal(fresh.document.documentElement.lang,'en');assert.equal(fresh.node('unlock').textContent,'Unlock admin');
  fresh.node('admin-password').value='Synthetic password fixture';await fresh.node('admin-login-form').events.get('submit')({preventDefault(){}});assert.deepEqual(fresh.navigation,['/admin']);assert.deepEqual(storage.writes,[]);assert.equal(reads,0);
});

test('only the exact static locale module is public before login; default/production/LAN namespaces remain closed', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'assaynova-i18n-'));t.after(()=>rm(root,{recursive:true,force:true}));const images=path.join(root,'images');await mkdir(images);await writeFile(path.join(images,'BPC-157 10mg.png'),await readFile(new URL('../templates/coa/assets/sample-vial-product.png',import.meta.url)));
  const studio=await createStudio({images,store:path.join(root,'reports'),authStore:path.join(root,'auth'),port:0});t.after(()=>{studio.server.closeAllConnections();return new Promise(resolve=>studio.server.close(resolve));});
  for(const method of ['GET','HEAD']){const response=await fetch(studio.origin+'/admin/admin-i18n.mjs',{method});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.equal(response.headers.get('cache-control'),'no-store');}
  assert.equal((await fetch(studio.origin+'/admin/admin-i18n.mjs',{method:'POST'})).status,401);assert.equal((await fetch(studio.origin+'/admin/operator.js')).status,401);assert.equal((await fetch(studio.origin+'/admin/api/session')).status,401);assert.equal((await fetch(studio.origin+'/admin/product-aliases.json')).status,401);
  for(const mode of ['default','production','lan']){
    const socket=createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
    const child=spawn(process.execPath,['server.mjs','--port='+port,...(mode==='lan'?['--host=0.0.0.0','--conference-reports','--conference-store='+path.join(root,'readonly')]:[])],{cwd:project,env:{...process.env,NODE_ENV:mode==='production'?'production':'test'},windowsHide:true,stdio:'ignore'});
    let stopped;const stop=()=>stopped??=child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>{child.once('exit',resolve);child.kill();});t.after(stop);
    const origin='http://127.0.0.1:'+port;let ready=false;for(let attempt=0;attempt<100;attempt++){try{if((await fetch(origin+'/')).ok){ready=true;break;}}catch{}await delay(25);}assert.equal(ready,true);
    for(const method of ['GET','HEAD','POST'])assert.equal((await fetch(origin+'/admin/admin-i18n.mjs',{method})).status,404);await stop();
  }
});
