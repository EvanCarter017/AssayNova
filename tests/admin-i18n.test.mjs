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
import { createCatalogCorrectionUI, catalogPickerState, catalogIssueText } from '../conference/catalog-correction-ui.mjs';
import { createReportRemovalUI } from '../conference/report-removal-ui.mjs';

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
      getAttribute(key){return attrs.get(key)??null;},setAttribute(key,value){attrs.set(key,String(value));},removeAttribute(key){attrs.delete(key);},get content(){return attrs.get('content')??'';},addEventListener(type,callback){this.events.set(type,callback);},focus(){document.activeElement=this;this.focusCalls++;},select(){},showModal(){this.open=true;},close(){this.open=false;},reset(){},reportValidity(){return true;},classList:{toggle(){}},
      get textContent(){return this.text;},set textContent(value){for(const child of this.children)disconnect(child);this.children=[];this.text=String(value);},
      get innerHTML(){return this.html;},set innerHTML(value){for(const child of this.children)disconnect(child);this.children=[];this.html=String(value);parse(this.html,this);},
      get options(){return this.children.filter(child=>child.tagName==='OPTION'&&child.isConnected);},
      get selectedOptions(){return this.options.filter(option=>option.value===this.value);},
      get elements(){return {namedItem:name=>all.find(item=>item.isConnected&&item.getAttribute('name')===name&&within(item,this))};},
      querySelectorAll(selector){return all.filter(item=>item.isConnected&&within(item,this)&&matches(item,selector));}
    };
    for(const [key,value] of attrs) if(key.startsWith('data-'))node.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
    if(attrs.has('id')){node.id=attrs.get('id');ids.set(node.id,node);} if(parent)parent.children.push(node);all.push(node);return node;
  }
  function disconnect(node){node.isConnected=false;for(const child of node.children)disconnect(child);}
  function within(node,parent){for(let current=node.parent;current;current=current.parent)if(current===parent)return true;return false;}
  function matches(node,selector){
    if (/^[a-z]+$/.test(selector)) return node.tagName === selector.toUpperCase();
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
function fakeClock(){
  let now=Date.now(),id=0;const timers=new Map();
  return {Date:class extends Date{static now(){return now;}},setTimeout(callback,ms){const key=++id;timers.set(key,{callback,at:now+ms});return key;},clearTimeout:key=>timers.delete(key),size:()=>timers.size,async tick(ms){const end=now+ms;for(;;){await flush();const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].callback();}now=end;await flush();}};
}
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
async function boot(source,html,{storage=storageFixture(),fetch,language='en',extra='',reportTimeout,clock=fakeClock()}={}) {
  const dom=documentFixture(html),navigation=[],window={events:new Map(),addEventListener(name,callback){this.events.set(name,callback);}},location={replace:value=>navigation.push(value),reload:()=>navigation.push('reload')};let random=0;
  const context={document:dom.document,window,location,localStorage:storage,navigator:{language,clipboard:{writeText:async()=>{}}},fetch,createAdminI18n,createImportUI,createCatalogCorrectionUI,createReportRemovalUI:options=>createReportRemovalUI({...options,...(reportTimeout?{timeout:reportTimeout}:{})}),catalogPickerState,catalogIssueText,filterProducts,AbortController,Date:clock.Date,crypto:{getRandomValues:array=>array.fill(++random)},setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout};
  await runInNewContext('(async()=>{'+source.replace(/^import .*;\s*$/gm,'')+'\n'+extra+'})()',context);
  return {...dom,context,storage,navigation,clock};
}

test('actual Reports locale switch preserves values, selection, snapshot, manual copy, focus and in-flight work', async () => {
  const product={...catalogDTO({id:'klow',name:'KLOW 80mg',...parseProduct('KLOW 80mg')}),imageURL:'/admin/images/klow'};
  const calls=[];let finish;
  const app=await boot(operatorJS,operatorHTML,{fetch:async(url,options)=>{calls.push([url,options]);if(url==='/admin/api/imports'&&options?.method==='GET')return {status:200,ok:true,json:async()=>({imports:[]})};if(url.endsWith('/session'))return {status:200,ok:true,json:async()=>({products:[product],customers:[{id:'fixture',name:'Saved Customer',directory:'/srv/products'}],defaultCustomerId:'fixture',token:'synthetic',publicOrigin:'http://customer.invalid'})};if(url.endsWith('/history'))return {status:200,ok:true,json:async()=>[]};return new Promise(resolve=>finish=resolve);},extra:'globalThis.ui={language,filter,showResult,statusError};'});
  assert.equal(app.node('customer-config'),undefined);assert.equal(app.node('customer-form'),undefined);assert.equal(app.node('customer-directory'),undefined);assert.equal(app.node('catalog-import').getAttribute('open'),null);assert.equal(app.node('import-folder').getAttribute('type'),'file');assert.notEqual(app.node('import-folder').getAttribute('webkitdirectory'),null);assert.equal(app.node('import-sheet').getAttribute('type'),'file');
  const {ui}=app.context; app.node('generate').elements.namedItem('lot').value='QA-084-LOT';app.node('search').value='KLOW80';ui.filter();
  ui.showResult({published:false,label:'KLOW 80mg',report:{lookupCode:'AN-TEST-0001'},previewURL:'/admin/bundles/previews/AN-TEST-0001/report.svg',pdfURL:'/admin/bundles/previews/AN-TEST-0001/report.pdf',publicURL:'http://customer.invalid/coa/AN-TEST-0001'});
  app.node('manual-copy').value='AN-TEST-0001';app.node('manual-label').hidden=false;const field=app.node('generate').elements.namedItem('lot');field.focus();const focusCount=field.focusCalls,before=calls.length;
  ui.language.setLocale('zh-CN');assert.equal(calls.length,before);assert.equal(app.document.documentElement.lang,'zh-CN');assert.match(app.document.title,/报告管理/);assert.equal(app.node('search').getAttribute('placeholder'),DICTIONARIES['zh-CN'].searchPlaceholder);assert.equal(app.node('paper').getAttribute('alt'),'报告预览');
  assert.equal(field.value,'QA-084-LOT');assert.equal(field.isConnected,true);assert.equal(app.node('search').value,'KLOW80');assert.equal(app.node('product').value,'klow');assert.equal(app.node('code').textContent,'AN-TEST-0001');assert.match(app.node('paper').src,/AN-TEST-0001/);assert.equal(app.node('manual-copy').value,'AN-TEST-0001');assert.equal(app.node('manual-label').hidden,false);assert.equal(app.document.activeElement,field);assert.equal(field.focusCalls,focusCount);assert.deepEqual(app.navigation,[]);
  const submit=app.node('publish').events.get('click')();await flush();assert.equal(field.disabled,true);assert.match(app.node('status').textContent,/正在/);const pendingCalls=calls.length;
  const payload=JSON.parse(calls.find(([url])=>url.endsWith('/generate'))[1].body);assert.deepEqual(Object.keys(payload).sort(),['customerId','fields','productId','publish']);assert.equal(payload.customerId,'fixture');assert.equal(Object.hasOwn(payload.fields,'client'),false);assert.equal(payload.productId,'klow');assert.equal(payload.fields.lot,'QA-084-LOT');
  ui.language.setLocale('en');assert.equal(calls.length,pendingCalls);assert.equal(field.disabled,true);assert.equal(app.node('status').textContent,DICTIONARIES.en.publishing);
  finish({status:400,ok:false,json:async()=>({error:'Use a valid ISO date.'})});await submit;assert.match(app.node('status').textContent,/ISO date/);ui.language.setLocale('zh-CN');assert.match(app.node('status').textContent,/有效日期/);assert.equal(field.disabled,false);assert.equal(app.node('code').textContent,'AN-TEST-0001');
  assert.ok(app.storage.writes.every(([key,value])=>key===LOCALE_KEY&&['en','zh-CN'].includes(value)));
});

