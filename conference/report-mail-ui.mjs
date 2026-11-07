const validCode = value => typeof value === 'string' && /^AN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value);
const states = new Set(['not_requested','not_configured','backpressure','unavailable','queued','retrying','accepted','failed','expired','canceled']);
export function createReportMailUI({ document, request, language, context, setPending, timeout = 15000 }) {
  const $ = id => document.getElementById(id);
  let code = null, intent = null, revision = 0, pending = false, controller = null, state = '', uncertain = false;
  function applyLanguage() { $('notice-status').textContent = state ? language.t(state === 'accepted' ? 'noticeAccepted' : state === 'queued' || state === 'retrying' ? 'noticeQueued' : uncertain ? 'noticeUncertain' : ['failed','expired','canceled'].includes(state) ? 'noticeFailed' : 'noticeUnavailable') : ''; }
  function refresh() {
    const current = context(); $('report-notice').hidden = !code || !current?.enabled;
    for (const id of ['notice-email','notice-confirm','notice-send']) $(id).disabled = pending || !!current?.blocked || !current || ['queued','retrying','accepted','failed','expired','canceled'].includes(state);
    $('notice-refresh').disabled = pending || !!current?.blocked || !current;
    $('notice-email').readOnly = !!intent;
    $('report-notice').setAttribute('aria-busy', String(pending)); applyLanguage();
  }
  function clear() { const wasPending = pending; revision++; controller?.abort(); controller = null; pending = false; code = null; intent = null; state = ''; uncertain = false; $('notice-email').value = ''; $('notice-confirm').checked = false; if (wasPending) setPending(false); refresh(); }
  function select(value) { clear(); if (value?.published && !value.removed && validCode(value.report?.lookupCode)) code = value.report.lookupCode; refresh(); }
  async function send() {
    const current = context(); if (pending || !code || !current?.enabled || current.blocked || !$('notice-confirm').checked) return;
    if (!intent) { const recipientEmail = $('notice-email').value; if (typeof recipientEmail !== 'string' || recipientEmail.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipientEmail)) { state = 'unavailable'; refresh(); $('notice-email').focus(); return; } intent = Object.freeze({ code, recipientEmail, token: current.token }); }
    if (intent.code !== code || intent.token !== current.token) { clear(); return; }
    const frozen = intent, ticket = revision; pending = true; uncertain = false; controller = new AbortController(); const active = controller;
    setPending(true); refresh(); let timer;
    try {
      const value = await Promise.race([(async()=>{ const response = await request('/admin/api/reports/' + frozen.code + '/notification', { method:'POST', cache:'no-store', signal:active.signal, headers:{'Content-Type':'application/json','X-Studio-Token':frozen.token}, body:JSON.stringify({recipientEmail:frozen.recipientEmail,confirm:true}) }); const value = await response.json(); if (!response.ok || !states.has(value.state) || Object.keys(value).length !== 1) throw new Error(); return value; })(), new Promise((_,reject)=>{timer=setTimeout(()=>{active.abort();reject(new Error());},timeout);})]);
      if (ticket !== revision || context()?.token !== frozen.token || code !== frozen.code) return;
      state = value.state; if (['queued','retrying','accepted','failed','expired','canceled'].includes(state)) { $('notice-email').value = ''; $('notice-confirm').checked = false; } else $('notice-email').value = frozen.recipientEmail;
    } catch { if (ticket === revision && context()?.token === frozen.token && code === frozen.code) { state = 'unavailable'; uncertain = true; } }
    finally { clearTimeout(timer); if (ticket === revision) { pending = false; controller = null; setPending(false); refresh(); } }
  }
  $('notice-send').addEventListener('click',send);
  $('notice-refresh').addEventListener('click',async()=>{
    const current=context(),selected=code,ticket=revision;if(pending||!selected||!current?.enabled||current.blocked)return;
    pending=true;controller=new AbortController();const active=controller;setPending(true);refresh();let timer;
    try { const value=await Promise.race([(async()=>{const response=await request('/admin/api/reports/'+selected+'/notification',{cache:'no-store',signal:active.signal});const value=await response.json();if(!response.ok||!states.has(value.state)||Object.keys(value).length!==1)throw new Error();return value;})(),new Promise((_,reject)=>{timer=setTimeout(()=>{active.abort();reject(new Error());},timeout);})]);if(ticket===revision&&context()?.token===current.token&&selected===code){state=value.state;uncertain=false;} }
    catch { if(ticket===revision){state='unavailable';uncertain=true;} }
    finally { clearTimeout(timer);if(ticket===revision){pending=false;controller=null;setPending(false);refresh();} }
  });
  return Object.freeze({ select, clear, refresh, applyLanguage, send });
}
