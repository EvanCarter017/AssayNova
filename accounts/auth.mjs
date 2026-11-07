import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { accountError, emailKey, text, validUnicode } from './errors.mjs';

const nativeDerive = promisify(scrypt);
const cost = Object.freeze({ N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 });
const tokenPattern = /^[a-f0-9]{64}$/;
export const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const id = () => randomBytes(16).toString('hex');
const invalid = () => accountError(401, 'INVALID_CREDENTIALS', 'Email or password was not accepted.');
export const validPassword = value => validUnicode(value) && Array.from(value).length >= 15 && Array.from(value).length <= 128 && Buffer.byteLength(value, 'utf8') <= 512;
export function requirePassword(value) { if (!validPassword(value)) throw accountError(400, 'INVALID_PASSWORD', 'Use 15 to 128 characters, at most 512 UTF-8 bytes.'); return value; }
export const safeUser = row => ({ id: row.id, email: row.email, emailVerified: Number.isSafeInteger(row.email_verified_at) && row.email_verified_at > 0, name: row.name, company: row.company, passwordEnabled: row.password_enabled !== 0, googleLinked: !!row.google_linked });
const sameToken = (a, b) => typeof a === 'string' && typeof b === 'string' && tokenPattern.test(a) && tokenPattern.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createAccountAuth({ db, clock = Date.now, derive = nativeDerive, kdfLimit = 2, absoluteMs = 7 * 86400000, idleMs = 86400000, challengeMs = 600000, challengePeerLimit = 20, challengeGlobalLimit = 512, rateWindowMs = 900000, identityLimit = 20, peerLimit = 200, globalLimit = 1000, onSignup = () => null, onSecurityChange = () => {} } = {}) {
  if (typeof clock !== 'function' || ![kdfLimit, absoluteMs, idleMs, challengeMs, challengePeerLimit, challengeGlobalLimit, rateWindowMs, identityLimit, peerLimit, globalLimit].every(value => Number.isSafeInteger(value) && value > 0) || kdfLimit > 2) throw new Error('Invalid account security limits.');
  let active = 0;
  async function hashPassword(password, salt) {
    if (active >= kdfLimit) throw accountError(429, 'AUTH_BUSY', 'Another sign-in operation is being processed. Try again shortly.', 1);
    active++;
    try { return Buffer.from(await derive(Buffer.from(password, 'utf8'), Buffer.from(salt, 'hex'), 32, cost)); }
    finally { active--; }
  }
  function admit(buckets, windowMs) {
    const now = clock();
    db.transaction(() => {
      db.run('DELETE FROM account_rates WHERE updated_at<?', now - 2 * Math.max(rateWindowMs, challengeMs));
      for (const [scope, value, maximum] of buckets) {
        const key = digest(scope + '\0' + value), old = db.get('SELECT * FROM account_rates WHERE bucket_hash=?', key);
        if (old && now - old.window_start < windowMs && old.count >= maximum) throw accountError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', Math.max(1, Math.ceil((old.window_start + windowMs - now) / 1000)));
        if (!old && db.get('SELECT count(*) AS n FROM account_rates').n >= 4096) throw accountError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', 60);
        if (!old || now - old.window_start >= windowMs) db.run('INSERT INTO account_rates VALUES(?,?,1,?) ON CONFLICT(bucket_hash) DO UPDATE SET window_start=excluded.window_start,count=1,updated_at=excluded.updated_at', key, now, now);
        else db.run('UPDATE account_rates SET count=count+1,updated_at=? WHERE bucket_hash=?', now, key);
      }
    });
  }
  function rate(peer, identity) { admit([['global', 'all', globalLimit], ['peer', peer, peerLimit], ['identity', identity, identityLimit]], rateWindowMs); }
  function sessionHash(hash, touch = true) {
    if (typeof hash !== 'string' || !tokenPattern.test(hash)) return null;
    const row = db.get('SELECT u.*,s.csrf_hash AS session_csrf,s.security_version AS session_version,s.last_seen AS session_seen,s.expires_at AS session_expires,s.auth_method AS session_method,s.google_reauth_at AS session_reauth_at,s.google_reauth_purpose AS session_reauth_purpose FROM account_sessions s JOIN account_users u ON u.id=s.user_id WHERE s.token_hash=?', hash);
    if (!row) return null;
    if ((row.session_reauth_at === null) !== (row.session_reauth_purpose === null) || row.security_version !== row.session_version || clock() >= row.session_expires || clock() - row.session_seen >= idleMs) { db.run('DELETE FROM account_sessions WHERE token_hash=?', hash); return null; }
    if (touch) db.run('UPDATE account_sessions SET last_seen=? WHERE token_hash=?', clock(), hash);
    return row;
  }
  function session(raw, touch = true) { return typeof raw === 'string' && tokenPattern.test(raw) ? sessionHash(digest(raw), touch) : null; }
  function publicUser(row) { return safeUser({ ...row, google_linked: !!db.get("SELECT 1 FROM account_identities WHERE user_id=? AND provider='google'",row.id) }); }
  function bootstrap(tokens, { peer = 'unknown' } = {}) {
    const user = session(tokens.session);
    let csrf = tokens.csrf;
    if (user) {
      if (!tokenPattern.test(csrf || '') || digest(csrf) !== user.session_csrf) { csrf = token(); db.run('UPDATE account_sessions SET csrf_hash=? WHERE token_hash=?', digest(csrf), digest(tokens.session)); }
      return { data: { authenticated: true, user: publicUser(user), csrfToken: csrf }, csrf, authenticated: true };
    }
    const now = clock();
    db.run('DELETE FROM account_challenges WHERE expires_at<=?', now);
    if (!tokenPattern.test(csrf || '') || !db.get('SELECT 1 FROM account_challenges WHERE token_hash=? AND expires_at>?', digest(csrf), now)) {
      admit([['challenge-global', 'all', challengeGlobalLimit], ['challenge-peer', peer, challengePeerLimit]], challengeMs);
      if (db.get('SELECT count(*) AS n FROM account_challenges').n >= 2048) throw accountError(429, 'RATE_LIMITED', 'Sign-in is busy. Try again shortly.', 60);
      csrf = token(); db.run('INSERT INTO account_challenges VALUES(?,?)', digest(csrf), now + challengeMs);
    }
    return { data: { authenticated: false, user: null, csrfToken: csrf }, csrf, authenticated: false };
  }
  function csrf(tokens, supplied) {
    if (!sameToken(tokens.csrf, supplied)) throw accountError(403, 'CSRF_REJECTED', 'Refresh the account page and try again.');
    const user = session(tokens.session);
    if (user) { if (digest(tokens.csrf) !== user.session_csrf) throw accountError(403, 'CSRF_REJECTED', 'Refresh the account page and try again.'); return user; }
    if (!db.get('SELECT 1 FROM account_challenges WHERE token_hash=? AND expires_at>?', digest(tokens.csrf), clock())) throw accountError(403, 'CSRF_REJECTED', 'Refresh the account page and try again.');
    return null;
  }
  function requireUser(raw) { const user = session(raw); if (!user) throw accountError(401, 'AUTH_REQUIRED', 'Sign in to continue.'); return user; }
  function current(snapshot, recovery = false) {
    const row = db.get('SELECT * FROM account_users WHERE id=?', snapshot.id);
    if (!row || row.security_version !== snapshot.security_version || row.password_hash !== snapshot.password_hash || row.password_enabled !== snapshot.password_enabled || (recovery && row.recovery_version !== snapshot.recovery_version)) throw accountError(409, 'ACCOUNT_CHANGED', 'Account security changed. Sign in again.');
    return row;
  }
  function issue(user, oldCsrf, { method = 'password', grant = null } = {}) {
    const now = clock();
    db.run('DELETE FROM account_sessions WHERE expires_at<=? OR last_seen<=?', now, now - idleMs);
    const count = db.get('SELECT count(*) AS n FROM account_sessions WHERE user_id=?', user.id).n;
    if (count >= 32) db.run('DELETE FROM account_sessions WHERE token_hash IN (SELECT token_hash FROM account_sessions WHERE user_id=? ORDER BY last_seen,token_hash LIMIT ?)', user.id, count - 31);
    if (db.get('SELECT count(*) AS n FROM account_sessions').n >= 8192) throw accountError(429, 'SESSIONS_BUSY', 'Sign-in is busy. Try again shortly.', 60);
    const sessionToken = token(), csrfToken = token();
    if (!['password','google'].includes(method) || grant !== null && grant !== 'password_setup') throw new Error('Invalid session provenance.');
    db.run('INSERT INTO account_sessions(token_hash,user_id,csrf_hash,security_version,created_at,last_seen,expires_at,auth_method,google_reauth_at,google_reauth_purpose) VALUES(?,?,?,?,?,?,?,?,?,?)', digest(sessionToken), user.id, digest(csrfToken), user.security_version, now, now, now + absoluteMs, method, grant ? now : null, grant);
    if (tokenPattern.test(oldCsrf || '')) db.run('DELETE FROM account_challenges WHERE token_hash=?', digest(oldCsrf));
    return { sessionToken, csrfToken, data: { user: publicUser(user), csrfToken } };
  }
  async function verifyPassword(snapshot, password) {
    const enabled = snapshot && snapshot.password_enabled !== 0;
    const actual = await hashPassword(password, enabled ? snapshot.password_salt : '00'.repeat(16));
    const expected = Buffer.from(enabled ? snapshot.password_hash : '00'.repeat(32), 'hex');
    if (!enabled || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  }
  return {
    session, bootstrap, csrf, requireUser,
    google: Object.freeze({
      user: publicUser, issue, securityChanged: onSecurityChange,
      current(snapshot, binding = {}) {
        const row = db.get('SELECT * FROM account_users WHERE id=?',snapshot.id);
        if (!row || row.security_version !== snapshot.security_version || row.recovery_version !== snapshot.recovery_version) throw accountError(409,'ACCOUNT_CHANGED','Account security changed. Sign in again.');
        if (binding.sessionHash) { const session = sessionHash(binding.sessionHash,false); if (!session || session.id !== row.id || binding.csrfHash && session.session_csrf !== binding.csrfHash) throw accountError(409,'ACCOUNT_CHANGED','Account security changed. Sign in again.'); }
        return row;
      },
      async verifyCurrentPassword(user,password,context) { requirePassword(password); rate(context.peer,user.email); await verifyPassword(user,password); const result = requireUser(context.session); current(user,true); if(result.id!==user.id)throw invalid(); return result; }
    }),
    async prepareMailPassword(password) { requirePassword(password); const salt = randomBytes(16).toString('hex'); return { salt, hash: (await hashPassword(password, salt)).toString('hex') }; },
    cookieSeconds: Math.floor(absoluteMs / 1000), challengeSeconds: Math.floor(challengeMs / 1000),
    async signup(input, context) {
      const email = emailKey(input.email), password = requirePassword(input.password), name = text(input.name ?? '', 100), company = text(input.company ?? '', 160);
      rate(context.peer, email);
      const salt = randomBytes(16).toString('hex'), hash = (await hashPassword(password, salt)).toString('hex');
      return db.transaction(() => {
        if (db.get('SELECT 1 FROM account_users WHERE email=?', email)) throw accountError(409, 'ACCOUNT_EXISTS', 'An account could not be created with these details. Try signing in.');
        if (db.get('SELECT count(*) AS n FROM account_users').n >= 10000) throw accountError(429, 'ACCOUNT_CAPACITY', 'Registration is busy. Try again later.', 60);
        const userId = id(), now = clock();
        db.run('INSERT INTO account_users(id,email,name,company,password_salt,password_hash,security_version,recovery_version,created_at,updated_at,email_verified_at) VALUES(?,?,?,?,?,?,1,1,?,?,NULL)', userId, email, name, company, salt, hash, now, now);
        const user = db.get('SELECT * FROM account_users WHERE id=?', userId), result = issue(user, context.csrf);
        const verification = onSignup(user);
        return { ...result, data: { ...result.data, ...(verification ? { verification } : {}) } };
      });
    },
    async login(input, context) {
      const email = emailKey(input.email); if (!validPassword(input.password)) throw invalid();
      rate(context.peer, email);
      const snapshot = db.get('SELECT * FROM account_users WHERE email=?', email);
      await verifyPassword(snapshot, input.password);
      return db.transaction(() => issue(current(snapshot), context.csrf));
    },
    logout(tokens, all = false) {
      const user = requireUser(tokens.session);
      if (all) db.transaction(() => { current(user); db.run('UPDATE account_users SET security_version=security_version+1 WHERE id=?', user.id); onSecurityChange(user.id); db.run('DELETE FROM account_sessions WHERE user_id=?', user.id); });
      else db.run('DELETE FROM account_sessions WHERE token_hash=?', digest(tokens.session));
      return { ok: true };
    },
    profile(user, input) {
      if (!Object.keys(input).length) throw accountError(400, 'INVALID_INPUT', 'Enter profile details to update.');
      const name = Object.hasOwn(input, 'name') ? text(input.name, 100) : user.name, company = Object.hasOwn(input, 'company') ? text(input.company, 160) : user.company;
      return db.transaction(() => { current(user); db.run('UPDATE account_users SET name=?,company=?,updated_at=? WHERE id=?', name, company, clock(), user.id); return { user: publicUser(db.get('SELECT * FROM account_users WHERE id=?', user.id)) }; });
    },
    async password(user, input, context) {
      requirePassword(input.currentPassword); requirePassword(input.newPassword); rate(context.peer, user.email);
      await verifyPassword(user, input.currentPassword);
      const salt = randomBytes(16).toString('hex'), hash = (await hashPassword(input.newPassword, salt)).toString('hex');
      return db.transaction(() => {
        requireUser(context.session); current(user); db.run('UPDATE account_users SET password_salt=?,password_hash=?,password_enabled=1,security_version=security_version+1,updated_at=? WHERE id=?', salt, hash, clock(), user.id);
        db.run('DELETE FROM account_sessions WHERE user_id=?', user.id); onSecurityChange(user.id);
        return issue(db.get('SELECT * FROM account_users WHERE id=?', user.id), context.csrf);
      });
    }
  };
}
