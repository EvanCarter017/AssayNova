import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { validMailbox, validMailHost } from './mail-config.mjs';

export const GOOGLE_ORIGIN = 'https://assaynovalabs.com';
export const GOOGLE_CALLBACK = GOOGLE_ORIGIN + '/api/account/oauth/google/callback';
export const GOOGLE_AUTHORIZATION = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const unavailable = () => new Error('Google sign-in is unavailable. Try again.');
const hash = value => createHash('sha256').update(value).digest('hex');
const matchHash = (a,b) => /^[a-f0-9]{64}$/.test(a || '') && /^[a-f0-9]{64}$/.test(b || '') && timingSafeEqual(Buffer.from(a),Buffer.from(b));

// Closed bounded JSON grammar, including arrays and decoded duplicate keys.
export function parseGoogleJSON(source, maximum = 65536) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > maximum) throw unavailable();
  let index = 0, nodes = 0;
  const space = () => { while (/[\t\r\n ]/.test(source[index] || '\0')) index++; };
  function string() {
    const start = index++; let escaped = false;
    while (index < source.length) {
      const character = source[index++];
      if (!escaped && character === '"') { const result = JSON.parse(source.slice(start,index)); if (result.length > 4096 || !result.isWellFormed()) throw unavailable(); return result; }
      if (!escaped && character === '\\') escaped = true; else escaped = false;
    }
    throw unavailable();
  }
  function value(depth) {
    if (depth > 8 || ++nodes > 512) throw unavailable(); space();
    if (source[index] === '"') return string();
    if (source[index] === '{') {
      index++; const result = Object.create(null); let count = 0; space(); if (source[index] === '}') { index++; return result; }
      for (;;) { space(); if (source[index] !== '"' || ++count > 128) throw unavailable(); const key = string(); if (Object.hasOwn(result,key)) throw unavailable(); space(); if (source[index++] !== ':') throw unavailable(); result[key] = value(depth+1); space(); const next = source[index++]; if (next === '}') return result; if (next !== ',') throw unavailable(); }
    }
    if (source[index] === '[') {
      index++; const result = []; space(); if (source[index] === ']') { index++; return result; }
      for (;;) { if (result.length >= 32) throw unavailable(); result.push(value(depth+1)); space(); const next = source[index++]; if (next === ']') return result; if (next !== ',') throw unavailable(); }
    }
    for (const [literal,result] of [['true',true],['false',false],['null',null]]) if (source.startsWith(literal,index)) { index += literal.length; return result; }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (!number || !Number.isFinite(Number(number[0]))) throw unavailable(); index += number[0].length; return Number(number[0]);
  }
  try { const result = value(0); space(); if (index !== source.length) throw unavailable(); return result; } catch { throw unavailable(); }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function decode(value, maximum) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > maximum * 2) throw unavailable();
  const bytes = Buffer.from(value,'base64url'); if (bytes.length > maximum || bytes.toString('base64url') !== value) throw unavailable(); return bytes;
}
export function googleAuthorizationURL(config,{state,nonce,verifier}) {
  if (!config?.enabled || !/^[a-f0-9]{64}$/.test(state || '') || !/^[a-f0-9]{64}$/.test(nonce || '') || !/^[A-Za-z0-9_-]{43}$/.test(verifier || '')) throw unavailable();
  const url = new URL(GOOGLE_AUTHORIZATION);
  url.search = new URLSearchParams({client_id:config.clientId,redirect_uri:GOOGLE_CALLBACK,response_type:'code',scope:'openid email profile',state,nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'select_account'});
  return url.href;
}
async function boundedJSON(response,maximum) {
  if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > maximum || !response.body) throw unavailable();
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try { for (;;) { const {done,value} = await reader.read(); if (done) break; length += value.length; if (length > maximum) throw unavailable(); chunks.push(value); } }
  finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  return parseGoogleJSON(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,length)),maximum);
}
const profileName = value => {
  if (typeof value !== 'string' || !value.isWellFormed()) return '';
  let result = ''; for (const character of value.replace(/[\x00-\x1f\x7f]/g,' ')) { if (result.length + character.length > 100) break; result += character; } return result.trim();
};
export function createGoogleProvider({config,fetcher=fetch,clock=Date.now} = {}) {
  let cache = new Map(), cacheUntil = 0, lastFetch = -Infinity, fetching = null, stopping = false;
  const controllers = new Set(), pending = new Set();
  async function keys(signal,force=false) {
    if (!force && clock() < cacheUntil) return cache;
    if (fetching) return fetching;
    if (clock() - lastFetch < 30000) { if (clock() >= cacheUntil) throw unavailable(); return cache; }
    lastFetch = clock();
    fetching = (async()=>{
      const response = await fetcher(GOOGLE_JWKS,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)]),headers:{Accept:'application/json'}});
      const document = await boundedJSON(response,65536); if (!object(document) || !Array.isArray(document.keys) || !document.keys.length || document.keys.length > 32) throw unavailable();
      const next = new Map();
      for (const jwk of document.keys) {
        if (!object(jwk) || jwk.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256') || (jwk.use !== undefined && jwk.use !== 'sig') || typeof jwk.kid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(jwk.kid) || next.has(jwk.kid) || ['d','p','q','dp','dq','qi','oth'].some(key=>Object.hasOwn(jwk,key))) throw unavailable();
        const n = decode(jwk.n,512), e = decode(jwk.e,4); if (n.length < 256 || n[0] === 0 || !e.length || e[0] === 0) throw unavailable();
        const exponent = e.reduce((v,b)=>v*256+b,0); if (exponent < 3 || exponent % 2 !== 1) throw unavailable();
        const key = createPublicKey({key:{kty:'RSA',n:jwk.n,e:jwk.e},format:'jwk'}); if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048 || key.asymmetricKeyDetails.modulusLength > 4096) throw unavailable();
        next.set(jwk.kid,key);
      }
      const age = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get('cache-control') || '')?.[1] || 300);
      cache = next; cacheUntil = clock()+Math.max(30,Math.min(3600,age))*1000; return cache;
    })().finally(()=>{fetching=null;});
    return fetching;
  }
  async function verifiedToken(raw,{nonceHash,createdAt,signal}) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384) throw unavailable();
    const parts = raw.split('.'); if (parts.length !== 3) throw unavailable();
    const header = parseGoogleJSON(new TextDecoder('utf-8',{fatal:true}).decode(decode(parts[0],2048)),2048);
    if (!object(header) || header.alg !== 'RS256' || !/^[A-Za-z0-9._-]{1,128}$/.test(header.kid || '') || Object.keys(header).some(key=>!['alg','kid','typ'].includes(key)) || header.typ !== undefined && header.typ !== 'JWT') throw unavailable();
    let candidates = await keys(signal), key = candidates.get(header.kid);
    if (!key) { candidates = await keys(signal,true); key = candidates.get(header.kid); }
    const signature = decode(parts[2],512); if (!key || signature.length !== Math.ceil(key.asymmetricKeyDetails.modulusLength/8) || !verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key,signature)) throw unavailable();
    const claims = parseGoogleJSON(new TextDecoder('utf-8',{fatal:true}).decode(decode(parts[1],12288)),12288), now = Math.floor(clock()/1000);
    if (!object(claims) || !['accounts.google.com','https://accounts.google.com'].includes(claims.iss) || claims.aud !== config.clientId || claims.azp !== undefined && claims.azp !== config.clientId || typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(claims.sub) || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) || claims.exp <= now-60 || claims.iat > now+60 || claims.iat < Math.floor(createdAt/1000)-60 || claims.exp <= claims.iat || claims.exp-claims.iat > 7200 || claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now+60) || typeof claims.nonce !== 'string' || !matchHash(hash('nonce\0'+claims.nonce),nonceHash) || !validMailbox(claims.email) || claims.email.length > 160 || typeof claims.email_verified !== 'boolean') throw unavailable();
    const hd = typeof claims.hd === 'string' && validMailHost(claims.hd.toLowerCase()) ? claims.hd.toLowerCase() : '';
    return {subject:claims.sub,email:claims.email.toLowerCase(),emailVerified:claims.email_verified,name:profileName(claims.name),hd};
  }
  async function perform(input,controller) {
    const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(12000),...(input.signal?[input.signal]:[])]);
    const work = (async()=>{
      if (!/^[\x21-\x7e]{1,2048}$/.test(input.code || '') || !/^[A-Za-z0-9_-]{43}$/.test(input.verifier || '') || !Number.isSafeInteger(input.createdAt) || input.createdAt < 1 || !/^[a-f0-9]{64}$/.test(input.nonceHash || '')) throw unavailable();
      const response = await fetcher(GOOGLE_TOKEN,{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(5000)]),headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:input.code,client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:GOOGLE_CALLBACK,grant_type:'authorization_code',code_verifier:input.verifier})});
      const document = await boundedJSON(response,32768); if (!object(document) || typeof document.id_token !== 'string') throw unavailable();
      return verifiedToken(document.id_token,{...input,signal});
    })();
    let abort;
    try { return await Promise.race([work,new Promise((_,reject)=>{abort=()=>reject(unavailable()); if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});})]); }
    finally { signal.removeEventListener('abort',abort); }
  }
  return Object.freeze({
    authorization:input=>googleAuthorizationURL(config,input),
    exchange(input) {
      if (stopping || !config?.enabled || controllers.size >= 4) return Promise.reject(unavailable());
      const controller = new AbortController(); controllers.add(controller);
      const operation = perform(input,controller).catch(()=>{throw unavailable();}).finally(()=>{controllers.delete(controller);pending.delete(operation);}); pending.add(operation); return operation;
    },
    async close() { stopping=true; for(const controller of controllers)controller.abort(); await Promise.allSettled([...pending]); }
  });
}