test('actual v2 chooser keeps 22 problem entries in the dropdown and permits ready generation with the current revision', async () => {
  const revision = 'c'.repeat(32), ready = { ...catalogDTO({ id: 'adamax', name: 'Adamax 10mg', ...parseProduct('Adamax 10mg') }), sku: 'ADA10', status: 'ready', aliases: { skus: ['ADA10'], families: ['ADA'] } }, entryId = '1'.repeat(20), calls = [];
  const sameName = ['LC120', 'LC526', 'LC553'].map(sku => ({ ...ready, id: sku.toLowerCase(), name: 'L-Carnitine 120mg', sku, aliases: { skus: [sku], families: ['LC'] } }));
  const blocked = { id: entryId, raw: { sku: 'ADA10mg', product: 'Unreviewed', dose: '' }, values: { sku: 'ADA10mg', product: 'Unreviewed', dose: '' }, status: 'blocked', hold: false, issues: [{ code: 'MISSING_IMAGE' }] };
  const entries = [blocked, ...Array.from({length:21},(_,n)=>({...blocked,id:(n+2).toString(16).padStart(20,'0'),values:{sku:'MISSING'+n,product:'Unrelated product '+n,dose:''}}))];
  const ok = value => ({ status: 200, ok: true, json: async () => value });
  const app = await boot(operatorJS, operatorHTML, { fetch: async (url, options) => {
    calls.push([url, options]); if (url.endsWith('/session')) return ok({ products: [ready, ...sameName], entries, catalogRevision: revision, customers: [{ id: 'fixture', name: 'Customer' }], defaultCustomerId: 'fixture', token: 'synthetic', publicOrigin: 'http://customer.invalid' });
    if (url.endsWith('/history')) return ok([]); if (url === '/admin/api/imports') return ok({ imports: [] });
    return { status: 409, ok: false, json: async () => ({ error: 'Catalog changed. Reload products before saving corrections.' }) };
  }, extra: 'globalThis.ui={language,filter,selectProduct,selected:()=>selected};' });
  assert.equal(app.node('catalog-blocked'),undefined);assert.doesNotMatch(operatorJS,/renderBlocked|blockedPage|data-correct-entry|catalog-blocked-list/);
  assert.equal(app.node('catalog-manage').textContent,'Resolve issues (22)');
  const options=app.node('product').options;
  assert.equal(options.filter(option=>option.disabled&&option.getAttribute('class')==='is-blocked').length,22);
  assert.ok(options.filter(option=>option.getAttribute('class')==='is-blocked').every(option=>option.textContent.startsWith('Content missing · unavailable · ')));
  assert.equal(options.find(option=>option.value==='adamax').disabled,false);
  for (const sku of ['LC120', 'LC526', 'LC553']) assert.match(app.node('product').innerHTML, new RegExp(sku + ' · L-Carnitine 120mg'));
  for(const query of ['ADA10mg','ADA-10mg']){app.node('search').value=query;app.context.ui.filter();assert.equal(app.context.ui.selected(),undefined);assert.match(app.node('product').innerHTML,/option disabled class="is-blocked"/);assert.match(app.node('status').textContent,/Resolve issues/);assert.equal(app.node('catalog-manage').textContent,'Resolve issues (22)');}
  app.node('product').value = 'blocked-' + entryId; app.context.ui.selectProduct(); await app.node('generate').events.get('submit')({ preventDefault() {}, submitter: { value: 'preview' } }); assert.equal(calls.some(([url]) => url.endsWith('/generate')), false);
  app.node('search').value = ''; app.context.ui.filter();app.node('product').value='adamax';const readyOption=app.node('product').options.find(option=>option.value==='adamax');readyOption.disabled=true;app.context.ui.selectProduct();assert.equal(app.context.ui.selected(),undefined);readyOption.disabled=false;
  app.node('product').value='adamax';app.context.ui.selectProduct();app.node('product').focus();const focused=app.document.activeElement;
  app.context.ui.language.setLocale('zh-CN');assert.equal(app.node('product').value,'adamax');assert.equal(app.document.activeElement,focused);assert.equal(app.node('catalog-manage').textContent,'处理异常（22）');assert.ok(app.node('product').options.filter(option=>option.disabled&&option.getAttribute('class')==='is-blocked').every(option=>option.textContent.startsWith('内容缺失 · 无法选择 · ')));
  await app.node('publish').events.get('click')();
  const payload=JSON.parse(calls.find(([url])=>url.endsWith('/generate'))[1].body);assert.equal(payload.catalogRevision,revision);assert.equal(payload.customerId,'fixture');assert.equal(payload.productId,'adamax');
  const css=await readFile(new URL('../conference/operator.css',import.meta.url),'utf8');assert.match(css,/#product option\.is-blocked:disabled\{[^}]*color:#a32e25/);assert.doesNotMatch(css,/#catalog-blocked/);
});

test('actual operator routes brand corrections through the modal and refreshes ready options without losing a valid selection', async () => {
  const revision='a'.repeat(32), nextRevision='b'.repeat(32), ready={...catalogDTO({id:'ready',name:'Adamax 10mg',...parseProduct('Adamax 10mg')}),sku:'ADA10',status:'ready'}, entryId='2'.repeat(20), assetId='3'.repeat(32);
  const blocked={id:entryId,source:{sheet:'Products',row:2},raw:{sku:'FIX10',product:'Reviewed product',dose:'10mg'},values:{sku:'FIX10',product:'Reviewed product 10mg',dose:'10mg'},status:'blocked',hold:false,issues:[{code:'MISSING_IMAGE'}]}, leftover={...blocked,id:'4'.repeat(20),values:{...blocked.values,sku:'OTHER10'}};
  const customers=[{id:'brand-a',name:'Brand A & Labs'},{id:'brand-b',name:'Brand B'}], calls=[], ok=value=>({status:200,ok:true,json:async()=>value});
  const app=await boot(operatorJS,operatorHTML,{fetch:async(url,options)=>{
    calls.push([url,options]);if(url.endsWith('/session'))return ok({products:[ready],entries:[blocked,leftover],catalogRevision:revision,customers,defaultCustomerId:'brand-a',token:'synthetic',publicOrigin:'http://customer.invalid'});
    if(url.endsWith('/history'))return ok([]);if(url==='/admin/api/imports')return ok({imports:[]});
    if(url==='/admin/api/catalog?customerId=brand-b')return ok({customer:customers[1],products:[ready],entries:[],catalogRevision:nextRevision});
    if(url.endsWith('/entries/'+entryId)&&options.method==='GET')return ok({entry:blocked,catalogRevision:revision,images:[{id:assetId,filename:'FIX10.png',url:'/admin/catalog-assets/synthetic'}]});
    if(url.endsWith('/entries/'+entryId)&&options.method==='PATCH'){
      const body=JSON.parse(options.body);assert.equal(body.expectedRevision,revision);assert.deepEqual(body.image,{assetId});
      const corrected={...blocked,status:'ready',issues:[],image:{id:assetId}};
      return ok({entry:corrected,entries:[corrected,leftover],products:[ready,{...ready,id:entryId,sku:'FIX10',name:'Reviewed product 10mg'}],catalogRevision:nextRevision,customers});
    }
    throw new Error('Unexpected synthetic request: '+url);
  },extra:'globalThis.ui={language,correction,selectProduct,loadCustomer,selected:()=>selected};'});
  app.node('product').value='ready';app.context.ui.selectProduct();assert.equal(app.node('catalog-manage').textContent,'Resolve issues (2)');
  await app.node('catalog-manage').events.get('click')({currentTarget:app.node('catalog-manage')});
  assert.equal(app.node('catalog-dialog').open,true);assert.equal(app.node('catalog-filter').value,'blocked');assert.equal(app.node('catalog-dialog-title').textContent,'Resolve issues · Brand A & Labs');assert.match(app.node('catalog-dialog-intro').textContent,/Brand A & Labs: 2/);
  await app.context.ui.correction.select(entryId);app.node('catalog-image').value=assetId;app.node('catalog-image').events.get('change')();await app.context.ui.correction.save();
  assert.equal(app.context.ui.selected().id,'ready');assert.equal(app.node('product').value,'ready');assert.equal(app.node('product').options.find(option=>option.value===entryId).disabled,false);assert.equal(app.node('product').options.find(option=>option.value==='blocked-'+leftover.id).disabled,true);assert.equal(app.node('catalog-manage').textContent,'Resolve issues (1)');assert.match(app.node('catalog-dialog-intro').textContent,/Brand A & Labs: 1/);
  assert.ok(calls.some(([url,options])=>url==='/admin/api/catalog/brand-a/entries/'+entryId&&options.method==='PATCH'));
  await app.context.ui.loadCustomer('brand-b');assert.equal(app.node('catalog-dialog').open,false);assert.equal(app.node('catalog-manage').textContent,'Resolve issues (0)');
  await app.node('catalog-manage').events.get('click')({currentTarget:app.node('catalog-manage')});assert.match(app.node('catalog-dialog-title').textContent,/Brand B/);assert.match(app.node('catalog-dialog-intro').textContent,/no entries need correction/);assert.doesNotMatch(app.node('catalog-record-list').innerHTML,/data-entry-id=/);
  app.context.ui.language.setLocale('zh-CN');assert.equal(app.node('product').value,'ready');assert.match(app.node('catalog-dialog-title').textContent,/处理异常 · Brand B/);assert.match(app.node('catalog-record-list').innerHTML,/没有待处理异常/);
});

test('actual modal brand switch commits one isolated catalog and clears a shared product ID until the operator chooses again', async () => {
  const customers = [{ id: 'brand-a', name: 'Brand A' }, { id: 'brand-b', name: 'Brand B & Labs' }], calls = [], revisionA = 'a'.repeat(32), revisionB = 'b'.repeat(32);
  const productA = { ...catalogDTO({ id: 'shared', name: 'Adamax 10mg', ...parseProduct('Adamax 10mg') }), sku: 'ADA10', status: 'ready' }, productB = { ...productA, name: 'Brand B Adamax 10mg' };
  const entryA = { id: '1'.repeat(20), source: { sheet: 'A', row: 2 }, raw: { sku: 'SAME10', product: 'A missing', dose: '10mg' }, values: { sku: 'SAME10', product: 'A missing', dose: '10mg' }, status: 'blocked', hold: false, issues: [{ code: 'MISSING_IMAGE' }] }, entryB = { ...entryA, id: '2'.repeat(20), source: { sheet: 'B', row: 9 }, values: { ...entryA.values, product: 'B missing' } };
  const ok = value => ({ status: 200, ok: true, json: async () => value }); let failBrand = true;
  const app = await boot(operatorJS, operatorHTML, { fetch: async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('/session')) return ok({ customers, defaultCustomerId: 'brand-a', products: [productA], entries: [entryA], catalogRevision: revisionA, token: 'synthetic', publicOrigin: 'http://customer.invalid' });
    if (url.endsWith('/history')) return ok([]); if (url === '/admin/api/imports') return ok({ imports: [] });
    if (url === '/admin/api/catalog?customerId=brand-b') return failBrand ? { status: 503, ok: false, json: async () => ({ error: 'Catalog unavailable.' }) } : ok({ customer: customers[1], products: [productB], entries: [entryB], catalogRevision: revisionB });
    if (url.endsWith('/entries/' + entryA.id)) return ok({ entry: entryA, catalogRevision: revisionA, images: [{ id: '3'.repeat(32), filename: 'SAME10.png', url: '/admin/catalog-assets/brand-a/a' }] });
    if (url.endsWith('/entries/' + entryB.id)) return ok({ entry: entryB, catalogRevision: revisionB, images: [{ id: '4'.repeat(32), filename: 'SAME10.png', url: '/admin/catalog-assets/brand-b/b' }] });
    return { status: 400, ok: false, json: async () => ({ error: 'Use a valid ISO date.' }) };
  }, extra: 'globalThis.ui={language,correction,selectProduct,selected:()=>selected,current:()=>currentCustomerId,session:()=>session};' });
  app.node('product').value = 'shared'; app.context.ui.selectProduct(); app.node('search').value = 'ADA';
  await app.context.ui.correction.open(entryA.id);
  assert.equal(app.node('catalog-brand').options.length, 2); assert.equal(app.node('catalog-brand').value, 'brand-a');
  await app.context.ui.correction.switchBrand('brand-b');
  assert.equal(app.context.ui.current(), 'brand-a'); assert.equal(app.context.ui.selected().id, 'shared'); assert.equal(app.node('customer').value, 'brand-a'); assert.equal(app.node('product').value, 'shared'); assert.equal(app.node('search').value, 'ADA'); assert.equal(app.node('catalog-form').hidden, false);
  failBrand = false; await app.node('catalog-brand-retry').events.get('click')();
  assert.equal(app.node('catalog-dialog').open, true); assert.equal(app.context.ui.current(), 'brand-b'); assert.equal(app.node('customer').value, 'brand-b'); assert.equal(app.node('catalog-brand').value, 'brand-b'); assert.equal(app.node('search').value, ''); assert.equal(app.node('product').value, ''); assert.equal(app.context.ui.selected(), undefined); assert.equal(app.context.ui.session().catalogRevision, revisionB);
  assert.equal(app.node('product').options.find(option => option.value === '').disabled, true); assert.match(app.node('product').innerHTML, /Brand B Adamax/); assert.doesNotMatch(app.node('catalog-record-list').innerHTML, /A missing/); assert.match(app.node('catalog-record-list').innerHTML, /B missing/); assert.equal(app.node('catalog-manage').textContent, 'Resolve issues (1)');
  app.context.ui.language.setLocale('zh-CN'); assert.equal(app.node('product').value, ''); assert.equal(app.context.ui.selected(), undefined); assert.equal(app.node('catalog-brand').value, 'brand-b'); assert.equal(app.node('catalog-dialog').open, true);
  await app.node('generate').events.get('submit')({ preventDefault() {}, submitter: { value: 'preview' } }); assert.equal(calls.some(([url]) => url.endsWith('/generate')), false);
  await app.context.ui.correction.select(entryB.id); assert.match(app.node('catalog-image').innerHTML, /44444444444444444444444444444444/); assert.doesNotMatch(app.node('catalog-image').innerHTML, /33333333333333333333333333333333/); assert.equal(app.node('catalog-source-line').textContent, 'B · 第 9 行');
  app.context.ui.correction.close(); app.node('product').value = 'shared'; app.context.ui.selectProduct(); await app.node('publish').events.get('click')();
  const generation = JSON.parse(calls.find(([url]) => url.endsWith('/generate'))[1].body); assert.equal(generation.customerId, 'brand-b'); assert.equal(generation.productId, 'shared'); assert.equal(generation.catalogRevision, revisionB);
  const brandReads = calls.filter(([url]) => url === '/admin/api/catalog?customerId=brand-b'); assert.equal(brandReads.length, 2); assert.ok(brandReads.every(([, options]) => options.headers['X-Studio-Token'] === 'synthetic'));
});

