import { createGoogleFlows, googleBrowserCookie, googleCookie, googleCallbackBoundary, parseGoogleCallback, googleCallbackHeaders } from './google-flows.mjs';
import { createMailOutbox } from './mail-outbox.mjs';
import { createMailActions } from './mail-actions.mjs';
import { openAccountDatabase } from './database.mjs';
import { createAccountAuth } from './auth.mjs';
import { createAccountRequests } from './requests.mjs';
import { accountError, exactInput } from './errors.mjs';
import { accountHeaders, accountFailure, canonicalAccountPath, requestBoundary, customerCookies, accountBodyLimit, canonicalOrigin } from './boundary.mjs';

async function jsonBody(request, target) {
  if (typeof request.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'])) throw accountError(415, 'JSON_REQUIRED', 'Use a JSON account request.');
  const limit = accountBodyLimit(request.method, target), chunks = []; let bytes = 0, large = false;
  if (Number(request.headers['content-length']) > limit) { request.resume(); throw accountError(413, 'BODY_TOO_LARGE', 'Account request exceeds its size limit.'); }
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) { bytes += chunk.length; if (bytes > limit) { large = true; break; } chunks.push(chunk); }
  } catch { throw accountError(400, 'INVALID_JSON', 'Account request could not be read.'); }
  if (large) { request.resume(); throw accountError(413, 'BODY_TOO_LARGE', 'Account request exceeds its size limit.'); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes))); }
  catch { throw accountError(400, 'INVALID_JSON', 'Use a valid UTF-8 JSON account request.'); }
}
export async function createAccountHandler({ directory, origins, port, allowPrivate = false, production = false, projectRoot, clock = Date.now, authOptions = {}, mailOptions = {}, googleOptions = {} } = {}) {
  if (!Array.isArray(origins) || !origins.length || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid account HTTP configuration.');
  for (const origin of origins) if (production && canonicalOrigin(origin).protocol !== 'https:') throw new Error('Production accounts require HTTPS.'); else canonicalOrigin(origin);
  const db = await openAccountDatabase({ directory, projectRoot });
  const mail = createMailOutbox({ ...mailOptions, db, clock });
  let actions, google;
  const securityChanged = userId => { mail.invalidateUser(userId); google?.invalidateUser(userId); };
  const auth = createAccountAuth({ ...authOptions, db, clock, onSignup: user => actions.signup(user), onSecurityChange: securityChanged });
  actions = createMailActions({ db, auth, mail, clock, securityChanged });
  google = createGoogleFlows({ ...googleOptions, db, auth, clock, rate: mail.rate, signupVerification: user => actions.signup(user) });
  const requests = createAccountRequests({ db, clock, mail });
  const capabilities = data => ({ ...data, mail: { enabled: mail.enabled() }, google: { enabled: google.enabled() } });
  const cookie = (kind, value, age, secure) => `${kind === 'session' ? 'an_customer_' : 'an_customer_csrf_'}${port}=${value}; Path=/api/account; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  async function handle(request, response) {
    const head = request.method === 'HEAD';
    try {
      if (request.url.split('?')[0] === '/api/account/oauth/google/callback') {
        if (!google.enabled()) throw accountError(404,'ACCOUNT_ROUTE_NOT_FOUND','Account page was not found.');
        googleCallbackBoundary(request,origins);
        const result = await google.callback(parseGoogleCallback(request.url),googleBrowserCookie(request.headers.cookie,port),request.socket.remoteAddress);
        if(result.clearCookie)response.setHeader('Set-Cookie',googleCookie(port,'',0));
        response.writeHead(303,googleCallbackHeaders);response.end();return true;
      }
      const origin = requestBoundary(request, origins, allowPrivate), target = canonicalAccountPath(request.url), secure = production || origin.startsWith('https:');
      if (['GET', 'HEAD'].includes(request.method) && (Number(request.headers['content-length']) > 0 || request.headers['transfer-encoding'])) throw accountError(400, 'BODY_NOT_ALLOWED', 'This account request does not accept a body.');
      const tokens = customerCookies(request.headers.cookie, port);
      const send = (status, data, cookies) => { if (cookies) response.setHeader('Set-Cookie', cookies); response.writeHead(status, accountHeaders); response.end(head ? undefined : JSON.stringify(data)); };
      const setSession = result => [cookie('session', result.sessionToken, auth.cookieSeconds, secure), cookie('csrf', result.csrfToken, auth.cookieSeconds, secure)];
      const clear = () => [cookie('session', '', 0, secure), cookie('csrf', '', 0, secure)];
      if (target === '/api/account/session' && ['GET', 'HEAD'].includes(request.method)) {
        const result = auth.bootstrap(tokens, { peer: request.socket.remoteAddress });
        send(200, capabilities(result.data), [cookie('csrf', result.csrf, result.authenticated ? auth.cookieSeconds : auth.challengeSeconds, secure), ...(!result.authenticated ? [cookie('session', '', 0, secure)] : [])]); return true;
      }
      const googlePath = target.startsWith('/api/account/oauth/google/') || target === '/api/account/password/setup';
      if (googlePath) {
        if(!google.enabled())throw accountError(404,'ACCOUNT_ROUTE_NOT_FOUND','Account page was not found.');
        const browser=googleBrowserCookie(request.headers.cookie,port);
        if(target==='/api/account/oauth/google/status' && ['GET','HEAD'].includes(request.method)) { send(200,google.status(browser,{user:auth.session(tokens.session),session:tokens.session,csrf:tokens.csrf}));return true; }
        const paths = new Map([
          ['/api/account/oauth/google/start',['next']],['/api/account/oauth/google/link',['currentPassword']],['/api/account/oauth/google/reauth',['purpose']],
          ['/api/account/oauth/google/complete',[]],['/api/account/oauth/google/unlink',['currentPassword']],['/api/account/oauth/google/recovery-codes',[]],['/api/account/password/setup',['newPassword']]
        ]);
        if(!paths.has(target))throw accountError(404,'ACCOUNT_ROUTE_NOT_FOUND','Account page was not found.');
        if(request.method!=='POST')throw accountError(405,'METHOD_NOT_ALLOWED','Account request method was rejected.');
        const input=await jsonBody(request,target);exactInput(input,paths.get(target));
        const user=auth.csrf(tokens,request.headers['x-account-csrf']);
        const context={user,peer:request.socket.remoteAddress,session:tokens.session,csrf:tokens.csrf,browser};
        if(target.endsWith('/start') || target.endsWith('/link') || target.endsWith('/reauth')) {
          const intent=target.endsWith('/start')?'login':target.endsWith('/link')?'link':'reauth';
          const result=await google.start(intent,input,context);send(200,result.data,[googleCookie(port,result.browser)]);return true;
        }
        if(target.endsWith('/complete')) {
          try { const result=google.complete(browser,context);send(200,capabilities(result.data),[googleCookie(port,'',0),...(result.sessionToken?setSession(result):[])]); }
          catch(error){response.setHeader('Set-Cookie',googleCookie(port,'',0));throw error;}return true;
        }
        if(!user)throw accountError(401,'AUTH_REQUIRED','Sign in to continue.');
        if(target.endsWith('/recovery-codes')){send(200,google.regenerate(user,context));return true;}
        const result=target.endsWith('/setup')?await google.setup(user,input,context):await google.unlink(user,input,context);send(200,capabilities(result.data),setSession(result));return true;
      }
      const specs = new Map([
        ['/api/account/signup', ['POST', ['email', 'password', 'name', 'company'], ['email', 'password']]],
        ['/api/account/login', ['POST', ['email', 'password']]],
        ['/api/account/logout', ['POST', []]], ['/api/account/logout-all', ['POST', []]],
        ['/api/account/recover', ['POST', ['email', 'recoveryCode', 'newPassword']]],
        ['/api/account/password', ['POST', ['currentPassword', 'newPassword']]],
        ['/api/account/recovery-codes', ['POST', ['currentPassword']]],
        ['/api/account/profile', ['PATCH', ['name', 'company'], []]],
        ['/api/account/email/verification', ['POST', []]],
        ['/api/account/email/verify', ['POST', ['token']]],
        ['/api/account/password/reset-request', ['POST', ['email']]],
        ['/api/account/password/reset', ['POST', ['token', 'newPassword']]]
      ]);
      const notificationId = /^\/api\/account\/requests\/([a-f0-9]{32})\/notifications$/.exec(target)?.[1];
      if (notificationId) {
        if (request.method !== 'POST') throw accountError(405, 'METHOD_NOT_ALLOWED', 'Account request method was rejected.');
        const input = await jsonBody(request, target); exactInput(input, ['expectedRevision']); const user = auth.requireUser(tokens.session); auth.csrf(tokens, request.headers['x-account-csrf']);
        send(200, requests.notifications(user, notificationId, input, request.socket.remoteAddress)); return true;
      }
      const documentId = /^\/api\/account\/requests\/([a-f0-9]{32})$/.exec(target)?.[1];
      if (target === '/api/account/requests' || documentId) {
        if (['GET', 'HEAD'].includes(request.method)) { const user = auth.requireUser(tokens.session); send(200, documentId ? requests.get(user, documentId) : requests.list(user)); return true; }
        const allowed = documentId ? ['PUT', 'DELETE'] : ['POST'];
        if (!allowed.includes(request.method)) throw accountError(405, 'METHOD_NOT_ALLOWED', 'Account request method was rejected.');
        const input = await jsonBody(request, target);
        exactInput(input, request.method === 'POST' ? ['record', 'idempotencyKey'] : request.method === 'PUT' ? ['record', 'expectedRevision'] : ['expectedRevision']);
        const user = auth.requireUser(tokens.session); auth.csrf(tokens, request.headers['x-account-csrf']);
        if (request.method === 'POST') { const result = requests.create(user, input); send(result.status, result.data); }
        else send(200, request.method === 'PUT' ? requests.update(user, documentId, input) : requests.delete(user, documentId, input));
        return true;
      }
      const spec = specs.get(target);
      if (!spec) throw accountError(404, 'ACCOUNT_ROUTE_NOT_FOUND', 'Account page was not found.');
      if (request.method !== spec[0]) throw accountError(405, 'METHOD_NOT_ALLOWED', 'Account request method was rejected.');
      const input = await jsonBody(request, target); exactInput(input, spec[1], spec[2]);
      const preauth = ['/api/account/signup', '/api/account/login', '/api/account/recover', '/api/account/email/verify', '/api/account/password/reset-request', '/api/account/password/reset'].includes(target);
      const user = preauth ? auth.csrf(tokens, request.headers['x-account-csrf']) : auth.requireUser(tokens.session);
      if (!preauth) auth.csrf(tokens, request.headers['x-account-csrf']);
      const context = { peer: request.socket.remoteAddress, csrf: tokens.csrf, session: tokens.session, userId: user?.id || null };
      if (target === '/api/account/email/verify') { send(200, actions.verify(input, context)); return true; }
      if (target === '/api/account/password/reset-request') { send(202, actions.requestReset(input, context)); return true; }
      if (target === '/api/account/password/reset') { send(200, await actions.reset(input, context), clear()); return true; }
      if (target === '/api/account/signup' || target === '/api/account/login') {
        const result = await auth[target.endsWith('/signup') ? 'signup' : 'login'](input, context); send(target.endsWith('/signup') ? 201 : 200, capabilities(result.data), setSession(result)); return true;
      }
      if (target === '/api/account/recover') { send(200, await auth.recover(input, context), clear()); return true; }
      if (!user) throw accountError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
      if (target === '/api/account/logout' || target === '/api/account/logout-all') send(200, auth.logout(tokens, target.endsWith('/logout-all')), clear());
      else if (target === '/api/account/email/verification') send(200, actions.verification(user));
      else if (target === '/api/account/profile') send(200, capabilities(auth.profile(user, input)));
      else if (target === '/api/account/password') { const result = await auth.password(user, input, context); send(200, capabilities(result.data), setSession(result)); }
      else send(200, await auth.regenerate(user, input, context));
      return true;
    } catch (error) { if (!request.complete && !request.destroyed) request.resume(); accountFailure(response, error, head); return true; }
  }
  return { handle, startMail: () => mail.start(), pumpMail: () => mail.pump(), mailEnabled: mail.enabled, reportMailEnabled: mail.reportEnabled, reportMail: Object.freeze({ reportEnabled: mail.reportEnabled, reportStatus: mail.reportStatus, admitReport: mail.admitReport }), stopMail: () => mail.stop(), async close() { await Promise.all([mail.stop(),google.close()]); db.close(); } };
}
