import { filterProducts } from './product-search.mjs';
import { createAdminI18n } from './admin-i18n.mjs';
import { createImportUI } from './import-ui.mjs';
const $=id=>document.getElementById(id);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const language=createAdminI18n({storage:()=>localStorage,browserLanguage:navigator.language});
const t=(key,values)=>language.t(key,values);
let session,selected,result,busy=false,historyRows=[],currentCustomerId='',catalogLoading=false,catalogRevision=0;
let importer,importing=false;
let statusState={key:'loading',error:false};
const today=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
for(const name of ['received','reported']) $('generate').elements.namedItem(name).value=today;
function renderStatus(){
  $('status').textContent=statusState.message!==undefined?language.error(statusState.message,statusState.fallback):t(statusState.key,statusState.values);
  $('status').classList.toggle('error',statusState.error);
}
function status(key,error=false,values={}){statusState={key,error,values};renderStatus();}
function statusError(message,fallback){statusState={message,fallback,error:true};renderStatus();}
function renderSelectionLanguage(){
  $('selected-name').textContent=selected?selected.name:t($('product').options.length===0?'noProduct':'chooseProduct');
}
function renderResultLanguage(){if(result)$('result-state').textContent=t(result.published?'publishedSnapshot':'privateSnapshot');}
function renderHistoryLanguage(){
  for(const button of $('history').querySelectorAll('[data-code]')){
    const row=historyRows.find(item=>item.lookupCode===button.dataset.code);
    if(row)button.setAttribute('aria-label',t('openHistory',{name:row.label,code:row.lookupCode}));
  }
}
function applyLanguage(){
  language.apply(document,'reportsTitle');
  document.querySelector('.brand span').textContent=t('admin');
  $('admin-language').value=language.locale;
  renderSelectionLanguage();renderResultLanguage();renderHistoryLanguage();renderStatus();
  importer?.applyLanguage();
}
function updateControls(){
  for(const control of document.querySelectorAll('main input,main select,main button'))if(!importer?.owns(control))control.disabled=busy||catalogLoading||importing||!session;
  $('customer').disabled=busy||importing||!session;
  for(const button of document.querySelectorAll('#generate button'))button.disabled=busy||catalogLoading||importing||!selected||!currentCustomerId;
}
function selectProduct(){
  selected=session.products.find(product=>product.id===$('product').value);
  renderSelectionLanguage();
  updateControls();
}
function filter(preferredId){
  const previous=typeof preferredId==='string'?preferredId:$('product').value,products=filterProducts(session.products,$('search').value);
  const chosen=products.some(product=>product.id===previous)?previous:products.length===1?products[0].id:'';
  $('product').innerHTML=(products.length>1&&!chosen?'<option value="" disabled selected data-i18n="chooseMatching">'+escape(t('chooseMatching'))+'</option>':'')+products.map(product=>`<option value="${product.id}">${escape(product.name)}</option>`).join('');
  $('product').value=chosen;
  $('count').textContent=`(${products.length}/${session.products.length})`;
  selectProduct();status(!products.length?'noMatches':chosen?'selectedReady':'chooseBelow');
}
function renderCustomers(){
  $('customer').innerHTML=session.customers.map(customer=>`<option value="${customer.id}">${escape(customer.name)}</option>`).join('');
  $('customer').value=currentCustomerId;
}
async function loadCustomer(id,reload=false){
  if(busy||importing||!session)return;
  const revision=++catalogRevision,previous=reload?$('product').value:'',query=reload?$('search').value:'';
  currentCustomerId=id;$('customer').value=id;catalogLoading=true;session.products=[];selected=undefined;
  $('product').innerHTML='';$('product').value='';$('search').value='';$('count').textContent='(0/0)';renderSelectionLanguage();updateControls();status('catalogLoading');
  try{
    const response=await adminFetch('/admin/api/catalog?customerId='+encodeURIComponent(id),{cache:'no-store'}),value=await response.json();
    if(revision!==catalogRevision)return;
    if(!response.ok||value.customer?.id!==id)throw new Error(value.error||'');
    session.products=value.products;session.customers=session.customers.map(row=>row.id===id?value.customer:row);
    renderCustomers();$('search').value=query;filter(previous);
  }catch(error){if(revision===catalogRevision)statusError(error.message,'catalogFallback');}
  finally{if(revision===catalogRevision){catalogLoading=false;updateControls();}}
}
async function adminFetch(url,options){
  const response=await fetch(url,options);
  if(response.status===401){location.replace('/admin');throw new Error('Administrator session expired. Unlock admin to continue.');}
  return response;
}
function showResult(value){
  result=value;$('empty').hidden=true;$('result').hidden=false;
  $('code').textContent=value.report.lookupCode;$('result-name').textContent=value.label;renderResultLanguage();
  $('paper').src=value.previewURL;$('paper').hidden=false;$('pdf').href=value.pdfURL;
  $('public-link').href=value.publicURL;$('public-link').hidden=!value.published;$('copy-code').hidden=!value.published;
  $('manual-label').hidden=true;$('code').focus();
}
async function history(){
  const response=await adminFetch('/admin/api/history',{cache:'no-store'});
  if(!response.ok)throw new Error('');
  historyRows=await response.json();
  $('history').innerHTML=historyRows.map(row=>`<button data-code="${escape(row.lookupCode)}">${escape(row.label)}<br><strong>${escape(row.lookupCode)}</strong> · ${escape(row.reported)}</button>`).join('')||'<p class="hint" data-i18n="historyEmpty">'+escape(t('historyEmpty'))+'</p>';
  renderHistoryLanguage();
}
$('history').addEventListener('click',event=>{
  const button=event.target.closest('[data-code]');if(!button)return;
  const code=button.dataset.code,row=historyRows.find(item=>item.lookupCode===code);if(!row)return;
  showResult({published:true,report:{lookupCode:code},label:row.label,previewURL:'/admin/bundles/published/'+code+'/report.svg',pdfURL:'/admin/bundles/published/'+code+'/report.pdf',publicURL:session.publicOrigin+'/coa/'+code});
});
$('search').addEventListener('input',filter);$('product').addEventListener('change',selectProduct);
$('customer').addEventListener('change',()=>loadCustomer($('customer').value));
$('reload-products').addEventListener('click',()=>loadCustomer(currentCustomerId,true));
$('admin-language').addEventListener('change',event=>language.setLocale(event.target.value));
importer=createImportUI({document,request:adminFetch,language,context:()=>!busy&&!catalogLoading&&session?{customerId:currentCustomerId,token:session.token}:null,setPending:value=>{importing=value;updateControls();},onConfirmed:value=>{session.customers=value.customers;session.products=value.products;currentCustomerId=value.customer.id;renderCustomers();$('search').value='';$('product').value='';filter();}});
language.subscribe(applyLanguage);applyLanguage();updateControls();
$('generate').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||catalogLoading||importing||!selected||!currentCustomerId)return;busy=true;
  const publish=event.submitter?.value==='publish';
  updateControls();
  status(publish?'publishing':'previewing');
  const fields={};
  for(const name of ['lot','received','reported','purity1','purity2']){const value=$('generate').elements.namedItem(name).value;fields[name]=name.startsWith('purity')&&value!==''?Number(value):value;}
  try{
    const response=await adminFetch('/admin/api/generate',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':session.token},body:JSON.stringify({customerId:currentCustomerId,productId:selected.id,fields,publish})});
    const value=await response.json();if(!response.ok)throw new Error(value.error||'');
    showResult(value);status(publish?'publishedReady':'previewReady');
    try{await history();}catch(error){statusError(error.message,'historyFallback');}
  }catch(error){statusError(error.message,'generateFallback');$('status').focus();}
  finally{busy=false;updateControls();}
});
$('copy-code').addEventListener('click',async()=>{
  if(!result)return;
  try{await navigator.clipboard.writeText(result.report.lookupCode);status('copied');}
  catch{$('manual-label').hidden=false;$('manual-copy').value=result.report.lookupCode;$('manual-copy').focus();$('manual-copy').select();}
});
try{
  const response=await adminFetch('/admin/api/session',{cache:'no-store'});if(!response.ok)throw new Error('');
  session=await response.json();currentCustomerId=session.defaultCustomerId;renderCustomers();filter();updateControls();
  if(session.catalogError)statusError(session.catalogError,'catalogFallback');else status('ready');
  try{await history();}catch(error){statusError(error.message,'historyFallback');}
}catch(error){statusError(error.message,'sessionFallback');}
$('logout').addEventListener('click',async()=>{
  if(!session)return;
  try{const response=await adminFetch('/admin/auth/logout',{method:'POST',headers:{'X-Studio-Token':session.token}});if(!response.ok)throw new Error('');session=null;location.replace('/admin');}
  catch(error){statusError(error.message,'logoutFallback');}
});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
