import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseProduct, loadCatalog, catalogDTO, DEFAULT_IMAGES } from '../conference/catalog.mjs';
import { createStudio } from '../conference/studio.mjs';
import { createStore, validateFields, validateComponents, runRenderer, PYTHON } from '../conference/store.mjs';
import { readPublished } from '../conference/reader.mjs';
import { SAMPLE_REPORT_DATA } from '../dist/reports/sample-data.js';

const project=fileURLToPath(new URL('../',import.meta.url));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V4AAAAAASUVORK5CYII=','base64');
const product={id:'test-product',name:'BPC-157 10mg',imagePath:'private-fixture',...parseProduct('BPC-157 10mg')};
async function temporary(t) {const directory=await mkdtemp(path.join(tmpdir(),'assaynova-studio-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
async function mockRenderer(requestPath,output) {
  const request=JSON.parse(await readFile(requestPath,'utf8'));
  const record={...structuredClone(SAMPLE_REPORT_DATA['AN-7K9Q-2M4X']),product:request.product.name,contentUnit:request.product.unit,privatePath:'never-public',provenance:'synthetic-private'};
  const report={id:'AN-R-'+request.lookupCode.slice(3),lookupCode:request.lookupCode,publication:'published',version:'1.0',sample:request.product.name,batch:'LOT-TEST',received:'2026-11-05',issued:'2026-11-05',purity:record.purity[2]+'%',identity:'Consistent',identityOutcome:'matched',method:'HPLC / LC-MS',status:'Completed',retentionTime:record.retentionTime+' min',seed:request.seed};
  await Promise.all([writeFile(path.join(output,'bundle.json'),JSON.stringify({report,record,label:request.product.name,seed:request.seed})),writeFile(path.join(output,'report.pdf'),'%PDF-fixture'),writeFile(path.join(output,'report.svg'),'<svg xmlns="http://www.w3.org/2000/svg"><text>'+request.lookupCode+'</text></svg>')]);
}
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function publicServer(t,store,enabled=true,env={}){
  const port=await freePort();
  const child=spawn(process.execPath,['server.mjs','--no-accounts','--port='+port,...(enabled?['--conference-reports','--conference-store='+store]:[])],{cwd:project,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}});
  const origin='http://127.0.0.1:'+port;
  for(let attempt=0;attempt<100;attempt++){if(child.exitCode!==null)throw new Error(output);try{if((await fetch(origin+'/')).ok)return origin;}catch{}await delay(30);}
  throw new Error('Public fixture did not start: '+output);
}


async function fixtureFetch(origin) {
  const html=await (await fetch(origin+'/admin')).text();
  const mode=html.match(/name="admin-auth-mode" content="([^"]+)"/)[1];
  const csrf=html.match(/name="admin-auth-csrf" content="([^"]+)"/)[1];
  const response=await fetch(origin+'/admin/auth/'+mode,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Admin-CSRF':csrf},body:JSON.stringify({password:'Synthetic fixture password 073'})});
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  const secured=(url,options={})=>fetch(url,{...options,headers:{Cookie:cookie,...options.headers}});secured.cookie=cookie;return secured;
}

test('catalog fixture canonicalizes duplicate photos and preserves NAD+ and units',async t=>{
  const root=await temporary(t);await Promise.all(['NAD+ 500mg.png','NAD+ 500mg (02).png','HCG 5000IU.png','0.9% Benzyl Alcohol 10ml.png'].map(file=>writeFile(path.join(root,file),png)));
  const catalog=await loadCatalog(root);assert.equal(catalog.length,3);assert.ok(catalog.find(row=>row.name==='NAD+ 500mg').imagePath.endsWith('NAD+ 500mg.png'));
  assert.deepEqual(parseProduct('NAD+ 500mg').components,[{name:'NAD+',nominal:500,unit:'mg'}]);
  assert.deepEqual(parseProduct('HCG 5000IU').components,[{name:'HCG',nominal:5000,unit:'IU'}]);
  assert.equal(parseProduct('0.9% Benzyl Alcohol 10ml').unit,'ml');
  assert.equal(parseProduct('BPC-157 10mg + TB-500 10mg').components.length,2);
  assert.deepEqual(parseProduct('GLOW 70mg').components.map(row=>row.nominal),[50,10,10]);
  assert.deepEqual(parseProduct('KLOW 80mg').components.map(row=>row.nominal),[50,10,10,10]);
  assert.ok(!JSON.stringify(catalog.map(catalogDTO)).includes(root));
});
test('explicit supplied-photo QA verifies 110 products and 219 originals',{skip:process.env.ASSAYNOVA_CATALOG_QA!=='1'},async()=>{const supplied=await loadCatalog(DEFAULT_IMAGES);assert.equal(supplied.length,110);assert.equal((await readdir(DEFAULT_IMAGES)).filter(file=>/\.png$/i.test(file)).length,219);});

test('field and editable recipe validation rejects malformed, oversized, nonfinite and out-of-range data',()=>{
  assert.deepEqual(validateFields({purity1:99.05,purity2:99.95}).purity2,99.95);
  for(const fields of [{client:'x'.repeat(65)},{client:'\n'},{lot:'中文'},{received:'2026-02-30'},{received:'2026-11-06',reported:'2026-11-05'},{purity1:99},{purity1:100},{purity1:'99.50'},{purity2:99.501},{purity2:NaN},{path:'secret'}])assert.throws(()=>validateFields(fields));
  for(const rows of [[],Array(5).fill(product.components[0]),[{name:'X',nominal:Infinity,unit:'mg'}],[{name:'X',nominal:0,unit:'IU'}],[{name:'X',nominal:5,unit:'g'}]])assert.throws(()=>validateComponents(rows,product.components));
});

test('store snapshots are immutable, collision-safe, single-flight, persistent, and never publish failed jobs',async t=>{
  const root=await temporary(t);let release;let running=false;
  const store=await createStore(root,{codeFactory:()=> 'AN-AAAA-1111',render:async(...args)=>{running=true;await new Promise(resolve=>release=resolve);await mockRenderer(...args);}});
  const first=store.generate(product,{},true);while(!running)await delay(1);
  await assert.rejects(store.generate(product,{},true),/Another report/);assert.equal(await readPublished(root,'AN-AAAA-1111'),null);release();const result=await first;
  assert.equal(result.report.lookupCode,'AN-AAAA-1111');assert.equal((await readPublished(root,'AN-AAAA-1111')).label,product.name);
  const bytes=await readFile(path.join(root,'published','AN-AAAA-1111','bundle.json'));const restarted=await createStore(root,{render:mockRenderer,codeFactory:()=> 'AN-AAAA-1111'});
  assert.equal((await restarted.history()).length,1);await assert.rejects(restarted.generate(product,{},true),/unique Lookup Code/);assert.deepEqual(await readFile(path.join(root,'published','AN-AAAA-1111','bundle.json')),bytes);
  const failed=await createStore(root,{codeFactory:()=> 'AN-BBBB-2222',render:async(_request,output)=>{await writeFile(path.join(output,'report.pdf'),'%PDF-partial');throw new Error('fixture failure');}});
  await assert.rejects(failed.generate(product,{},true),/fixture failure/);assert.equal(await readPublished(root,'AN-BBBB-2222'),null);assert.equal((await failed.history()).length,1);assert.equal((await readdir(path.join(root,'staging'))).length,0);
  const preview=await createStore(root,{render:mockRenderer,codeFactory:()=> 'AN-CCCC-3333'});await preview.generate(product,{},false);assert.equal(await readPublished(root,'AN-CCCC-3333'),null);
});

test('live preview uses only owned staging, stable seed and no code allocation or persistent snapshots',async t=>{
  const root=await temporary(t),requests=[];let allocations=0,release,entered,hold=false,fail=false;
  const store=await createStore(root,{codeFactory:()=>{allocations++;return 'AN-QA98-'+String(allocations).padStart(4,'0');},render:async(request,output,options)=>{requests.push({...JSON.parse(await readFile(request)),options});if(hold){entered();await new Promise(resolve=>release=resolve);}if(fail)throw new Error('Synthetic failure');await mockRenderer(request,output);}});
  const published=await store.generate(product,{},true),removed=await store.generate(product,{},true);await store.remove(removed.report.lookupCode);const saved=await store.generate(product,{},false);
  const paths=[['published',published],['removed',removed],['previews',saved]].map(([state,row])=>path.join(root,state,row.report.lookupCode,'bundle.json'));
  const bytes=await Promise.all(paths.map(filename=>readFile(filename))),before=allocations,seed='a'.repeat(48);
  const first=await store.preview(product,{lot:'PREVIEW'},{seed}),second=await store.preview(product,{lot:'EDITED'},{seed});assert.deepEqual(Object.keys(first).sort(),['label','svg']);assert.deepEqual(first,second);assert.match(first.svg,/AN-PREV-IEW0/);assert.equal(allocations,before);
  for(const request of requests.slice(-2)){assert.equal(request.seed,seed);assert.equal(request.lookupCode,'AN-PREV-IEW0');assert.ok(request.options.timeout>0&&request.options.timeout<=45000);}
  assert.deepEqual(await readdir(path.join(root,'staging')),[]);assert.equal(await readPublished(root,'AN-PREV-IEW0'),null);
  hold=true;const running=new Promise(resolve=>entered=resolve),flight=store.preview(product,{},{seed});await running;await assert.rejects(store.preview(product,{},{seed}),/Another report/);await assert.rejects(store.generate(product,{},true),/Another report/);await assert.rejects(store.restore(removed.report.lookupCode),/Another report/);release();await flight;hold=false;
  fail=true;await assert.rejects(store.preview(product,{},{seed}),/Synthetic failure/);assert.equal(store.busy,false);assert.deepEqual(await readdir(path.join(root,'staging')),[]);
  fail=false;await store.preview(product,{},{seed});await assert.rejects(store.preview(product,{},{seed:'invalid'}),/seed/);const renders=requests.length;await assert.rejects(store.preview(product,{},{seed,deadline:Date.now()-1}),/timed out/);assert.equal(requests.length,renders);assert.equal(store.busy,false);
  assert.deepEqual(await Promise.all(paths.map(filename=>readFile(filename))),bytes);assert.equal(allocations,before);assert.deepEqual(await readdir(path.join(root,'staging')),[]);
});

test('actual Python live preview renders current master from synthetic asset without a public result',async t=>{
  const root=await temporary(t),store=await createStore(root,{codeFactory:()=>{throw new Error('Preview must not allocate a code');}});
  const synthetic={...product,imagePath:path.join(project,'templates/coa/assets/sample-vial-product.png')};
  const value=await store.preview(synthetic,{client:'Synthetic fixture',lot:'LIVE-QA',received:'2026-11-07',reported:'2026-11-07'},{seed:'d'.repeat(48)});
  assert.equal(value.label,product.name);assert.match(value.svg,/<svg/);assert.doesNotMatch(value.svg,/<text\b|(?:href|src)="(?:https?:|file:)/i);assert.deepEqual(await readdir(path.join(root,'staging')),[]);
  for(const directory of ['published','previews','removed'])assert.deepEqual(await readdir(path.join(root,directory)),[]);assert.equal(await readPublished(root,'AN-PREV-IEW0'),null);
});

test('live preview rejects incomplete renderer output and always releases its staging and shared lock',async t=>{
  for(const kind of ['pdf','svg','bundle']){
    const root=await temporary(t),store=await createStore(root,{render:async(request,output)=>{await mockRenderer(request,output);await writeFile(path.join(output,kind==='bundle'?'bundle.json':'report.'+kind),kind==='bundle'?'{}':'invalid');}});
    await assert.rejects(store.preview(product,{},{seed:'f'.repeat(48)}),/Incomplete renderer output|Invalid published bundle/);assert.equal(store.busy,false);assert.deepEqual(await readdir(path.join(root,'staging')),[]);assert.deepEqual(await readdir(path.join(root,'previews')),[]);
  }
});

test('loopback studio enforces exact Host/Origin, run token, JSON/body bounds and opaque routes',async t=>{
  const root=await temporary(t), images=path.join(root,'images');await mkdir(images);await writeFile(path.join(images,'BPC-157 10mg.png'),png);
  const studio=await createStudio({images,store:path.join(root,'store'),authStore:path.join(root,'auth'),port:0,render:mockRenderer});t.after(()=>{studio.server.closeAllConnections();return new Promise(resolve=>studio.server.close(resolve));});
  assert.equal(studio.server.address().address,'127.0.0.1');const origin=studio.origin;const securedFetch=await fixtureFetch(origin);
  const session=await (await securedFetch(origin+'/admin/api/session')).json();const input={customerId:session.defaultCustomerId,productId:session.products[0].id,fields:{},publish:true};
  const post=(changes={},headers={})=>securedFetch(origin+'/admin/api/generate',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Studio-Token':session.token,...headers},body:JSON.stringify({...input,...changes})});
  const hostileHost=await new Promise((resolve,reject)=>{const request=http.get(origin+'/admin/api/session',{headers:{Host:'localhost:'+new URL(origin).port}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});assert.equal(hostileHost,403);
  assert.equal((await securedFetch(origin+'/admin/api/session',{headers:{Origin:'http://evil.invalid'}})).status,403);
  assert.equal((await post({}, {'X-Studio-Token':'bad'})).status,403);assert.equal((await post({}, {Origin:'http://evil.invalid'})).status,403);assert.equal((await post({}, {'Content-Type':'text/plain'})).status,415);
  assert.equal((await post({}, {'X-Studio-Token':'é'.repeat(64)})).status,403);assert.equal((await securedFetch(origin+'/admin/api/session')).status,200);
  assert.equal((await post({fields:{client:'x'.repeat(9000)}})).status,413);assert.equal((await post({productId:'../secret'})).status,400);assert.equal((await post({fields:{purity1:98}})).status,400);
  const response=await post();assert.equal(response.status,201);const bundle=await response.json();assert.equal(bundle.published,true);assert.equal((await securedFetch(origin+bundle.previewURL)).status,200);assert.equal((await (await securedFetch(origin+'/admin/api/history')).json()).length,1);
  assert.equal((await securedFetch(origin+'/admin/api/generate')).status,404);assert.equal((await securedFetch(origin+'/admin/images/'+encodeURIComponent('../secret'))).status,400);assert.equal((await securedFetch(origin+'/admin/bundles/published/'+bundle.report.lookupCode+'/private.json')).status,404);
  assert.equal((await securedFetch(origin+'/admin/api/session')).headers.get('access-control-allow-origin'),null);
});

test('public reader opt-in serves only exact immutable DTO/PDF/SVG and default/production expose no studio',async t=>{
  const root=await temporary(t);const store=await createStore(root,{render:mockRenderer,codeFactory:()=> 'AN-DDDD-4444'});await store.generate(product,{},true);
  const origin=await publicServer(t,root);const response=await fetch(origin+'/__reports/an-dddd-4444');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const dto=await response.json();assert.equal(dto.report.lookupCode,'AN-DDDD-4444');assert.ok(!JSON.stringify(dto).match(/private-fixture|never-public|synthetic-private|seed|provenance|imagePath/));
  for(const asset of ['report.svg','report.pdf']){const response=await fetch(origin+'/__reports/AN-DDDD-4444/'+asset);assert.equal(response.status,200);assert.ok(response.headers.get('content-security-policy'));assert.equal((await fetch(origin+'/__reports/AN-DDDD-4444/'+asset,{method:'HEAD'})).status,200);}
  assert.equal((await fetch(origin+'/coa/AN-DDDD-4444')).status,200);assert.match(await (await fetch(origin+'/verify')).text(),/assaynova-report-reader/);
  for(const pathname of ['/__reports','/__reports/','/__reports/AN-NONE-0000','/__reports/AN-DDDD-4444/private.json','/__reports/AN-DDDD-4444/%2e%2e%2fprivate.json','/conference/operator.js','/api/session','/api/history','/images/123'])assert.equal((await fetch(origin+pathname)).status,404,pathname);
  assert.equal((await fetch(origin+'/__reports/AN-DDDD-4444',{method:'POST'})).status,405);
  const normal=await publicServer(t,root,false);assert.equal((await fetch(normal+'/__reports/AN-DDDD-4444')).status,404);assert.equal((await fetch(normal+'/coa/AN-DDDD-4444')).status,404);assert.doesNotMatch(await (await fetch(normal+'/')).text(),/assaynova-report-reader/);
  const production=await publicServer(t,root,false,{NODE_ENV:'production'});assert.equal((await fetch(production+'/__reports/AN-DDDD-4444')).status,404);assert.doesNotMatch(await (await fetch(production+'/')).text(),/assaynova-report-reader/);
  const denied=spawn(process.execPath,['server.mjs','--no-accounts','--conference-reports'],{cwd:project,env:{...process.env,NODE_ENV:'production'},windowsHide:true,stdio:'ignore'});assert.notEqual(await new Promise(resolve=>denied.once('exit',resolve)),0);
  const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';try{await assert.rejects(createStudio({images:DEFAULT_IMAGES,store:root,port:0}),/disabled in production/);}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
});

test('renderer child timeout is bounded and leaves no published partial snapshot',async t=>{
  const root=await temporary(t),script=path.join(root,'slow.py');await writeFile(script,'import time\ntime.sleep(5)\n');
  const store=await createStore(root,{codeFactory:()=> 'AN-EEEE-5555',render:(request,output)=>runRenderer(request,output,{renderer:script,timeout:40})});
  const start=Date.now();await assert.rejects(store.generate(product,{},true),/timed out/);assert.ok(Date.now()-start<3000);assert.equal(await readPublished(root,'AN-EEEE-5555'),null);assert.equal((await store.history()).length,0);
});

test('real Python closed loop publishes distinct products and repeated runs, preserves IU/ml and PDF/SVG/JSON snapshots',async t=>{
  const root=await temporary(t),images=path.join(root,'images'),store=path.join(root,'store');await mkdir(images);
  const photo=await readFile(path.join(project,'templates','coa','assets','sample-vial-product.png'));
  await Promise.all(['BPC-157 10mg','HCG 5000IU','0.9% Benzyl Alcohol 10ml','Tesamorelin 10mg + Ipamorelin 5mg'].map(name=>writeFile(path.join(images,name+'.png'),photo)));
  const studio=await createStudio({images,store,authStore:path.join(root,'auth'),port:0});t.after(()=>{studio.server.closeAllConnections();return new Promise(resolve=>studio.server.close(resolve));});
  const securedFetch=await fixtureFetch(studio.origin);
  const origin=await publicServer(t,store),session=await (await securedFetch(studio.origin+'/admin/api/session')).json();const snapshots=[];
  for(const name of ['BPC-157 10mg','HCG 5000IU','0.9% Benzyl Alcohol 10ml','Tesamorelin 10mg + Ipamorelin 5mg','BPC-157 10mg']){
    const selected=session.products.find(row=>row.name===name),fields={lot:'QA-ONLY',received:'2026-11-05',reported:'2026-11-05',...(snapshots.length===4?{purity1:99.41,purity2:99.43}:{})};
    const response=await securedFetch(studio.origin+'/admin/api/generate',{method:'POST',headers:{Origin:studio.origin,'Content-Type':'application/json','X-Studio-Token':session.token},body:JSON.stringify({customerId:session.defaultCustomerId,productId:selected.id,fields,publish:true})});const generated=await response.json();assert.equal(response.status,201,generated.error);
    const dto=await (await fetch(origin+'/__reports/'+generated.report.lookupCode)).json();assert.equal(dto.label,name);assert.equal(dto.record.client,'Research Client');assert.equal(dto.record.contentUnit,selected.unit);assert.equal(dto.record.composition.length,selected.components.length);
    assert.equal((Math.round((Math.round(Number(dto.record.purity[0])*100)+Math.round(Number(dto.record.purity[1])*100))/2)/100).toFixed(2),dto.record.purity[2]);assert.ok(Math.abs(dto.record.chromatogram.reduce((sum,row)=>sum+row.area,0)-100)<1e-5);assert.ok(Math.abs(dto.record.chromatogram.filter(row=>row.kind==='target').reduce((sum,row)=>sum+row.area,0)-Number(dto.record.purity[2]))<1e-5);
    const pdf=Buffer.from(await (await fetch(origin+dto.assets.pdf)).arrayBuffer()),svg=await (await fetch(origin+dto.assets.svg)).text();assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.match(svg,/<svg/);assert.doesNotMatch(svg,/<text\b|(?:href|src)="(?:https?:|file:)/i);assert.equal((await fetch(origin+'/coa/'+dto.report.lookupCode)).status,200);
    const pdfPath=path.join(root,dto.report.lookupCode+'.pdf');await writeFile(pdfPath,pdf);snapshots.push({dto,pdf,svg,pdfPath});
  }
  assert.equal(new Set(snapshots.map(row=>row.dto.report.lookupCode)).size,5);assert.notDeepEqual(snapshots[0].dto.record.chromatogram,snapshots[1].dto.record.chromatogram);assert.notDeepEqual(snapshots[0].dto.record.chromatogram,snapshots[4].dto.record.chromatogram);assert.equal(snapshots[4].dto.record.purity[2],'99.42');
  const inspect=JSON.parse(execFileSync(PYTHON,['-B','-c','import json,sys; from pypdf import PdfReader; print(json.dumps([{ "pages":len((r:=PdfReader(p)).pages),"width":float(r.pages[0].mediabox.width),"height":float(r.pages[0].mediabox.height),"text":r.pages[0].extract_text()} for p in sys.argv[1:]]))',...snapshots.map(row=>row.pdfPath)],{encoding:'utf8',windowsHide:true}));
  for(const [index,proof] of inspect.entries()){assert.equal(proof.pages,1);assert.ok(Math.abs(proof.width-595.2756)<.1);assert.ok(Math.abs(proof.height-841.8898)<.1);assert.ok(proof.text.includes(snapshots[index].dto.report.lookupCode));assert.ok(proof.text.includes(snapshots[index].dto.record.purity[2]));assert.doesNotMatch(proof.text,/Sample report|demo report|conference|meeting example/i);}
  const restarted=await createStore(store);assert.equal((await restarted.history()).length,5);for(const snapshot of snapshots){assert.deepEqual((await readPublished(store,snapshot.dto.report.lookupCode)).record,snapshot.dto.record);assert.deepEqual(await readPublished(store,snapshot.dto.report.lookupCode,'report.pdf'),snapshot.pdf);}
});

test('default renderer honors the explicit Python interpreter and retains bounded CLI arguments',async t=>{
 const root=await temporary(t),output=path.join(root,'output'),request=path.join(root,'request.json'),script=path.join(root,'renderer-fixture.py');await mkdir(output);await writeFile(request,'{}');await writeFile(script,"import json,sys,pathlib\noutput=pathlib.Path(sys.argv[sys.argv.index('--output')+1])\n(output/'proof.json').write_text(json.dumps({'args':sys.argv[1:],'noBytecode':sys.flags.dont_write_bytecode}))\n");
 const old=process.env.ASSAYNOVA_PYTHON;
 try{process.env.ASSAYNOVA_PYTHON=path.join(root,'missing-interpreter');await assert.rejects(runRenderer(request,output,{renderer:script}),/could not start/);process.env.ASSAYNOVA_PYTHON=PYTHON;await runRenderer(request,output,{renderer:script});const proof=JSON.parse(await readFile(path.join(output,'proof.json'),'utf8'));assert.deepEqual(proof.args,['--request',request,'--output',output]);assert.equal(proof.noBytecode,1);}
 finally{if(old===undefined)delete process.env.ASSAYNOVA_PYTHON;else process.env.ASSAYNOVA_PYTHON=old;}
});
