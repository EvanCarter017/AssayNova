import { randomBytes } from 'node:crypto';
import { digest } from './auth.mjs';
import { accountError, emailKey } from './errors.mjs';
import { validMailbox } from './mail-config.mjs';
import { mailTemplate } from './mail-templates.mjs';

const invalid = () => accountError(400, 'INVALID_ACTION', 'This link is invalid, used or expired. Request a new link.');
const hashToken = (purpose, token) => digest(purpose + '\0' + token);
export function createMailActions({ db, auth, mail, clock = Date.now, securityChanged = userId => mail.invalidateUser(userId) } = {}) {
  const config = mail.config;
  function issue(user, purpose) {
    if (!mail.enabled()) return 'not_configured';
    if (!validMailbox(user.email)) return 'unsupported_address';
    if (purpose === 'verify_email' && user.email_verified_at) return 'verified';
    const raw = randomBytes(32).toString('hex'), token_hash = hashToken(purpose, raw), now = clock(), expiry = now + (purpose === 'verify_email' ? 86400000 : 900000);
    db.exec('SAVEPOINT mail_action');
    try {
      // A failed new admission restores the old usable token and encrypted job.
      db.run('DELETE FROM account_mail_tokens WHERE user_id=? AND purpose=?', user.id, purpose);
      db.run('INSERT INTO account_mail_tokens(token_hash,user_id,purpose,email_hash,security_version,recovery_version,created_at,expires_at,consumed_at) VALUES(?,?,?,?,?,?,?,?,NULL)', token_hash, user.id, purpose, digest(user.email), user.security_version, user.recovery_version, now, expiry);
      const event = { event_key: 'action:' + purpose + ':' + token_hash, kind: purpose, user_id: user.id, token_hash, recipient_kind: 'account', recipient_hash: digest(user.email), created_at: now };
      const status = mail.admit(event, mailTemplate(event, { config, recipient: user.email, token: raw }), expiry);
      if (status !== 'queued') { db.exec('ROLLBACK TO mail_action'); db.exec('RELEASE mail_action'); return status; }
      db.exec('RELEASE mail_action'); return status;
    } catch { db.exec('ROLLBACK TO mail_action'); db.exec('RELEASE mail_action'); return 'unavailable'; }
  }
  function verification(user, { registration = false } = {}) {
    const fresh = db.get('SELECT * FROM account_users WHERE id=?', user.id);
    if (!fresh || fresh.security_version !== user.security_version || fresh.recovery_version !== user.recovery_version) throw invalid();
    if (fresh.email_verified_at) return { ok: true, status: 'verified' };
    if (mail.enabled()) {
      try { mail.rate([['verification-minute', fresh.id, 1, 60000], ['verification-hour', fresh.id, 3, 3600000]]); }
      catch (error) { if (!registration) throw error; return { ok: true, status: 'unavailable' }; }
    }
    return { ok: true, status: issue(fresh, 'verify_email') };
  }
  function admissionRates(peer, raw) {
    mail.rate([['consume-peer', peer, 20, 900000], ['consume-global', 'all', 1000, 900000], ['consume-token', digest(typeof raw === 'string' ? raw.slice(0, 128) : 'invalid'), 20, 900000]]);
  }
  function binding(context, ownerId) {
    let current; try { current = auth.csrf({ session: context.session, csrf: context.csrf }, context.csrf); } catch { throw invalid(); }
    if (context.userId && !current || current && current.id !== ownerId) throw invalid();
  }
  function snapshot(purpose, raw, context) {
    if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) throw invalid();
    const token = db.get('SELECT * FROM account_mail_tokens WHERE token_hash=? AND purpose=?', hashToken(purpose, raw), purpose);
    const user = token ? db.get('SELECT * FROM account_users WHERE id=?', token.user_id) : null;
    if (!user || token.consumed_at !== null || token.expires_at <= clock() || token.email_hash !== digest(user.email) || token.security_version !== user.security_version || token.recovery_version !== user.recovery_version || purpose === 'reset_password' && !user.email_verified_at) throw invalid();
    binding(context, user.id); return { token, user };
  }
  return {
    signup: user => verification(user, { registration: true }),
    verification(user) { return db.transaction(() => verification(user)); },
    requestReset(input, context) {
      const email = emailKey(input.email);
      db.transaction(() => {
        mail.rate([['reset-minute', email, 1, 60000], ['reset-hour', email, 3, 3600000], ['reset-peer', context.peer, 20, 900000], ['reset-global', 'all', 100, 900000]]);
        const user = db.get('SELECT * FROM account_users WHERE email=?', email);
        if (user?.email_verified_at && validMailbox(user.email)) issue(user, 'reset_password');
      });
      return { ok: true };
    },
    verify(input, context) {
      db.transaction(() => admissionRates(context.peer, input.token));
      return db.transaction(() => {
        const { token, user } = snapshot('verify_email', input.token, context), now = clock();
        db.run('UPDATE account_mail_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL', now, token.token_hash);
        db.run('UPDATE account_users SET email_verified_at=? WHERE id=?', now, user.id);
        db.run('DELETE FROM account_mail_outbox WHERE event_key=?', 'action:verify_email:' + token.token_hash);
        db.run("UPDATE account_mail_events SET state='canceled',updated_at=?,failure_code='canceled' WHERE token_hash=? AND state<>'accepted'", now, token.token_hash);
        return { ok: true };
      });
    },
    async reset(input, context) {
      db.transaction(() => admissionRates(context.peer, input.token));
      const original = snapshot('reset_password', input.token, context);
      const password = await auth.prepareMailPassword(input.newPassword);
      return db.transaction(() => {
        const current = snapshot('reset_password', input.token, context);
        if (current.user.password_hash !== original.user.password_hash || current.token.created_at !== original.token.created_at) throw invalid();
        db.run('UPDATE account_users SET password_salt=?,password_hash=?,password_enabled=1,security_version=security_version+1,recovery_version=recovery_version+1,updated_at=? WHERE id=?', password.salt, password.hash, clock(), current.user.id);
        db.run('DELETE FROM account_sessions WHERE user_id=?', current.user.id); securityChanged(current.user.id);
        db.run('DELETE FROM account_challenges WHERE token_hash=?', digest(context.csrf));
        return { ok: true };
      });
    }
  };
}
