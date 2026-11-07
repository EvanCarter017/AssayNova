import { randomBytes, timingSafeEqual } from 'node:crypto';
import { digest } from './auth.mjs';
import { accountError, emailKey } from './errors.mjs';
import { loopback, accountHeaders } from './boundary.mjs';
import { createGoogleProvider, GOOGLE_ORIGIN } from './google-provider.mjs';
import { safeAccountNext } from '../dist/customer-account.js';

const invalid = () => accountError(400,'GOOGLE_FLOW_INVALID','Google sign-in could not be completed. Start again.');
const conflict = () => accountError(409,'GOOGLE_IDENTITY_CONFLICT','Sign in with an existing method, then link Google in Security.');
const same = (a,b) => /^[a-f0-9]{64}$/.test(a || '') && /^[a-f0-9]{64}$/.test(b || '') && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const secretHash = value => digest('browser\0'+value);
const purposeHash = (purpose,value) => digest(purpose+'\0'+value);
const callbackPath = '/api/account/oauth/google/callback';
export function googleCallbackBoundary(request,origins) {
  if (request.method !== 'GET' || request.url.split('?')[0] !== callbackPath || request.url.length > callbackPath.length+8193 || Number(request.headers['content-length']) > 0 || request.headers['transfer-encoding'] || !loopback(request.socket?.remoteAddress)) throw invalid();
  const count = (request.rawHeaders || []).filter((v,i)=>i%2===0 && v.toLowerCase()==='host').length;
  if (count !== 1 || request.headers.host !== new URL(GOOGLE_ORIGIN).host || !origins.includes(GOOGLE_ORIGIN) || request.headers['sec-fetch-mode'] !== undefined && request.headers['sec-fetch-mode'] !== 'navigate' || request.headers['sec-fetch-dest'] !== undefined && request.headers['sec-fetch-dest'] !== 'document') throw accountError(403,'REQUEST_REJECTED','Account request was rejected.');
}
export function parseGoogleCallback(raw) {
  const query=raw.slice(callbackPath.length+1), values=Object.create(null);
  if(raw[callbackPath.length]!=='?' || !query || query.length>8192)throw invalid();
  for(const pair of query.split('&')){
    const i=pair.indexOf('='); if(i<1)throw invalid(); const key=pair.slice(0,i);
    if(!['state','code','error','scope','authuser','prompt','hd','iss','error_description','error_uri'].includes(key) || Object.hasOwn(values,key))throw invalid();
    let value;try{value=decodeURIComponent(pair.slice(i+1).replaceAll('+',' '));}catch{throw invalid();}
    if(value.length>2048 || /[\x00-\x1f\x7f]/.test(value) || !value.isWellFormed())throw invalid(); values[key]=value;
  }
  if(!/^[a-f0-9]{64}$/.test(values.state || '') || Object.hasOwn(values,'code')===Object.hasOwn(values,'error') || values.code!==undefined && !/^[\x21-\x7e]{1,2048}$/.test(values.code) || values.error!==undefined && !/^[\x21-\x7e]{1,256}$/.test(values.error))throw invalid();
  return {state:values.state,code:values.code,error:values.error};
}
export function googleBrowserCookie(raw,port) {
  if(raw===undefined)return '';
  if(typeof raw!=='string' || raw.length>4096)throw invalid();
  const name='an_google_flow_'+port, values=raw.split(';').map(v=>v.trim()).filter(v=>v.split('=')[0].trim()===name);
  if(!values.length)return '';
  if(values.length!==1 || !new RegExp('^'+name+'=[A-Za-z0-9_-]{43}$').test(values[0]))throw invalid();
  const value=values[0].slice(name.length+1); if(Buffer.from(value,'base64url').toString('base64url')!==value)throw invalid();return value;
}
export const googleCookie = (port,value,age=600) => `an_google_flow_${port}=${value}; Path=/api/account/oauth/google; HttpOnly; SameSite=Lax; Max-Age=${age}; Secure`;
export const googleCallbackHeaders = Object.freeze({...accountHeaders,Location:'/google-signin'});

