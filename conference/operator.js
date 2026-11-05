import { filterProducts } from './product-search.mjs';
const $=id=>document.getElementById(id);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let session,selected,result,busy=false;
const today=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
for(const name of ['received','reported']) $('generate').elements.namedItem(name).value=today;
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function selectProduct(){
  selected=session.products.find(product=>product.id===$('product').value);
  if(!selected){
    $('selected-name').textContent=$('product').options.length===0?'No matching product':'Choose a product';
    $('components').innerHTML='';
    for(const button of document.querySelectorAll('#generate button'))button.disabled=true;
    return;
  }
  $('selected-name').textContent=selected.name;
  for(const button of document.querySelectorAll('#generate button'))button.disabled=busy;
  $('components').innerHTML=selected.components.map((row,index)=>`<div class="component"><label>Component ${index+1}<input data-key="name" value="${escape(row.name)}" maxlength="64" required aria-label="Component ${index+1} name"></label><label>Nominal<input data-key="nominal" type="number" value="${row.nominal}" min="0.001" max="100000" step="any" required aria-label="Component ${index+1} nominal content"></label><label>Unit<select data-key="unit" aria-label="Component ${index+1} unit">${['mg','ml','IU'].map(unit=>`<option${unit===row.unit?' selected':''}>${unit}</option>`).join('')}</select></label></div>`).join('');
}
function filter(){
  const previous=$('product').value,products=filterProducts(session.products,$('search').value);
  const chosen=products.some(product=>product.id===previous)?previous:products.length===1?products[0].id:'';
  $('product').innerHTML=(products.length>1&&!chosen?'<option value="" disabled selected>Choose a matching product</option>':'')+products.map(product=>`<option value="${product.id}">${escape(product.name)}</option>`).join('');
  $('product').value=chosen;
  $('count').textContent=`(${products.length}/${session.products.length})`;
  selectProduct();
  status(!products.length?'No matching product or dose. Check the name / SKU, or clear the search.':chosen?'Product selected. Review the photo and composition before publishing.':'Choose a matching product below.');
}
async function adminFetch(url,options){const response=await fetch(url,options);if(response.status===401){location.replace('/admin');throw new Error('Administrator session expired. Unlock admin to continue.');}return response;}
function showResult(value){result=value;$('empty').hidden=true;$('result').hidden=false;$('code').textContent=value.report.lookupCode;$('result-name').textContent=value.label;$('result-state').textContent=value.published?'Published · immutable snapshot':'Preview only · not available to customer lookup';$('paper').src=value.previewURL;$('paper').hidden=false;$('pdf').href=value.pdfURL;$('public-link').href=value.publicURL;$('public-link').hidden=!value.published;$('copy-code').hidden=!value.published;$('manual-label').hidden=true;$('code').focus();}
async function history(){const response=await adminFetch('/admin/api/history',{cache:'no-store'});if(!response.ok)throw new Error('History could not be loaded.');const rows=await response.json();$('history').innerHTML=rows.map(row=>`<button data-code="${row.lookupCode}">${escape(row.label)}<br><strong>${row.lookupCode}</strong> · ${escape(row.reported)}</button>`).join('')||'<p class="hint">Published reports will stay here after restart.</p>';}
$('history').addEventListener('click',event=>{const button=event.target.closest('[data-code]');if(!button)return;const code=button.dataset.code;showResult({published:true,report:{lookupCode:code},label:button.textContent.split(code)[0],previewURL:'/admin/bundles/published/'+code+'/report.svg',pdfURL:'/admin/bundles/published/'+code+'/report.pdf',publicURL:session.publicOrigin+'/coa/'+code});});
$('search').addEventListener('input',filter);$('product').addEventListener('change',selectProduct);
$('generate').addEventListener('submit',async event=>{event.preventDefault();if(busy||!selected)return;busy=true;const publish=event.submitter?.value==='publish';for(const control of document.querySelectorAll('main input,main select,main button'))control.disabled=true;status(publish?'Generating and publishing a complete snapshot…':'Generating a private preview…');const fields={};for(const name of ['client','lot','received','reported','purity1','purity2']){const value=$('generate').elements.namedItem(name).value;fields[name]=name.startsWith('purity')&&value!==''?Number(value):value;}const components=[...$('components').querySelectorAll('.component')].map(row=>Object.fromEntries([...row.querySelectorAll('[data-key]')].map(input=>[input.dataset.key,input.dataset.key==='nominal'?Number(input.value):input.value])));try{const response=await adminFetch('/admin/api/generate',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':session.token},body:JSON.stringify({productId:selected.id,fields,components,publish})});const value=await response.json();if(!response.ok)throw new Error(value.error||'Report generation failed.');showResult(value);status(publish?'Published. Share the Lookup Code or customer link.':'Preview ready. Generate & publish creates a new Lookup Code.');await history();}catch(error){status(error.message,true);$('status').focus();}finally{busy=false;for(const control of document.querySelectorAll('main input,main select,main button'))control.disabled=false;for(const button of document.querySelectorAll('#generate button'))button.disabled=!selected;}});
$('copy-code').addEventListener('click',async()=>{if(!result)return;try{await navigator.clipboard.writeText(result.report.lookupCode);status('Lookup Code copied.');}catch{$('manual-label').hidden=false;$('manual-copy').value=result.report.lookupCode;$('manual-copy').focus();$('manual-copy').select();}});
try{const response=await adminFetch('/admin/api/session',{cache:'no-store'});if(!response.ok)throw new Error('Studio session unavailable.');session=await response.json();filter();status('Ready to create a report. Review the original photo and composition before publishing.');await history();}catch(error){status(error.message,true);}

$('logout').addEventListener('click',async()=>{if(!session)return;try{const response=await adminFetch('/admin/auth/logout',{method:'POST',headers:{'X-Studio-Token':session.token}});if(!response.ok)throw new Error('Logout could not be completed.');session=null;location.replace('/admin');}catch(error){status(error.message,true);}});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
