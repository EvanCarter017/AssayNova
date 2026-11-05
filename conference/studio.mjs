import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_IMAGES, loadCatalog, catalogDTO } from './catalog.mjs';
import { DEFAULT_STORE, validCode } from './reader.mjs';
import { createStore, validateFields, validateComponents } from './store.mjs';

const headers = { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
const staticFiles = new Map([['/','operator.html'],['/operator.js','operator.js'],['/operator.css','operator.css']]);
function send(response,status,value,type='application/json; charset=utf-8', head=false) {
  response.writeHead(status,{...headers,'Content-Type':type});
  response.end(head ? undefined : Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
}
async function bodyJSON(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) { const error=new Error('Use application/json.'); error.status=415; throw error; }
  let bytes=0, body='';
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes>8192) { const error=new Error('Request exceeds 8192 bytes.'); error.status=413; throw error; }
    body += chunk.toString('utf8');
  }
  try { return JSON.parse(body); } catch { throw new Error('Invalid JSON.'); }
}
export async function createStudio({ images=DEFAULT_IMAGES, store=DEFAULT_STORE, port=4320, publicOrigin='http://127.0.0.1:4317', render, codeFactory }={}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Private report studio is disabled in production.');
  if (!Number.isInteger(port) || port<0 || port>65535) throw new Error('Invalid studio port.');
  const publicURL=new URL(publicOrigin);
  if (!['http:','https:'].includes(publicURL.protocol) || publicURL.username || publicURL.password || publicURL.pathname !== '/' || publicURL.search || publicURL.hash) throw new Error('Use a plain public origin.');
  const catalog=await loadCatalog(images), products=new Map(catalog.map(product=>[product.id,product]));
  const reports=await createStore(store,{render,codeFactory});
  const token=randomBytes(32).toString('hex');
  let origin;
  const server=http.createServer(async(request,response)=>{
    const host=new URL(origin).host;
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin) || (request.headers['sec-fetch-site'] && !['same-origin','none'].includes(request.headers['sec-fetch-site']))) { send(response,403,{error:'Origin or Host rejected.'}); return; }
    let pathname;
    try { pathname=decodeURIComponent(new URL(request.url,origin).pathname); } catch { send(response,400,{error:'Invalid URL.'}); return; }
    const mutating=request.method==='POST' && pathname==='/api/generate';
    if (mutating) {
      const supplied=request.headers['x-studio-token'];
      if (request.headers.origin !== origin || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied),Buffer.from(token))) { send(response,403,{error:'Run token required.'}); return; }
      try {
        const input=await bodyJSON(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key=>!['productId','fields','components','publish'].includes(key)) || typeof input.publish!=='boolean') throw new Error('Choose Preview or Generate and publish.');
        const selected=products.get(input.productId);
        if (!selected) throw new Error('Select a catalog product.');
        const components=validateComponents(input.components,selected.components);
        const product={...selected,components,unit:new Set(components.map(row=>row.unit)).size===1?components[0].unit:'mixed'};
        const result=await reports.generate(product,validateFields(input.fields),input.publish);
        send(response,201,{...result,publicURL:new URL('/coa/'+result.report.lookupCode,publicOrigin).href});
      } catch(error) { send(response,error.status || 400,{error:error.message}); }
      return;
    }
    if (!['GET','HEAD'].includes(request.method)) { response.setHeader('Allow','GET, HEAD'); send(response,405,{error:'Method not allowed.'}); return; }
    try {
      if (pathname==='/api/session') { send(response,200,{token,products:catalog.map(catalogDTO),publicOrigin},undefined,request.method==='HEAD'); return; }
      if (pathname==='/api/history') { send(response,200,await reports.history(),undefined,request.method==='HEAD'); return; }
      if (staticFiles.has(pathname)) {
        const file=staticFiles.get(pathname), type=file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8';
        send(response,200,await readFile(new URL(file,import.meta.url)),type,request.method==='HEAD'); return;
      }
      const image=/^\/images\/([a-f0-9]{20})$/.exec(pathname);
      if (image && products.has(image[1])) { send(response,200,await readFile(products.get(image[1]).imagePath),'image/png',request.method==='HEAD'); return; }
      const bundle=/^\/bundles\/(published|previews)\/(AN-[A-Z0-9]{4}-[A-Z0-9]{4})\/(report\.svg|report\.pdf)$/.exec(pathname);
      if (bundle && validCode(bundle[2])) {
        const base=await realpath(path.join(reports.root,bundle[1]));
        const file=await realpath(path.join(base,bundle[2],bundle[3]));
        if (path.dirname(path.dirname(file))!==base) throw new Error('Path rejected.');
        send(response,200,await readFile(file),bundle[3].endsWith('.pdf')?'application/pdf':'image/svg+xml',request.method==='HEAD'); return;
      }
      send(response,404,{error:'Not found.'});
    } catch { send(response,404,{error:'Not found.'}); }
  });
  server.requestTimeout=10000; server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{ server.once('error',reject); server.listen(port,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;resolve();}); });
  return {server,origin,store:reports.root};
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const option=(name,fallback)=>process.argv.find(arg=>arg.startsWith('--'+name+'='))?.slice(name.length+3) ?? fallback;
  try {
    const studio=await createStudio({images:option('images',DEFAULT_IMAGES),store:option('store',DEFAULT_STORE),publicOrigin:option('public-origin','http://127.0.0.1:4317')});
    console.log('Private report studio: '+studio.origin+'\nSynthetic data controls stay on this computer. Published bundles persist across restart.');
    const stop=()=>studio.server.close(()=>process.exit(0)); process.on('SIGINT',stop);process.on('SIGTERM',stop);
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
