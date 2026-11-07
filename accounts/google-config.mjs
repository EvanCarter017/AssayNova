import { readPrivateMailFile } from './mail-config.mjs';
import { GOOGLE_ORIGIN, parseGoogleJSON } from './google-provider.mjs';
import { loopback } from './boundary.mjs';
const off = () => Object.freeze({enabled:false});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value,keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
const metadataURL = value => { try { const url=new URL(value);return typeof value==='string' && value.length<=2048 && !/[\x00-\x20\x7f]/.test(value) && ['https:','http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } };
export async function loadGoogleConfig({filename=process.env.ASSAYNOVA_GOOGLE_CONFIG_FILE,accountOptions,bindAddress,projectRoot,reportDirectory,adminAuthDirectory} = {}) {
  if (!filename) return off();
  try {
    const options={projectRoot,forbidden:[accountOptions?.directory,reportDirectory,adminAuthDirectory]};
    const document=parseGoogleJSON(new TextDecoder('utf-8',{fatal:true}).decode(await readPrivateMailFile(filename,16384,options)),16384);
    if(!exact(document,['version','enabled','publicOrigin','clientFile']) || document.version!==1 || typeof document.enabled!=='boolean')throw Error();
    if(!document.enabled){if(document.publicOrigin!==null || document.clientFile!==null)throw Error();return off();}
    if(document.publicOrigin!==GOOGLE_ORIGIN || accountOptions?.mode!=='authority' || accountOptions.allowPrivate || accountOptions.origins?.length!==1 || accountOptions.origins[0]!==GOOGLE_ORIGIN || !loopback(bindAddress))throw Error();
    const file=parseGoogleJSON(new TextDecoder('utf-8',{fatal:true}).decode(await readPrivateMailFile(document.clientFile,65536,options)));
    if(!exact(file,['web']) || !object(file.web))throw Error();
    const web=file.web, known=['client_id','project_id','auth_uri','token_uri','auth_provider_x509_cert_url','client_secret','redirect_uris','javascript_origins'];
    if(Object.keys(web).some(key=>!known.includes(key)) || typeof web.client_id!=='string' || !/^[A-Za-z0-9._-]{1,240}\.apps\.googleusercontent\.com$/.test(web.client_id) || typeof web.client_secret!=='string' || !/^[A-Za-z0-9_-]{8,512}$/.test(web.client_secret))throw Error();
    for(const key of ['project_id','auth_uri','token_uri','auth_provider_x509_cert_url'])if(web[key]!==undefined && (typeof web[key]!=='string' || web[key].length>2048 || /[\x00-\x20\x7f]/.test(web[key])))throw Error();
    for(const key of ['auth_uri','token_uri','auth_provider_x509_cert_url'])if(web[key]!==undefined && !metadataURL(web[key]))throw Error();
    for(const key of ['redirect_uris','javascript_origins'])if(web[key]!==undefined && (!Array.isArray(web[key]) || web[key].some(value=>!metadataURL(value))))throw Error();
    return Object.freeze({enabled:true,publicOrigin:GOOGLE_ORIGIN,clientId:web.client_id,clientSecret:web.client_secret});
  } catch { throw new Error('Google sign-in configuration is unavailable.'); }
}