export function createGoogleFlows({db,auth,clock=Date.now,config={enabled:false},provider,rate,signupVerification=()=>null}={}) {
  const enabled=()=>!!config.enabled, client=enabled() ? provider || createGoogleProvider({config,clock}) : null;
  let stopping=false; const operations=new Set();
  const requireEnabled=()=>{if(!enabled() || stopping)throw accountError(404,'ACCOUNT_ROUTE_NOT_FOUND','Account page was not found.');};
  const account=(id)=>db.get('SELECT * FROM account_users WHERE id=?',id);
  const identity=(subject)=>db.get("SELECT * FROM account_identities WHERE provider='google' AND subject=?",subject);
  function limits(peer,action,userId) {
    const window=600000, max=action==='start'?10:40, globalMax=action==='start'?200:1000;
    rate([['oauth-'+action+'-peer',peer,max,window],['oauth-'+action+'-global','all',globalMax,window],...(userId?[['oauth-'+action+'-user',userId,5,window]]:[])]);
  }
  function invalidateUser(userId) {
    db.run('DELETE FROM account_google_flows WHERE initiating_user_id=? OR resolved_user_id=?',userId,userId);
    db.run('UPDATE account_sessions SET google_reauth_at=NULL,google_reauth_purpose=NULL WHERE user_id=?',userId);
  }
  function source(row,context) {
    if(row.intent==='reauth' && row.reauth_purpose!=='password_setup')throw invalid();
    if(row.intent==='login') {
      if(context?.user || !db.get('SELECT 1 FROM account_challenges WHERE token_hash=? AND expires_at>?',row.initiating_csrf_hash,clock()))throw invalid();
      if(context && !same(digest(context.csrf || ''),row.initiating_csrf_hash))throw invalid();
      return null;
    }
    const user=auth.google.current({id:row.initiating_user_id,security_version:row.expected_security_version,recovery_version:row.expected_recovery_version},{sessionHash:row.initiating_session_hash,csrfHash:row.initiating_csrf_hash});
    if(context && (!context.user || context.user.id!==user.id || !same(digest(context.session || ''),row.initiating_session_hash) || !same(digest(context.csrf || ''),row.initiating_csrf_hash)))throw invalid();
    return user;
  }
  function currentFlow(browser,status) {
    if(!browser)throw invalid(); const binding=secretHash(browser), row=db.get('SELECT * FROM account_google_flows WHERE browser_hash=?',binding);
    if(!row || !same(row.browser_hash,binding) || row.expires_at<=clock() || status && row.status!==status)throw invalid();return row;
  }
  async function start(intent,input,context) {
    requireEnabled();
    if(intent==='login' && context.user || intent!=='login' && !context.user)throw invalid();
    let user=context.user;
    if(intent==='link')user=await auth.google.verifyCurrentPassword(user,input.currentPassword,context);
    if(intent==='reauth' && (input.purpose!=='password_setup' || user.password_enabled!==0))throw invalid();
    const expected=intent==='reauth'?db.get("SELECT subject FROM account_identities WHERE user_id=? AND provider='google'",user.id)?.subject:null;
    if(intent==='reauth'&&!expected)throw invalid();
    return db.transaction(()=>{
      if(user)auth.google.current(user,{sessionHash:digest(context.session),csrfHash:digest(context.csrf)});
      else if(!db.get('SELECT 1 FROM account_challenges WHERE token_hash=? AND expires_at>?',digest(context.csrf),clock()))throw invalid();
      limits(context.peer,'start',intent==='login'?null:user.id);
      db.run('DELETE FROM account_google_flows WHERE state_hash IN(SELECT state_hash FROM account_google_flows WHERE expires_at<=? LIMIT 100)',clock());
      if(context.browser)db.run('DELETE FROM account_google_flows WHERE browser_hash=?',secretHash(context.browser));
      if(db.get('SELECT count(*) AS n FROM account_google_flows').n>=2048)throw accountError(429,'GOOGLE_BUSY','Google sign-in is busy. Try again shortly.',60);
      const browser=randomBytes(32).toString('base64url'), state=randomBytes(32).toString('hex'), nonce=randomBytes(32).toString('hex'), now=clock();
      db.run("INSERT INTO account_google_flows(state_hash,browser_hash,nonce_hash,intent,safe_next,initiating_user_id,initiating_session_hash,initiating_csrf_hash,expected_security_version,expected_recovery_version,expected_subject,reauth_purpose,created_at,expires_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'started')",purposeHash('state',state),secretHash(browser),purposeHash('nonce',nonce),intent,intent==='login'?safeAccountNext(input.next):'/account',user?.id??null,user?digest(context.session):null,digest(context.csrf),user?.security_version??null,user?.recovery_version??null,expected,intent==='reauth'?input.purpose:null,now,now+600000);
      return {browser,data:{url:client.authorization({state,nonce,verifier:browser})}};
    });
  }
  async function callback(input,browser,peer) {
    requireEnabled(); db.transaction(()=>limits(peer,'callback'));
    let row;
    try{row=currentFlow(browser,'started');if(!same(row.state_hash,purposeHash('state',input.state)))throw invalid();}catch{return {clearCookie:false};}
    if(input.error){db.run('DELETE FROM account_google_flows WHERE state_hash=?',row.state_hash);return {clearCookie:true};}
    try {
      db.transaction(()=>{source(row);const changed=db.run("UPDATE account_google_flows SET status='exchanging' WHERE state_hash=? AND status='started'",row.state_hash);if(changed.changes!==1)throw invalid();});
      const claims=await client.exchange({code:input.code,verifier:browser,nonceHash:row.nonce_hash,createdAt:row.created_at});
      if(stopping)throw invalid();
      db.transaction(()=>{
        const fresh=currentFlow(browser,'exchanging');source(fresh);
        if(!claims || typeof claims.subject!=='string' || !/^[\x21-\x7e]{1,255}$/.test(claims.subject) || typeof claims.emailVerified!=='boolean' || typeof claims.name!=='string' || claims.name.length>100 || /[\x00-\x1f\x7f]/.test(claims.name) || typeof claims.hd!=='string' || claims.hd.length>253)throw invalid();
        const email=emailKey(claims.email), mapped=identity(claims.subject), resolved=mapped?account(mapped.user_id):null;
        db.run("UPDATE account_google_flows SET status='ready',ready_at=?,subject=?,email=?,email_verified=?,name=?,hd=?,resolved_user_id=?,resolved_security_version=?,resolved_recovery_version=? WHERE state_hash=? AND status='exchanging'",clock(),claims.subject,email,claims.emailVerified?1:0,claims.name,claims.hd,resolved?.id??null,resolved?.security_version??null,resolved?.recovery_version??null,fresh.state_hash);
      });
      return {clearCookie:false};
    }catch{
      if(!stopping)db.run('DELETE FROM account_google_flows WHERE state_hash=?',row.state_hash);
      return {clearCookie:true};
    }
  }
  function status(browser,context) {
    requireEnabled();try{const row=currentFlow(browser,'ready');source(row,context);if(row.ready_at+180000<=clock())throw invalid();return {ready:true,intent:row.intent};}catch{return {ready:false,intent:null};}
  }
  function complete(browser,context) {
    requireEnabled(); db.transaction(()=>limits(context.peer,'complete'));
    try{return db.transaction(()=>{
      const row=currentFlow(browser,'ready');const user=source(row,context);if(row.ready_at+180000<=clock())throw invalid();
      let result;
      if(row.intent==='login') {
        const mapped=identity(row.subject); let owner;
        if(mapped) {
          if(mapped.user_id!==row.resolved_user_id)throw invalid();
          owner=auth.google.current({id:mapped.user_id,security_version:row.resolved_security_version,recovery_version:row.resolved_recovery_version});
          result=auth.google.issue(owner,context.csrf,{method:'google',grant:owner.password_enabled===0?'password_setup':null});
        } else {
          if(row.resolved_user_id || db.get('SELECT 1 FROM account_users WHERE email=?',row.email))throw conflict();
          if(db.get('SELECT count(*) AS n FROM account_users').n>=10000)throw accountError(429,'ACCOUNT_CAPACITY','Registration is busy. Try again later.',60);
          const id=randomBytes(16).toString('hex'), now=clock(), domain=row.email.split('@')[1], verified=row.email_verified===1 && (domain==='gmail.com' || row.hd===domain);
          db.run('INSERT INTO account_users(id,email,name,company,password_salt,password_hash,security_version,recovery_version,created_at,updated_at,email_verified_at,password_enabled) VALUES(?,?,?,\'\',?,?,1,1,?,?,?,0)',id,row.email,row.name,randomBytes(16).toString('hex'),randomBytes(32).toString('hex'),now,now,verified?now:null);
          db.run("INSERT INTO account_identities VALUES('google',?,?,?,?)",row.subject,id,now,now);owner=account(id);
          result=auth.google.issue(owner,context.csrf,{method:'google',grant:'password_setup'});
          const verification=verified?null:signupVerification(owner);result.data={...result.data,...(verification?{verification}:{})};
        }
      } else if(row.intent==='link') {
        if(user.password_enabled!==1 || row.created_at+300000<=clock())throw invalid();
        const mapped=identity(row.subject), existing=db.get("SELECT subject FROM account_identities WHERE provider='google' AND user_id=?",user.id);
        if(mapped&&mapped.user_id!==user.id || existing&&existing.subject!==row.subject)throw conflict();
        if(!mapped){db.run("INSERT INTO account_identities VALUES('google',?,?,?,?)",row.subject,user.id,clock(),clock());db.run('UPDATE account_users SET security_version=security_version+1 WHERE id=?',user.id);auth.google.securityChanged(user.id);db.run('DELETE FROM account_sessions WHERE user_id=?',user.id);result=auth.google.issue(account(user.id),context.csrf);}
        else result={data:{user:auth.google.user(user),csrfToken:context.csrf}};
      } else {
        if(row.intent!=='reauth' || row.reauth_purpose!=='password_setup')throw invalid();
        if(user.password_enabled!==0 || row.subject!==row.expected_subject || identity(row.subject)?.user_id!==user.id)throw invalid();
        db.run('UPDATE account_sessions SET google_reauth_at=?,google_reauth_purpose=? WHERE token_hash=?',clock(),row.reauth_purpose,row.initiating_session_hash);
        result={data:{user:auth.google.user(user),csrfToken:context.csrf}};
      }
      db.run('DELETE FROM account_google_flows WHERE state_hash=?',row.state_hash);
      result.data={...result.data,intent:row.intent,next:row.safe_next};return result;
    });}catch(error){if(browser)db.run('DELETE FROM account_google_flows WHERE browser_hash=?',secretHash(browser));throw error;}
  }
  function grant(user,context,purpose) {
    const fresh=auth.google.current(user,{sessionHash:digest(context.session),csrfHash:digest(context.csrf)}), session=db.get('SELECT google_reauth_at,google_reauth_purpose FROM account_sessions WHERE token_hash=?',digest(context.session));
    if(fresh.password_enabled!==0 || !session || session.google_reauth_purpose!==purpose || !Number.isSafeInteger(session.google_reauth_at) || session.google_reauth_at>clock() || session.google_reauth_at+300000<=clock())throw invalid();return fresh;
  }
  async function setup(user,input,context) {
    requireEnabled();grant(user,context,'password_setup');const password=await auth.prepareMailPassword(input.newPassword);
    return db.transaction(()=>{grant(user,context,'password_setup');limits(context.peer,'security',user.id);db.run('UPDATE account_users SET password_enabled=1,password_salt=?,password_hash=?,security_version=security_version+1,updated_at=? WHERE id=?',password.salt,password.hash,clock(),user.id);auth.google.securityChanged(user.id);db.run('DELETE FROM account_sessions WHERE user_id=?',user.id);return auth.google.issue(account(user.id),context.csrf);});
  }
  async function unlink(user,input,context) {
    requireEnabled();await auth.google.verifyCurrentPassword(user,input.currentPassword,context);
    return db.transaction(()=>{auth.google.current(user,{sessionHash:digest(context.session),csrfHash:digest(context.csrf)});limits(context.peer,'security',user.id);db.run("DELETE FROM account_identities WHERE user_id=? AND provider='google'",user.id);db.run('UPDATE account_users SET security_version=security_version+1 WHERE id=?',user.id);auth.google.securityChanged(user.id);db.run('DELETE FROM account_sessions WHERE user_id=?',user.id);return auth.google.issue(account(user.id),context.csrf);});
  }
  return Object.freeze({enabled,invalidateUser,start,status,complete,setup,unlink,
    callback(input,browser,peer){const operation=callback(input,browser,peer).finally(()=>operations.delete(operation));operations.add(operation);return operation;},
    async close(){stopping=true;await client?.close?.();await Promise.allSettled([...operations]);}
  });
}