test('actual empty-customer boot enables a localized first import without bogus catalog requests and preserves report history', async () => {
  const calls = [], profile = { id: 'first', name: 'VialCove' }, product = catalogDTO({ id: 'adamax', name: 'Adamax 10mg', ...parseProduct('Adamax 10mg') }); let fileNumber = 0;
  const ok = value => ({ status: 200, ok: true, json: async () => value });
  const app = await boot(operatorJS, operatorHTML, { fetch: async (url, options) => {
    calls.push([url, options]);
    if(url==='/admin/api/imports'&&options?.method==='GET')return ok({imports:[]});
    if (url.endsWith('/session')) return ok({ customers: [], defaultCustomerId: '', customer: null, products: [], token: 'empty-token', publicOrigin: 'http://customer.invalid' });
    if (url.endsWith('/history')) return ok([{ lookupCode: 'AN-OLD0-0001', label: 'Saved report', reported: '2026-11-06' }]);
    if (url === '/admin/api/imports') return ok({ id: 'a'.repeat(32) });
    if (url.endsWith('/files')) return ok({ id: (++fileNumber).toString(16).padStart(32, '0') });
    if (options?.method === 'PUT') return ok({});
    if (url.endsWith('/inspect')) return ok({ sheets: ['Table'], sheet: 'Table', headerRow: 1, columns: [{ id: 'A', label: 'SKU' }, { id: 'B', label: 'Product' }] });
    if (url.endsWith('/preview')) return ok({ canConfirm: true, rows: [], imageRows: [], counts: { valid: 1, unmatched: 0, conflict: 0, duplicate: 0, images: 1, unmatchedImages: 0 } });
    if (url.endsWith('/confirm')) return ok({ customer: profile, customers: [profile], products: [product] });
    if (url.endsWith('/generate')) return { status: 400, ok: false, json: async () => ({ error: 'Use a valid ISO date.' }) };
    throw new Error('Unexpected empty-customer request: ' + url);
  }, extra: 'globalThis.ui={language,loadCustomer,selected:()=>selected};' });
  const { ui } = app.context;
  assert.equal(app.node('customer').options.length, 1); assert.equal(app.node('customer').options[0].textContent, 'No customers yet');
  for (const id of ['customer', 'reload-products', 'catalog-manage', 'search', 'product']) assert.equal(app.node(id).disabled, true, id);
  assert.ok(app.node('generate').querySelectorAll('#generate button').every(button => button.disabled));
  assert.equal(app.node('import-target').value, 'new'); assert.equal(app.node('import-target').options.find(option => option.value === 'current').disabled, true);
  for (const id of ['import-name', 'import-folder', 'import-sheet', 'import-upload', 'logout']) assert.equal(app.node(id).disabled, false, id);
  assert.match(app.node('history').innerHTML, /AN-OLD0-0001/); assert.match(app.node('status').textContent, /No customers yet/);
  await ui.loadCustomer(''); await app.node('reload-products').events.get('click')(); assert.equal(calls.length, 3);
  app.node('history').events.get('click')({ target: { closest: () => ({ dataset: { code: 'AN-OLD0-0001' } }) } });
  assert.equal(app.node('code').textContent, 'AN-OLD0-0001'); const paper = app.node('paper').src;
  app.node('import-name').value = 'VialCove'; app.node('import-name').focus(); const focus = app.document.activeElement, before = calls.length;
  ui.language.setLocale('zh-CN'); assert.equal(calls.length, before); assert.equal(app.document.activeElement, focus); assert.equal(app.node('import-name').value, 'VialCove'); assert.match(app.node('status').textContent, /暂无客户/); assert.equal(app.node('customer').options[0].textContent, '暂无客户');
  app.node('import-folder').files = [{ name: 'ADA10.png', webkitRelativePath: 'pictures/ADA10.png', size: 1, slice: () => new Blob(['x']) }];
  app.node('import-sheet').files = [{ name: 'codes.csv', size: 1, slice: () => new Blob(['x']) }];
  await app.node('import-form').events.get('submit')({ preventDefault() {} }); assert.deepEqual(JSON.parse(calls.find(([url,options]) => url === '/admin/api/imports' && options.method==='POST')[1].body), { name: 'VialCove' });
  await app.node('import-preview').events.get('click')(); await app.node('import-confirm').events.get('click')();
  assert.equal(app.node('customer').value, profile.id); assert.equal(ui.selected().id, product.id); assert.equal(app.node('search').disabled, false); assert.equal(app.node('customer').disabled, false);
  assert.equal(app.node('import-target').value, 'current'); assert.equal(app.node('import-target').options.find(option => option.value === 'current').disabled, false); assert.equal(app.node('paper').hidden,true); assert.equal(app.node('code').textContent, '');
  await app.node('publish').events.get('click')(); assert.equal(JSON.parse(calls.find(([url]) => url.endsWith('/generate'))[1].body).customerId, profile.id);
  assert.equal(app.node('paper').hidden,true); assert.equal(calls.some(([url]) => url.includes('/catalog?')), false);
});

