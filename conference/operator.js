import { createAdminI18n } from './admin-i18n.mjs';
import { createImportUI } from './import-ui.mjs';
import { createCatalogCorrectionUI, catalogPickerState } from './catalog-correction-ui.mjs';
import { createReportRemovalUI } from './report-removal-ui.mjs';
const $=id=>document.getElementById(id);
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const language=createAdminI18n({storage:()=>localStorage,browserLanguage:navigator.language});
const t=(key,values)=>language.t(key,values);
let session,selected,result,busy=false,currentCustomerId='',catalogLoading=false,catalogEpoch=0;
let importer,correction,reportLibrary,importing=false;
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
  $('selected-name').textContent=selected?selected.name:t(session&&!currentCustomerId?'noCustomers':$('product').options.length===0?'noProduct':'chooseProduct');
}
function renderResultLanguage(){if(result)$('result-state').textContent=t(result.removed?'removedSnapshot':result.published?'publishedSnapshot':'privateSnapshot');}
function applyLanguage(){
  language.apply(document,'reportsTitle');
  document.querySelector('.brand span').textContent=t('admin');
  $('admin-language').value=language.locale;
  renderSelectionLanguage();renderResultLanguage();reportLibrary?.applyLanguage();renderStatus();
  if(session&&currentCustomerId){const value=$('product').value,state=catalogPickerState(session.products,session.entries,$('search').value,value);renderProductOptions({...state,chosen:state.ready.some(product=>product.id===value)?value:'',requireChoice:!selected});}
  importer?.applyLanguage();correction?.applyLanguage();renderCatalogAction();
}
function updateControls(){
  for(const control of document.querySelectorAll('main input,main select,main button'))if(!importer?.owns(control))control.disabled=busy||catalogLoading||importing||!session;
  $('customer').disabled=busy||importing||!session||!currentCustomerId;
  for(const id of ['reload-products','catalog-manage','search','product'])$(id).disabled=busy||catalogLoading||importing||!session||!currentCustomerId;
  for(const button of document.querySelectorAll('#generate button'))button.disabled=busy||catalogLoading||importing||!selected||!currentCustomerId;
  importer?.refresh();correction?.refresh();reportLibrary?.refresh();renderCatalogAction();
}
function selectProduct(){
  selected=session.products.find(product=>product.id===$('product').value&&(!product.status||product.status==='ready'));
  if($('product').selectedOptions?.[0]?.disabled)selected=undefined;
  renderSelectionLanguage();
  updateControls();
}
function filter(preferredId){
  if(!currentCustomerId){selected=undefined;$('product').innerHTML='';$('product').value='';$('search').value='';$('count').textContent='(0/0)';renderSelectionLanguage();updateControls();status('emptyCustomers');return;}
  const previous=typeof preferredId==='string'?preferredId:$('product').value,state=catalogPickerState(session.products,session.entries,$('search').value,previous),products=state.ready,chosen=state.chosen;
  renderProductOptions(state);
  $('count').textContent=`(${products.length}/${session.products.length})`;
  selectProduct();status(!products.length?state.blocked.length?'catalogOnlyBlocked':'noMatches':chosen?'selectedReady':'chooseBelow');
}
function renderProductOptions({ready,blocked,chosen,requireChoice=false}){
  $('product').innerHTML=((ready.length>1||requireChoice&&ready.length)&&!chosen?'<option value="" disabled selected data-i18n="chooseMatching">'+escape(t('chooseMatching'))+'</option>':'')+ready.map(product=>`<option value="${escape(product.id)}">${escape(product.sku?product.sku+' · '+product.name:product.name)}</option>`).join('')+blocked.map(entry=>'<option disabled class="is-blocked" value="blocked-'+escape(entry.id)+'">'+escape(t('catalogMissingOption')+' · '+(entry.values?.sku||entry.raw?.sku||'')+' · '+(entry.values?.product||entry.raw?.product||''))+'</option>').join('');
  $('product').value=chosen;
}
function renderCatalogAction(){
  $('catalog-manage').textContent=t('resolveCatalogIssues',{count:(session?.entries||[]).filter(entry=>entry.status!=='ready').length});
}
function acceptCatalog(value){
  session.products=value.products||[];session.entries=value.entries||[];session.catalogRevision=value.catalogRevision||null;session.counts=value.counts;
}

