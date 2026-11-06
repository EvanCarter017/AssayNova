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
const invalidRecovery = () => accountError(401, 'INVALID_RECOVERY', 'The recovery details were not accepted.');
export const validPassword = value => validUnicode(value) && Array.from(value).length >= 15 && Array.from(value).length <= 128 && Buffer.byteLength(value, 'utf8') <= 512;
export function requirePassword(value) { if (!validPassword(value)) throw accountError(400, 'INVALID_PASSWORD', 'Use 15 to 128 characters, at most 512 UTF-8 bytes.'); return value; }
export const safeUser = row => ({ id: row.id, email: row.email, emailVerified: false, name: row.name, company: row.company });
const sameToken = (a, b) => typeof a === 'string' && typeof b === 'string' && tokenPattern.test(a) && tokenPattern.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const normalizeCode = value => typeof value === 'string' && value.length <= 64 ? value.replace(/[- ]/g, '').toUpperCase() : '';
const codeHash = (userId, code) => digest(userId + '\0' + code);

export function createAccountAuth({ db, clock = Date.now, derive = nativeDerive, kdfLimit = 2, absoluteMs = 7 * 86400000, idleMs = 86400000, challengeMs = 600000, challengePeerLimit = 20, challengeGlobalLimit = 512, rateWindowMs = 900000, identityLimit = 20, peerLimit = 200, globalLimit = 1000 } = {}) {
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
  function session(raw, touch = true) {
    if (typeof raw !== 'string' || !tokenPattern.test(raw)) return null;
    const hash = digest(raw);
    const row = db.get('SELECT u.*,s.csrf_hash AS session_csrf,s.security_version AS session_version,s.last_seen AS session_seen,s.expires_at AS session_expires FROM account_sessions s JOIN account_users u ON u.id=s.user_id WHERE s.token_hash=?', hash);
    if (!row) return null;
    if (row.security_version !== row.session_version || clock() >= row.session_expires || clock() - row.session_seen >= idleMs) { db.run('DELETE FROM account_sessions WHERE token_hash=?', hash); return null; }
    if (touch) db.run('UPDATE account_sessions SET last_seen=? WHERE token_hash=?', clock(), hash);
    return row;
  }
  function bootstrap(tokens, { peer = 'unknown' } = {}) {
    const user = session(tokens.session);
    let csrf = tokens.csrf;
    if (user) {
      if (!tokenPattern.test(csrf || '') || digest(csrf) !== user.session_csrf) { csrf = token(); db.run('UPDATE account_sessions SET csrf_hash=? WHERE token_hash=?', digest(csrf), digest(tokens.session)); }
      return { data: { authenticated: true, user: safeUser(user), csrfToken: csrf }, csrf, authenticated: true };
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
    if (!row || row.security_version !== snapshot.security_version || row.password_hash !== snapshot.password_hash || (recovery && row.recovery_version !== snapshot.recovery_version)) throw accountError(409, 'ACCOUNT_CHANGED', 'Account security changed. Sign in again.');
    return row;
  }
  function issue(user, oldCsrf) {
    const now = clock();
    db.run('DELETE FROM account_sessions WHERE expires_at<=? OR last_seen<=?', now, now - idleMs);
    const count = db.get('SELECT count(*) AS n FROM account_sessions WHERE user_id=?', user.id).n;
    if (count >= 32) db.run('DELETE FROM account_sessions WHERE token_hash IN (SELECT token_hash FROM account_sessions WHERE user_id=? ORDER BY last_seen,token_hash LIMIT ?)', user.id, count - 31);
    if (db.get('SELECT count(*) AS n FROM account_sessions').n >= 8192) throw accountError(429, 'SESSIONS_BUSY', 'Sign-in is busy. Try again shortly.', 60);
    const sessionToken = token(), csrfToken = token();
    db.run('INSERT INTO account_sessions VALUES(?,?,?,?,?,?,?)', digest(sessionToken), user.id, digest(csrfToken), user.security_version, now, now, now + absoluteMs);
    if (tokenPattern.test(oldCsrf || '')) db.run('DELETE FROM account_challenges WHERE token_hash=?', digest(oldCsrf));
    return { sessionToken, csrfToken, data: { user: safeUser(user), csrfToken } };
  }
  function codes(userId) {
    const values = Array.from({ length: 8 }, () => randomBytes(16).toString('hex').toUpperCase());
    db.run('DELETE FROM account_recovery_codes WHERE user_id=?', userId);
    for (const code of values) db.run('INSERT INTO account_recovery_codes VALUES(?,?)', userId, codeHash(userId, code));
    return values.map(code => code.match(/.{4}/g).join('-'));
  }
  async function verifyPassword(snapshot, password) {
    const actual = await hashPassword(password, snapshot?.password_salt ?? '00'.repeat(16));
    const expected = Buffer.from(snapshot?.password_hash ?? '00'.repeat(32), 'hex');
    if (!snapshot || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  }
  return {
    session, bootstrap, csrf, requireUser,
    cookieSeconds: Math.floor(absoluteMs / 1000), challengeSeconds: Math.floor(challengeMs / 1000),
    async signup(input, context) {
      const email = emailKey(input.email), password = requirePassword(input.password), name = text(input.name ?? '', 100), company = text(input.company ?? '', 160);
      rate(context.peer, email);
      const salt = randomBytes(16).toString('hex'), hash = (await hashPassword(password, salt)).toString('hex');
      return db.transaction(() => {
        if (db.get('SELECT 1 FROM account_users WHERE email=?', email)) throw accountError(409, 'ACCOUNT_EXISTS', 'An account could not be created with these details. Try signing in.');
        if (db.get('SELECT count(*) AS n FROM account_users').n >= 10000) throw accountError(429, 'ACCOUNT_CAPACITY', 'Registration is busy. Try again later.', 60);
        const userId = id(), now = clock();
        db.run('INSERT INTO account_users VALUES(?,?,?,?,?,?,1,1,?,?)', userId, email, name, company, salt, hash, now, now);
        const user = db.get('SELECT * FROM account_users WHERE id=?', userId), recoveryCodes = codes(userId), result = issue(user, context.csrf);
        return { ...result, data: { ...result.data, recoveryCodes } };
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
      if (all) db.transaction(() => { current(user); db.run('UPDATE account_users SET security_version=security_version+1 WHERE id=?', user.id); db.run('DELETE FROM account_sessions WHERE user_id=?', user.id); });
      else db.run('DELETE FROM account_sessions WHERE token_hash=?', digest(tokens.session));
      return { ok: true };
    },
    profile(user, input) {
      if (!Object.keys(input).length) throw accountError(400, 'INVALID_INPUT', 'Enter profile details to update.');
      const name = Object.hasOwn(input, 'name') ? text(input.name, 100) : user.name, company = Object.hasOwn(input, 'company') ? text(input.company, 160) : user.company;
      return db.transaction(() => { current(user); db.run('UPDATE account_users SET name=?,company=?,updated_at=? WHERE id=?', name, company, clock(), user.id); return { user: safeUser(db.get('SELECT * FROM account_users WHERE id=?', user.id)) }; });
    },
    async password(user, input, context) {
      requirePassword(input.currentPassword); requirePassword(input.newPassword); rate(context.peer, user.email);
      await verifyPassword(user, input.currentPassword);
      const salt = randomBytes(16).toString('hex'), hash = (await hashPassword(input.newPassword, salt)).toString('hex');
      return db.transaction(() => {
        requireUser(context.session); current(user); db.run('UPDATE account_users SET password_salt=?,password_hash=?,security_version=security_version+1,updated_at=? WHERE id=?', salt, hash, clock(), user.id);
        db.run('DELETE FROM account_sessions WHERE user_id=?', user.id);
        return issue(db.get('SELECT * FROM account_users WHERE id=?', user.id), context.csrf);
      });
    },
    async regenerate(user, input, context) {
      requirePassword(input.currentPassword); rate(context.peer, user.email); await verifyPassword(user, input.currentPassword);
      return db.transaction(() => { requireUser(context.session); current(user, true); db.run('UPDATE account_users SET recovery_version=recovery_version+1 WHERE id=?', user.id); return { recoveryCodes: codes(user.id) }; });
    },
    async recover(input, context) {
      const email = emailKey(input.email), password = requirePassword(input.newPassword), normalized = normalizeCode(input.recoveryCode);
      if (!/^[A-F0-9]{32}$/.test(normalized)) throw invalidRecovery();
      rate(context.peer, email);
      const snapshot = db.get('SELECT * FROM account_users WHERE email=?', email), salt = randomBytes(16).toString('hex');
      const hash = (await hashPassword(password, salt)).toString('hex');
      return db.transaction(() => {
        if (!snapshot) throw invalidRecovery();
        let user; try { user = current(snapshot, true); } catch { throw invalidRecovery(); }
        if (!db.get('SELECT 1 FROM account_recovery_codes WHERE user_id=? AND code_hash=?', user.id, codeHash(user.id, normalized))) throw invalidRecovery();
        db.run('UPDATE account_users SET password_salt=?,password_hash=?,security_version=security_version+1,recovery_version=recovery_version+1,updated_at=? WHERE id=?', salt, hash, clock(), user.id);
        db.run('DELETE FROM account_sessions WHERE user_id=?', user.id);
        if (tokenPattern.test(context.csrf || '')) db.run('DELETE FROM account_challenges WHERE token_hash=?', digest(context.csrf));
        return { ok: true, recoveryCodes: codes(user.id) };
      });
    }
  };
}