test('actual customer handlers preserve reload selection, stale/failure guards, upload fields and snapshots through generation', async () => {
  const product=name=>catalogDTO({id:name,...parseProduct(name),name});
  const bpc=product('BPC-157 10mg'),sema=product('Semaglutide 5mg'),kpv=product('KPV 10mg');
  const a={id:'a',name:'Aster',directory:'/srv/a'},b={id:'b',name:'Cedar',directory:'/srv/b'};
  let customers=[a,b],catalogRequests=[],mutationRequests=[],calls=[];
  const ok=value=>({status:200,ok:true,json:async()=>value});
  const app=await boot(operatorJS,operatorHTML,{fetch:async(url,options)=>{
    calls.push([url,options]);if(url==='/admin/api/imports'&&options?.method==='GET')return {status:200,ok:true,json:async()=>({imports:[]})};if(url.endsWith('/session'))return ok({customers,defaultCustomerId:a.id,products:[bpc,sema],token:'fixture',publicOrigin:'http://customer.invalid'});
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
  assert.equal(ui.selected(),undefined);assert.equal(app.node('import-target').disabled,false);assert.equal(app.node('import-folder').disabled,false);assert.equal(app.node('import-sheet').disabled,false);assert.equal(app.node('code').textContent,'');assert.equal(app.node('paper').hidden,true);assert.match(app.node('status').textContent,/Upload/);
  app.node('import-name').value='Future customer';app.node('import-name').focus();
  const focus=app.document.activeElement,io=calls.length;ui.language.setLocale('zh-CN');assert.equal(calls.length,io);assert.equal(app.document.activeElement,focus);assert.equal(app.node('import-name').value,'Future customer');
  const recover=app.node('reload-products').events.get('click')();assert.equal(app.node('generate').elements.namedItem('lot').disabled,true);
  const inFlightCalls=calls.length;ui.language.setLocale('en');assert.equal(calls.length,inFlightCalls);assert.equal(app.node('generate').elements.namedItem('lot').disabled,true);assert.equal(app.document.activeElement,focus);
  catalogRequests.shift().resolve(ok({customer:b,products:[kpv]}));await recover;
  assert.equal(app.node('customer').value,b.id);assert.equal(ui.selected().id,kpv.id);assert.equal(app.node('code').textContent,'');assert.equal(app.node('import-name').value,'Future customer');
  const generate=app.node('publish').events.get('click')();await flush();const generation=mutationRequests.shift(),payload=JSON.parse(generation.options.body);
  assert.equal(payload.customerId,b.id);assert.equal(payload.productId,kpv.id);assert.equal(Object.hasOwn(payload.fields,'client'),false);assert.equal(app.node('customer').disabled,true);
  generation.resolve({status:400,ok:false,json:async()=>({error:'Use a valid ISO date.'})});await generate;assert.equal(app.node('code').textContent,'');assert.equal(app.node('customer').disabled,false);
  app.node('search').value='SM2';ui.filter();assert.equal(ui.selected(),undefined);assert.equal(app.node('paper').hidden,true);
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
    const child=spawn(process.execPath,['server.mjs','--no-accounts','--port='+port,...(mode==='lan'?['--host=0.0.0.0','--conference-reports','--conference-store='+path.join(root,'readonly')]:[])],{cwd:project,env:{...process.env,NODE_ENV:mode==='production'?'production':'test'},windowsHide:true,stdio:'ignore'});
    let stopped;const stop=()=>stopped??=child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>{child.once('exit',resolve);child.kill();});t.after(stop);
    const origin='http://127.0.0.1:'+port;let ready=false;for(let attempt=0;attempt<100;attempt++){try{if((await fetch(origin+'/')).ok){ready=true;break;}}catch{}await delay(25);}assert.equal(ready,true);
    for(const method of ['GET','HEAD','POST'])assert.equal((await fetch(origin+'/admin/admin-i18n.mjs',{method})).status,404);await stop();
  }
});

test('actual report library confirms exact identity, cancels safely, restores focus, localizes and preserves unrelated catalog state', async () => {
  const row={lookupCode:'AN-QA92-0001',label:'Synthetic <report> & 10mg',reported:'2026-11-07'}, other={lookupCode:'AN-QA92-0002',label:'Other report',reported:'2026-11-07'};
  const product=catalogDTO({id:'selected',name:'BPC-157 10mg',...parseProduct('BPC-157 10mg')}), calls=[];let state='published', release;
  const ok=value=>({status:200,ok:true,json:async()=>value});
  const app=await boot(operatorJS,operatorHTML,{fetch:async(url,options={})=>{
    calls.push([url,options]);if(url.endsWith('/session'))return ok({products:[product],customers:[{id:'fixture',name:'Customer'}],defaultCustomerId:'fixture',token:'synthetic-092',publicOrigin:'https://fixture.invalid'});
    if(url==='/admin/api/imports')return ok({imports:[]});
    if(url.startsWith('/admin/api/history'))return ok(url.endsWith('state=removed')?(state==='removed'?[row]:[]):state==='published'?[row,other]:[other]);
    return new Promise(resolve=>release=()=>{state=url.endsWith('/remove')?'removed':'published';resolve(ok({lookupCode:row.lookupCode,state,label:row.label}));});
  },extra:'globalThis.ui={language,showResult,reportLibrary,selected:()=>selected};'});
  const {ui}=app.context, trigger=()=>app.node('history').querySelectorAll('[data-report-action]')[0], click=button=>app.node('history').events.get('click')({target:{closest:()=>button}});
  assert.match(app.node('history').innerHTML,/Synthetic &lt;report&gt; &amp;/);for(const button of app.node('history').querySelectorAll('button'))for(let parent=button.parent;parent;parent=parent.parent)assert.notEqual(parent.tagName,'BUTTON');
  app.node('search').value='BC10';const selectedBefore=ui.selected().id;
  let first=trigger();click(first);assert.equal(app.node('report-dialog').open,true);assert.equal(app.document.activeElement,app.node('report-cancel'));assert.equal(app.node('report-dialog-identity').textContent,row.label+' · '+row.lookupCode);assert.match(app.node('report-dialog-description').textContent,/original files and code are preserved/);
  app.node('report-dialog').events.get('cancel')({preventDefault(){}});assert.equal(app.node('report-dialog').open,false);assert.equal(app.document.activeElement,first);assert.equal(calls.filter(([url])=>url.includes('/reports/')).length,0);
  click(first);app.node('report-cancel').events.get('click')();assert.equal(calls.filter(([url])=>url.includes('/reports/')).length,0);
  click(first);const focus=app.document.activeElement,before=calls.length;ui.language.setLocale('zh-CN');assert.equal(calls.length,before);assert.equal(app.document.activeElement,focus);assert.match(app.node('report-dialog-title').textContent,/移除/);assert.match(app.node('report-dialog-description').textContent,/保留原始文件和编号/);ui.language.setLocale('en');
  const openButton=app.node('history').querySelectorAll('[data-code]').find(button=>!button.dataset.reportAction);click(openButton);assert.equal(app.node('code').textContent,row.lookupCode);
  const change=app.node('report-confirm').events.get('click')();assert.equal(app.node('report-confirm').disabled,true);assert.equal(app.node('generate').elements.namedItem('lot').disabled,true);assert.equal(app.node('report-state').disabled,true);
  await app.node('generate').events.get('submit')({preventDefault(){},submitter:{value:'publish'}});await app.node('report-confirm').events.get('click')();app.node('report-dialog').events.get('cancel')({preventDefault(){}});assert.equal(app.node('report-dialog').open,true);assert.equal(calls.filter(([url])=>url.includes('/reports/')).length,1);assert.equal(calls.some(([url])=>url.endsWith('/generate')),false);
  release();await change;assert.equal(app.node('report-dialog').open,false);assert.equal(app.document.activeElement,app.node('report-state'));assert.match(app.node('result-state').textContent,/Removed snapshot/);assert.equal(app.node('public-link').hidden,true);assert.equal(app.node('public-link').getAttribute('href'),null);assert.equal(app.node('copy-code').hidden,true);assert.match(app.node('paper').src,/bundles\/removed/);assert.equal(app.node('search').value,'BC10');assert.equal(ui.selected().id,selectedBefore);
  app.node('report-state').value='removed';await app.node('report-state').events.get('change')();assert.match(app.node('history').innerHTML,/data-report-action="restore"/);first=trigger();click(first);assert.match(app.node('report-dialog-title').textContent,/Restore/);assert.equal(app.document.activeElement,app.node('report-cancel'));
  const restore=app.node('report-confirm').events.get('click')();release();await restore;assert.equal(app.node('copy-code').hidden,false);assert.equal(app.node('public-link').hidden,false);assert.match(app.node('paper').src,/bundles\/published/);assert.match(app.node('report-message').textContent,/restored/);
  assert.ok(calls.filter(([url])=>url.includes('/reports/')).every(([,options])=>options.method==='POST'&&options.body==='{}'&&options.headers['X-Studio-Token']==='synthetic-092'));
  ui.showResult({published:false,label:'Private',report:{lookupCode:'AN-QA92-0099'},previewURL:'/admin/bundles/previews/AN-QA92-0099/report.svg',pdfURL:'/admin/bundles/previews/AN-QA92-0099/report.pdf'});
  app.node('report-state').value='published';await app.node('report-state').events.get('change')();click(trigger());const removeAgain=app.node('report-confirm').events.get('click')();release();await removeAgain;assert.equal(app.node('code').textContent,'AN-QA92-0099');assert.match(app.node('paper').src,/previews/);
  assert.ok(operatorHTML.indexOf('<dialog id="report-dialog"')>operatorHTML.indexOf('</main>'));assert.match(operatorHTML,/aria-describedby="report-dialog-identity report-dialog-description"/);
});

test('actual library lost-response retry repeats one action, releases pending after timeout and keeps safe recovery controls', async () => {
  const row={lookupCode:'AN-QA92-0001',label:'Synthetic retry',reported:'2026-11-07'}, calls=[];let removed=false, mutations=0, listFails=false;
  const ok=value=>({status:200,ok:true,json:async()=>value});
  const app=await boot(operatorJS,operatorHTML,{reportTimeout:5,fetch:async(url,options={})=>{
    calls.push([url,options]);if(url.endsWith('/session'))return ok({products:[],customers:[],defaultCustomerId:'',token:'synthetic',publicOrigin:'https://fixture.invalid'});
    if(url==='/admin/api/imports')return ok({imports:[]});if(url.startsWith('/admin/api/history')){if(listFails)throw new Error('private C:/never-display');return ok(removed?[]:[row]);}
    mutations++;removed=true;if(mutations===1)return new Promise(()=>{});return ok({lookupCode:row.lookupCode,state:'removed',label:row.label});
  }});
  const button=app.node('history').querySelectorAll('[data-report-action]')[0];app.node('history').events.get('click')({target:{closest:()=>button}});
  await app.node('report-confirm').events.get('click')();assert.equal(app.node('report-confirm').disabled,false);assert.equal(app.node('report-cancel').disabled,false);assert.equal(app.node('report-dialog').open,true);assert.match(app.node('report-dialog-status').textContent,/Retry the same action/);assert.equal(app.node('report-dialog').getAttribute('aria-busy'),'false');
  await app.node('report-confirm').events.get('click')();assert.equal(app.node('report-dialog').open,false);assert.equal(mutations,2);
  const requests=calls.filter(([url])=>url.includes('/reports/'));assert.equal(requests[0][0],requests[1][0]);assert.equal(requests[0][1].body,requests[1][1].body);
  listFails=true;await app.node('report-refresh').events.get('click')();assert.match(app.node('report-message').textContent,/Use Refresh/);assert.doesNotMatch(app.node('report-message').textContent,/never-display/);assert.equal(app.node('report-refresh').disabled,false);
});

test('actual operator clears matching previews after lost remove/restore acknowledgements through Cancel and Refresh, preserving unrelated previews', async () => {
  const row={lookupCode:'AN-QA92-0001',label:'Synthetic uncertain report',reported:'2026-11-07'}, product=catalogDTO({id:'selected',name:'BPC-157 10mg',...parseProduct('BPC-157 10mg')});
  const ok=value=>({status:200,ok:true,json:async()=>value});
  for(const action of ['remove','restore'])for(const preview of ['matching','otherPublished','otherPrivate']){
    let savedState=action==='remove'?'published':'removed',mutations=0;const calls=[];
    const app=await boot(operatorJS,operatorHTML,{reportTimeout:5,fetch:async(url,options={})=>{
      calls.push([url,options]);if(url.endsWith('/session'))return ok({products:[product],customers:[{id:'fixture',name:'Customer'}],defaultCustomerId:'fixture',token:'synthetic',publicOrigin:'https://fixture.invalid'});
      if(url==='/admin/api/imports')return ok({imports:[]});
      if(url.startsWith('/admin/api/history'))return ok((url.endsWith('state=removed')?'removed':'published')===savedState?[row]:[]);
      assert.ok(url.endsWith('/'+action));mutations++;savedState=action==='remove'?'removed':'published';
      if(action==='remove')throw new Error('Failed to fetch');return new Promise(()=>{});
    },extra:'globalThis.ui={language,showResult,result:()=>result,selected:()=>selected};'});
    if(action==='restore'){app.node('report-state').value='removed';await app.node('report-state').events.get('change')();}
    const click=button=>app.node('history').events.get('click')({target:{closest:()=>button}}),buttons=app.node('history').querySelectorAll('[data-code]');
    click(buttons.find(button=>!button.dataset.reportAction));
    if(preview!=='matching')app.context.ui.showResult({published:preview==='otherPublished',label:'Unrelated',report:{lookupCode:'AN-QA92-0099'},previewURL:'/admin/bundles/'+(preview==='otherPublished'?'published':'previews')+'/AN-QA92-0099/report.svg',pdfURL:'/admin/bundles/'+(preview==='otherPublished'?'published':'previews')+'/AN-QA92-0099/report.pdf',publicURL:'https://fixture.invalid/coa/AN-QA92-0099'});
    const before={result:app.context.ui.result(),code:app.node('code').textContent,paper:app.node('paper').src,pdf:app.node('pdf').href,publicHidden:app.node('public-link').hidden,copyHidden:app.node('copy-code').hidden},selection=app.context.ui.selected().id;
    app.node('manual-copy').value=before.code;app.node('manual-label').hidden=false;
    click(buttons.find(button=>button.dataset.reportAction));await app.node('report-confirm').events.get('click')();assert.equal(mutations,1);assert.equal(app.node('report-dialog').open,true);assert.match(app.node('report-dialog-status').textContent,/could not be confirmed/);
    if(preview==='matching'){
      assert.equal(app.context.ui.result(),null);assert.equal(app.node('result').hidden,true);assert.equal(app.node('empty').hidden,false);assert.equal(app.node('paper').hidden,true);assert.equal(app.node('paper').getAttribute('src'),null);assert.equal(app.node('pdf').getAttribute('href'),null);assert.equal(app.node('public-link').getAttribute('href'),null);assert.equal(app.node('public-link').hidden,true);assert.equal(app.node('copy-code').hidden,true);assert.equal(app.node('manual-label').hidden,true);assert.equal(app.node('manual-copy').value,'');for(const id of ['code','result-name','result-state'])assert.equal(app.node(id).textContent,'');
    }else{
      assert.equal(app.context.ui.result(),before.result);assert.equal(app.node('code').textContent,before.code);assert.equal(app.node('paper').src,before.paper);assert.equal(app.node('pdf').href,before.pdf);assert.equal(app.node('public-link').hidden,before.publicHidden);assert.equal(app.node('copy-code').hidden,before.copyHidden);assert.equal(app.node('manual-copy').value,before.code);assert.equal(app.node('manual-label').hidden,false);
    }
    app.node('report-cancel').events.get('click')();click(buttons.find(button=>!button.dataset.reportAction));
    if(preview==='matching')assert.equal(app.context.ui.result(),null);else assert.equal(app.context.ui.result(),before.result);
    await app.node('report-refresh').events.get('click')();assert.equal(app.node('report-dialog').open,false);assert.equal(app.node('history').querySelectorAll('[data-code]').length,0);assert.equal(app.context.ui.selected().id,selection);assert.equal(app.node('report-refresh').disabled,false);
    if(preview==='matching'){
      app.context.ui.language.setLocale('zh-CN');assert.equal(app.context.ui.result(),null);assert.equal(app.node('result').hidden,true);assert.equal(app.node('code').textContent,'');assert.equal(app.node('copy-code').hidden,true);
      app.node('report-state').value=savedState;await app.node('report-state').events.get('change')();click(app.node('history').querySelectorAll('[data-code]').find(button=>!button.dataset.reportAction));assert.equal(app.node('code').textContent,row.lookupCode);assert.equal(app.node('public-link').hidden,action==='remove');
    }else assert.equal(app.context.ui.result(),before.result);
    assert.equal(calls.filter(([url])=>url.includes('/reports/')).length,1);
  }
});

test('actual operator retains acknowledged remove/restore plus library read error until a successful Refresh', async () => {
  const row={lookupCode:'AN-QA92-0001',label:'Synthetic read failure',reported:'2026-11-07'},ok=value=>({status:200,ok:true,json:async()=>value});
  for(const action of ['remove','restore']){
    let state=action==='remove'?'published':'removed',failHistory=false,mutations=0;
    const app=await boot(operatorJS,operatorHTML,{fetch:async(url)=>{
      if(url.endsWith('/session'))return ok({products:[],customers:[],defaultCustomerId:'',token:'synthetic',publicOrigin:'https://fixture.invalid'});
      if(url==='/admin/api/imports')return ok({imports:[]});
      if(url.startsWith('/admin/api/history')){if(failHistory)throw new Error('C:/private synthetic diagnostic');return ok((url.endsWith('state=removed')?'removed':'published')===state?[row]:[]);}
      mutations++;state=action==='remove'?'removed':'published';failHistory=true;return ok({lookupCode:row.lookupCode,state,label:row.label});
    },extra:'globalThis.ui={language};'});
    if(action==='restore'){app.node('report-state').value='removed';await app.node('report-state').events.get('change')();}
    const buttons=app.node('history').querySelectorAll('[data-code]'),click=button=>app.node('history').events.get('click')({target:{closest:()=>button}});click(buttons.find(button=>!button.dataset.reportAction));click(buttons.find(button=>button.dataset.reportAction));
    await app.node('report-confirm').events.get('click')();assert.equal(app.node('report-dialog').open,false);assert.equal(app.node('report-refresh').disabled,false);assert.match(app.node('report-message').textContent,action==='remove'?/Report removed\./:/Report restored\./);assert.match(app.node('report-message').textContent,/library could not be loaded.*Refresh/);assert.doesNotMatch(app.node('report-message').textContent,/private synthetic diagnostic/);assert.equal(app.node('public-link').hidden,action==='remove');assert.match(app.node('paper').src,action==='remove'?/bundles\/removed\//:/bundles\/published\//);
    app.context.ui.language.setLocale('zh-CN');assert.match(app.node('report-message').textContent,/无法加载报告列表.*刷新/);app.context.ui.language.setLocale('en');
    failHistory=false;await app.node('report-refresh').events.get('click')();assert.equal(app.node('report-message').textContent,'');assert.equal(mutations,1);assert.equal(app.node('report-refresh').disabled,false);
    app.node('report-state').value=state;await app.node('report-state').events.get('change')();assert.match(app.node('history').innerHTML,/AN-QA92-0001/);
  }
});

async function liveFixture(options={}){
  const products=['BPC-157 10mg','BPC-157 40mg'].map((name,index)=>({...catalogDTO({id:'product'+index,name,...parseProduct(name)}),status:'ready'}));
  const calls=[],pending=[],ok=value=>({status:200,ok:true,json:async()=>value});
  const session={products,customers:[{id:'fixture',name:'Synthetic'}],defaultCustomerId:'fixture',token:'synthetic',publicOrigin:'https://fixture.invalid',catalogRevision:'a'.repeat(32)};
  const row={lookupCode:'AN-QA98-0001',label:'Saved fixture',reported:'2026-11-07'};
  const app=await boot(operatorJS,operatorHTML,{...options,fetch:async(url,request={})=>{
    calls.push([url,request]);if(url.endsWith('/session'))return ok({...session,...options.session});
    if(url.startsWith('/admin/api/history'))return ok([row]);if(url==='/admin/api/imports'&&request.method==='GET')return ok({imports:[]});
    if(options.fetch){const value=options.fetch(url,request);if(value)return value;}
    return new Promise((resolve,reject)=>pending.push({url,request,resolve,reject}));
  },extra:'globalThis.ui={language,filter,selectProduct,loadCustomer,showResult,libraryFetch,session:()=>session,selected:()=>selected};'});
  const select=index=>{app.node('product').value=products[index].id;app.context.ui.selectProduct();};
  const edit=(name,value)=>{const target=app.node('generate').elements.namedItem(name);target.value=value;app.node('generate').events.get('input')({target});return target;};
  const preview=(request=pending.shift(),label='Current')=>{request.resolve(ok({label,svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>'+label+'</text></svg>'}));return flush();};
  return {...app,calls,pending,ok,products,row,select,edit,preview};
}
test('live preview debounces ready selection and edits, preserves focus and seed, and ignores locale/same-selection search',async()=>{
  const app=await liveFixture();await app.clock.tick(1000);assert.equal(app.pending.length,0);
  app.select(0);await app.clock.tick(349);assert.equal(app.pending.length,0);await app.clock.tick(1);assert.equal(app.pending.length,1);
  const first=app.pending.shift(),body=JSON.parse(first.request.body);assert.equal(first.url,'/admin/api/preview');assert.equal(body.productId,'product0');assert.match(body.previewSeed,/^[a-f0-9]{48}$/);assert.equal(body.catalogRevision,'a'.repeat(32));assert.equal(Object.hasOwn(body,'publish'),false);
  const input=app.edit('lot','LOT-A');input.focus();input.selectionStart=3;const focus=input.focusCalls;assert.equal(input.disabled,false);
  app.edit('lot','LOT-B');await app.clock.tick(350);assert.equal(app.pending.length,0);assert.equal(app.node('paper').hidden,true);
  await app.preview(first,'Stale');assert.equal(app.node('paper').hidden,true);assert.equal(app.pending.length,1);
  const next=app.pending.shift(),nextBody=JSON.parse(next.request.body);assert.equal(nextBody.fields.lot,'LOT-B');assert.equal(nextBody.previewSeed,body.previewSeed);
  await app.preview(next,'Latest 10mg');assert.equal(app.node('paper').hidden,false);assert.match(decodeURIComponent(app.node('paper').src),/Latest 10mg/);assert.equal(app.node('result').hidden,true);assert.equal(app.node('public-link').hidden,true);assert.equal(app.node('pdf').getAttribute('href'),null);assert.equal(app.node('copy-code').hidden,true);
  assert.equal(app.document.activeElement,input);assert.equal(input.focusCalls,focus);assert.equal(input.selectionStart,3);
  const count=app.calls.length;app.node('search').value='BC10';app.context.ui.filter();app.context.ui.language.setLocale('zh-CN');await app.clock.tick(1000);assert.equal(app.calls.length,count);assert.equal(input.value,'LOT-B');assert.match(app.node('live-status').textContent,/已更新/);
  app.context.window.events.get('pagehide')();assert.equal(app.clock.size(),0);
});
test('invalid fields, incomplete numeric input, IME, empty and blocked choices never render and clear stale paper',async()=>{
  const app=await liveFixture();app.select(0);await app.clock.tick(350);await app.preview();
  for(const [name,value] of [['purity1','98'],['purity1','99.501'],['purity1','Infinity'],['received','2026-02-30'],['lot','中文']]){
    app.edit(name,value);assert.equal(app.node('paper').hidden,true);await app.clock.tick(350);assert.equal(app.pending.length,0);app.edit(name,'');
  }
  app.edit('received','2026-11-08');app.edit('reported','2026-11-07');await app.clock.tick(350);assert.equal(app.pending.length,0);
  app.edit('received','2026-11-07');const field=app.edit('purity1','');field.validity={badInput:true};app.edit('purity1','');await app.clock.tick(350);assert.equal(app.pending.length,0);field.validity={badInput:false};
  app.node('generate').events.get('compositionstart')();app.edit('lot','PARTIAL');await app.clock.tick(350);assert.equal(app.pending.length,0);app.node('generate').events.get('compositionend')();await app.clock.tick(350);assert.equal(app.pending.length,1);await app.preview();
  app.node('search').value='unmatched';app.context.ui.filter();await app.clock.tick(1000);assert.equal(app.pending.length,0);assert.equal(app.node('paper').hidden,true);
  app.context.window.events.get('pagehide')();
});
test('stale success and error cannot win after switching away/back, changing revision or customer',async()=>{
  const app=await liveFixture();app.select(0);await app.clock.tick(350);const old=app.pending.shift();app.select(1);app.select(0);await app.clock.tick(350);await app.preview(old,'Old 40mg');assert.equal(app.node('paper').hidden,true);assert.equal(app.pending.length,1);
  const revision=app.pending.shift();app.context.ui.session().catalogRevision='b'.repeat(32);app.context.ui.selectProduct();await app.clock.tick(350);revision.resolve({ok:false,status:400,json:async()=>({error:'Old error'})});await flush();assert.equal(app.node('live-status').textContent,DICTIONARIES.en.liveUpdating);assert.equal(app.pending.length,1);
  const brand=app.pending.shift(),loading=app.context.ui.loadCustomer('other');const catalog=app.pending.shift();catalog.resolve(app.ok({customer:{id:'other',name:'Other'},products:app.products,catalogRevision:'c'.repeat(32)}));await loading;app.select(0);await app.preview(brand,'Old brand');assert.equal(app.node('paper').hidden,true);await app.clock.tick(350);assert.equal(JSON.parse(app.pending[0].request.body).customerId,'other');app.context.window.events.get('pagehide')();await flush();assert.equal(app.clock.size(),0);
});
test('explicit publication drains live work once and Enter never publishes; library snapshots survive search and locale',async()=>{
  const app=await liveFixture();app.select(0);await app.clock.tick(350);const preview=app.pending.shift();
  await app.node('generate').events.get('submit')({preventDefault(){},submitter:app.node('publish')});assert.equal(app.pending.length,0);assert.equal(app.node('publish').getAttribute('type'),'button');
  app.edit('lot','CAPTURED');const publishing=app.node('publish').events.get('click')();await flush();assert.equal(app.pending.length,0);assert.equal(app.node('generate').elements.namedItem('lot').disabled,true);
  await app.preview(preview,'Ignored');const request=app.pending.shift();assert.equal(request.url,'/admin/api/generate');assert.equal(JSON.parse(request.request.body).publish,true);assert.equal(JSON.parse(request.request.body).fields.lot,'CAPTURED');
  request.resolve(app.ok({published:true,label:'Published',report:{lookupCode:app.row.lookupCode},previewURL:'/saved.svg',pdfURL:'/saved.pdf',publicURL:'https://fixture.invalid/coa/'+app.row.lookupCode}));await publishing;
  const count=app.calls.length;app.node('search').value='BC10';app.context.ui.filter();app.context.ui.language.setLocale('zh-CN');await app.clock.tick(1000);assert.equal(app.calls.length,count);assert.equal(app.node('paper').src,'/saved.svg');assert.equal(app.node('copy-code').hidden,false);
  app.edit('lot','NEW');assert.equal(app.node('paper').hidden,true);assert.equal(app.node('copy-code').hidden,true);await app.clock.tick(350);assert.equal(app.pending[0].url,'/admin/api/preview');app.context.window.events.get('pagehide')();await flush();
});
test('preview errors retry only on request; uncertain failures and timeout gate Retry and publication until 75 seconds',async()=>{
  for(const failure of ['http','network','timeout']){
    const app=await liveFixture();app.select(0);await app.clock.tick(350);const request=app.pending.shift();
    if(failure==='http')request.resolve({ok:false,status:400,json:async()=>({error:'Synthetic failure'})});
    else if(failure==='network')request.reject(new Error('Failed to fetch'));
    else await app.clock.tick(60000);
    await flush();assert.equal(app.node('preview-retry').hidden,false);await app.clock.tick(failure==='http'?1000:1);assert.equal(app.pending.length,0);
    app.node('preview-retry').events.get('click')();await app.clock.tick(350);
    if(failure==='http'){assert.equal(app.pending.length,1);app.context.window.events.get('pagehide')();await flush();continue;}
    assert.equal(app.pending.length,0);const publication=app.node('publish').events.get('click')();await flush();assert.equal(app.pending.length,0);
    await app.clock.tick(failure==='network'?74648:14648);assert.equal(app.pending.length,0);await app.clock.tick(1);assert.equal(app.pending.length,1);assert.equal(app.pending[0].url,'/admin/api/generate');
    app.pending.shift().resolve({ok:false,status:400,json:async()=>({error:'Use a valid ISO date.'})});await publication;app.context.window.events.get('pagehide')();assert.equal(app.clock.size(),0);
  }
});
test('library mutations drain preview and uncertainty cooldown without dispatching an aborted wrapper late',async()=>{
  for(const action of ['remove','restore'])for(const uncertain of [false,true]){
    const app=await liveFixture();app.select(0);await app.clock.tick(350);const preview=app.pending.shift();
    if(uncertain){preview.reject(new Error('Failed to fetch'));await flush();}
    const route='/admin/api/reports/'+app.row.lookupCode+'/'+action,controller=new AbortController();
    const mutation=app.context.ui.libraryFetch(route,{method:'POST',signal:controller.signal});await flush();assert.equal(app.pending.length,0);
    if(uncertain){await app.clock.tick(74999);assert.equal(app.pending.length,0);await app.clock.tick(1);}else await app.preview(preview,'Ignored');
    assert.equal(app.pending.length,1);assert.equal(app.pending[0].url,route);app.pending.shift().resolve(app.ok({}));await mutation;
    app.context.window.events.get('pagehide')();assert.equal(app.clock.size(),0);
  }
  const app=await liveFixture();app.select(0);await app.clock.tick(350);app.pending.shift().reject(new Error('Failed to fetch'));await flush();
  const controller=new AbortController(),mutation=app.context.ui.libraryFetch('/admin/api/reports/'+app.row.lookupCode+'/remove',{method:'POST',signal:controller.signal});controller.abort();await app.clock.tick(75000);await assert.rejects(mutation,/cancelled/);assert.equal(app.pending.length,0);app.context.window.events.get('pagehide')();assert.equal(app.clock.size(),0);
});
test('401, logout and pagehide invalidate live queues and release every preview timer',async()=>{
  for(const stop of ['401','logout','pagehide']){
    const app=await liveFixture();app.select(0);await app.clock.tick(350);const active=app.pending.shift();app.edit('lot','QUEUED');
    if(stop==='401')active.resolve({status:401,ok:false,json:async()=>({})});else if(stop==='pagehide')app.context.window.events.get('pagehide')();else{const logout=app.node('logout').events.get('click')();const request=app.pending.shift();request.resolve(app.ok({}));await logout;}
    await flush();await app.clock.tick(100000);assert.equal(app.pending.length,0);assert.equal(app.clock.size(),0);if(stop!=='pagehide')assert.deepEqual(app.navigation,['/admin']);
  }
});
test('an upload that temporarily blocks dispatch resumes the queued preview after cancellation',async()=>{
  const app=await liveFixture({fetch:(url)=>url==='/admin/api/imports'?null:undefined});app.select(0);
  app.node('import-folder').files=[{name:'BC10.png',webkitRelativePath:'photos/BC10.png',size:1,slice:()=>new Blob(['x'])}];
  const upload=app.node('import-form').events.get('submit')({preventDefault(){}});await flush();await app.clock.tick(350);assert.equal(app.pending.filter(row=>row.url==='/admin/api/preview').length,0);
  const creating=app.pending.shift();creating.resolve({ok:false,status:400,json:async()=>({error:'Synthetic upload failure'})});await upload;await flush();assert.equal(app.pending.length,1);assert.equal(app.pending[0].url,'/admin/api/preview');app.context.window.events.get('pagehide')();await flush();
});

test('a unique ready product previews once on boot and HTTP error Retry completes without focus theft',async()=>{
  const product={...catalogDTO({id:'only',name:'BPC-157 10mg',...parseProduct('BPC-157 10mg')}),status:'ready'};
  const app=await liveFixture({session:{products:[product]}});await app.clock.tick(349);assert.equal(app.pending.length,0);await app.clock.tick(1);assert.equal(app.pending.length,1);
  app.pending.shift().resolve({status:400,ok:false,json:async()=>({error:'Synthetic failure'})});await flush();assert.equal(app.node('live-status').textContent,DICTIONARIES.en.liveError);app.node('preview-retry').events.get('click')();await app.clock.tick(350);await app.preview();assert.equal(app.node('live-status').textContent,DICTIONARIES.en.liveReady);assert.equal(app.node('preview-retry').hidden,true);app.context.window.events.get('pagehide')();
});
test('unrelated library mutation resumes drained live preview, while failed publication offers Retry',async()=>{
  for(const action of ['remove','restore']){
    const app=await liveFixture();if(action==='restore'){app.node('report-state').value='removed';await app.node('report-state').events.get('change')();}
    app.select(0);await app.clock.tick(350);const preview=app.pending.shift();
    const button=app.node('history').querySelectorAll('[data-report-action]')[0];app.node('history').events.get('click')({target:{closest:()=>button}});const mutation=app.node('report-confirm').events.get('click')();await flush();assert.equal(app.pending.length,0);
    await app.preview(preview,'Ignored');assert.equal(app.pending.length,1);assert.ok(app.pending[0].url.endsWith('/'+action));app.pending.shift().resolve(app.ok({lookupCode:app.row.lookupCode,label:app.row.label,state:action==='remove'?'removed':'published'}));await mutation;
    assert.equal(app.node('live-status').textContent,DICTIONARIES.en.liveUpdating);await app.clock.tick(350);assert.equal(app.pending.length,1);await app.preview();assert.equal(app.node('live-status').textContent,DICTIONARIES.en.liveReady);app.context.window.events.get('pagehide')();
  }
  const app=await liveFixture();app.select(0);await app.clock.tick(350);const preview=app.pending.shift(),publication=app.node('publish').events.get('click')();await app.preview(preview,'Ignored');app.pending.shift().resolve({status:400,ok:false,json:async()=>({error:'Use a valid ISO date.'})});await publication;assert.equal(app.node('live-status').textContent,DICTIONARIES.en.liveError);assert.equal(app.node('preview-retry').hidden,false);app.context.window.events.get('pagehide')();
});
test('a library timeout before preview drain never dispatches a late mutation or overwrites uncertain ownership',async()=>{
  const app=await liveFixture({reportTimeout:5});app.select(0);await app.clock.tick(350);const preview=app.pending.shift();
  const open=app.node('history').querySelectorAll('[data-code]').find(button=>!button.dataset.reportAction),remove=app.node('history').querySelectorAll('[data-report-action]')[0],click=button=>app.node('history').events.get('click')({target:{closest:()=>button}});
  click(open);click(remove);await app.node('report-confirm').events.get('click')();assert.equal(app.pending.length,0);assert.equal(app.node('result').hidden,true);assert.match(app.node('report-dialog-status').textContent,/could not be confirmed/);
  await app.preview(preview,'Ignored');await app.clock.tick(1000);assert.equal(app.pending.length,0);assert.equal(app.node('paper').hidden,true);app.context.window.events.get('pagehide')();
});
test('failed logout cancels preview timers and clearly requires reload before publication',async()=>{
  const app=await liveFixture();app.select(0);await app.clock.tick(350);app.pending.shift();const logout=app.node('logout').events.get('click')();app.pending.shift().reject(new Error('Failed to fetch'));await logout;await flush();assert.equal(app.node('live-status').textContent,DICTIONARIES.en.liveDisconnected);assert.equal(app.node('publish').disabled,true);await app.clock.tick(100000);assert.equal(app.pending.length,0);assert.equal(app.clock.size(),0);
});