function renderCustomers(){
  $('customer').innerHTML=session.customers.map(customer=>`<option value="${customer.id}">${escape(customer.name)}</option>`).join('')||'<option value="" data-i18n="noCustomers">'+escape(t('noCustomers'))+'</option>';
  $('customer').value=currentCustomerId;
}
async function loadCustomer(id,reload=false){
  if(busy||importing||!session||!id)return;
  const revision=++catalogEpoch,previous=reload?$('product').value:'',query=reload?$('search').value:'';
  correction?.close();currentCustomerId=id;$('customer').value=id;catalogLoading=true;session.products=[];session.entries=[];session.catalogRevision=null;selected=undefined;
  $('product').innerHTML='';$('product').value='';$('search').value='';$('count').textContent='(0/0)';renderSelectionLanguage();updateControls();status('catalogLoading');
  try{
    const response=await adminFetch('/admin/api/catalog?customerId='+encodeURIComponent(id),{cache:'no-store'}),value=await response.json();
    if(revision!==catalogEpoch)return;
    if(!response.ok||value.customer?.id!==id)throw new Error(value.error||'');
    acceptCatalog(value);session.customers=session.customers.map(row=>row.id===id?value.customer:row);
    renderCustomers();$('search').value=query;filter(previous);
  }catch(error){if(revision===catalogEpoch)statusError(error.message,'catalogFallback');}
  finally{if(revision===catalogEpoch){catalogLoading=false;updateControls();}}
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
  if(value.published)$('public-link').href=value.publicURL;else $('public-link').removeAttribute('href');
  $('public-link').hidden=!value.published;$('copy-code').hidden=!value.published;
  $('manual-label').hidden=true;$('code').focus();
}
async function history(){
  await reportLibrary.load();
}
function showSavedReport(row,state){const code=row.lookupCode;showResult({published:state==='published',removed:state==='removed',report:{lookupCode:code},label:row.label,previewURL:'/admin/bundles/'+state+'/'+code+'/report.svg',pdfURL:'/admin/bundles/'+state+'/'+code+'/report.pdf',publicURL:session.publicOrigin+'/coa/'+code});}
function clearUncertainReport({lookupCode}){
  if(result?.report.lookupCode!==lookupCode)return;
  result=null;$('result').hidden=true;$('empty').hidden=false;
  $('paper').hidden=true;$('paper').removeAttribute('src');
  for(const id of ['code','result-name','result-state'])$(id).textContent='';
  $('pdf').removeAttribute('href');$('public-link').removeAttribute('href');$('public-link').hidden=true;$('copy-code').hidden=true;
  $('manual-label').hidden=true;$('manual-copy').value='';
}
$('search').addEventListener('input',filter);$('product').addEventListener('change',selectProduct);
$('customer').addEventListener('change',()=>loadCustomer($('customer').value));
$('reload-products').addEventListener('click',()=>loadCustomer(currentCustomerId,true));
$('admin-language').addEventListener('change',event=>language.setLocale(event.target.value));
importer=createImportUI({document,request:adminFetch,language,context:()=>!busy&&!catalogLoading&&session?{customerId:currentCustomerId,token:session.token}:null,setPending:value=>{importing=value;updateControls();},onConfirmed:value=>{session.customers=value.customers;acceptCatalog(value);currentCustomerId=value.customer.id;renderCustomers();$('search').value='';$('product').value='';filter();}});
correction=createCatalogCorrectionUI({document,request:adminFetch,language,context:()=>!busy&&!catalogLoading&&!importing&&session?{customerId:currentCustomerId,customerName:session.customers.find(customer=>customer.id===currentCustomerId)?.name||currentCustomerId,token:session.token,customers:session.customers,entries:session.entries||[],catalogRevision:session.catalogRevision}:null,onSaved:value=>{const previous=selected?.id;acceptCatalog(value);if(value.customers)session.customers=value.customers;renderCustomers();filter(previous);},onBrandChanged:value=>{
  ++catalogEpoch;currentCustomerId=value.customer.id;acceptCatalog(value);session.customers=session.customers.map(row=>row.id===currentCustomerId?value.customer:row);renderCustomers();
  const state=catalogPickerState(session.products,session.entries,'');selected=undefined;$('search').value='';renderProductOptions({...state,chosen:'',requireChoice:true});$('count').textContent=`(${state.ready.length}/${session.products.length})`;renderSelectionLanguage();updateControls();status(state.ready.length?'chooseBelow':state.blocked.length?'catalogOnlyBlocked':'noMatches');
}});
reportLibrary=createReportRemovalUI({document,request:adminFetch,language,context:()=>!busy&&!catalogLoading&&!importing&&session?{token:session.token}:null,setPending:value=>{busy=value;updateControls();},onPreview:showSavedReport,onChanged:value=>{if(result?.report.lookupCode===value.lookupCode)showSavedReport(value,value.state);},onUncertain:clearUncertainReport});
$('catalog-manage').addEventListener('click',event=>correction.open(undefined,event.currentTarget));
language.subscribe(applyLanguage);applyLanguage();updateControls();
$('generate').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||catalogLoading||importing||!selected||!currentCustomerId)return;busy=true;
  const publish=event.submitter?.value==='publish';
  updateControls();
  status(publish?'publishing':'previewing');
  const fields={};
  for(const name of ['lot','received','reported','purity1','purity2']){const value=$('generate').elements.namedItem(name).value;fields[name]=name.startsWith('purity')&&value!==''?Number(value):value;}
  try{
    const response=await adminFetch('/admin/api/generate',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':session.token},body:JSON.stringify({customerId:currentCustomerId,productId:selected.id,fields,publish,...(session.catalogRevision?{catalogRevision:session.catalogRevision}:{})})});
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
  session=await response.json();session.entries=session.entries||[];session.catalogRevision=session.catalogRevision||null;currentCustomerId=session.defaultCustomerId;renderCustomers();filter();updateControls();
  if(session.catalogError)statusError(session.catalogError,'catalogFallback');else status(currentCustomerId?'ready':'emptyCustomers');
  try{await history();}catch(error){statusError(error.message,'historyFallback');}
  await importer.loadPending();
}catch(error){statusError(error.message,'sessionFallback');}
$('logout').addEventListener('click',async()=>{
  if(!session)return;
  try{const response=await adminFetch('/admin/auth/logout',{method:'POST',headers:{'X-Studio-Token':session.token}});if(!response.ok)throw new Error('');correction.close();session=null;location.replace('/admin');}
  catch(error){statusError(error.message,'logoutFallback');}
});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
