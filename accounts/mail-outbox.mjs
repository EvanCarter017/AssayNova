import { randomBytes } from 'node:crypto';
import { digest } from './auth.mjs';
import { accountError } from './errors.mjs';
import { mailOff, validMailbox } from './mail-config.mjs';
import { encryptMailPayload, decryptMailPayload, mailKeyId, MailCryptoError } from './mail-crypto.mjs';
import { mailTemplate } from './mail-templates.mjs';
import { createSMTPTransport } from './mail-smtp.mjs';
import { parseAccountRequest } from '../dist/account-requests.js';

const cooldownKey = digest('mail-provider-cooldown');
const active = new Set(['queued', 'retrying', 'accepted']);
const blocked = new Set(['not_verified', 'not_configured', 'backpressure', 'unavailable']);
const retryDelays = [30000, 120000, 600000, 1800000, 7200000];
const failureCodes = new Set(['network', 'uncertain', 'temporary', 'permanent', 'authentication', 'tls', 'protocol', 'message_too_large', 'integrity', 'unavailable', 'canceled', 'expired']);
const eventKeys = requestId => ({ receipt: 'request:' + requestId + ':submitted:v1:receipt', support: 'request:' + requestId + ':submitted:v1:support' });

// Admission methods are synchronous and use their caller's transaction. The
// worker owns short transactions; no transaction spans filesystem or SMTP I/O.
export function createMailOutbox({ db, config = mailOff(), clock = Date.now, transport, encrypt = encryptMailPayload, jitter = () => Math.floor(Math.random() * 1001), reportEligible = async () => false } = {}) {
  const sender = config.enabled ? transport || createSMTPTransport({ smtp: config.smtp }) : null;
  let timer = null, running = null, controller = null, stopping = false, cooldownUntil = 0, providerFailures = 0;
  const enabled = () => !!config.enabled;
  function rate(buckets) {
    const now = clock();
    db.run('DELETE FROM account_mail_rates WHERE bucket_hash IN (SELECT bucket_hash FROM account_mail_rates WHERE expires_at<=? AND bucket_hash<>? LIMIT 128)', now, cooldownKey);
    for (const [scope, identity, maximum, windowMs] of buckets) {
      const key = digest('mail:' + scope + '\0' + identity), previous = db.get('SELECT * FROM account_mail_rates WHERE bucket_hash=?', key);
      if (previous && now < previous.window_start + previous.window_ms && previous.count >= maximum) throw accountError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', Math.max(1, Math.ceil((previous.expires_at - now) / 1000)));
      if (!previous && db.get('SELECT count(*) AS n FROM account_mail_rates').n >= 4095) throw accountError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', 60);
      if (!previous || now >= previous.expires_at) db.run('INSERT INTO account_mail_rates(bucket_hash,window_start,window_ms,count,expires_at) VALUES(?,?,?,1,?) ON CONFLICT(bucket_hash) DO UPDATE SET window_start=excluded.window_start,window_ms=excluded.window_ms,count=1,expires_at=excluded.expires_at', key, now, windowMs, now + windowMs);
      else db.run('UPDATE account_mail_rates SET count=count+1 WHERE bucket_hash=?', key);
    }
  }
  function insertEvent(event, state) {
    db.run('INSERT INTO account_mail_events(event_key,kind,user_id,request_id,token_hash,report_code,recipient_kind,recipient_hash,state,created_at,updated_at,accepted_at,failure_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(event_key) DO NOTHING', event.event_key, event.kind, event.user_id ?? null, event.request_id ?? null, event.token_hash ?? null, event.report_code ?? null, event.recipient_kind, event.recipient_hash ?? null, state, event.created_at, event.created_at);
    return db.get('SELECT * FROM account_mail_events WHERE event_key=?', event.event_key);
  }
  function admit(event, payload, expiresAt) {
    const current = insertEvent(event, 'unavailable');
    if (active.has(current.state) || !blocked.has(current.state)) return current.state;
    if (!enabled()) { setBlocked(event.event_key, 'not_configured'); return 'not_configured'; }
    // Do not mix newly encrypted jobs into a paused queue under a wrong key.
    if (db.get('SELECT 1 FROM account_mail_outbox WHERE key_id<>? LIMIT 1', mailKeyId(config.key))) { setBlocked(event.event_key, 'unavailable'); return 'unavailable'; }
    const sealed = encrypt(config.key, current, payload);
    const total = db.get('SELECT count(*) AS n,coalesce(sum(length(ciphertext)),0) AS bytes FROM account_mail_outbox');
    const userCount = current.user_id ? db.get('SELECT count(*) AS n FROM account_mail_outbox o JOIN account_mail_events e USING(event_key) WHERE e.user_id=?', current.user_id).n : 0;
    if (total.n >= 1000 || total.bytes + sealed.ciphertext.length > 32 * 1024 * 1024 || current.user_id && userCount >= 10) { setBlocked(event.event_key, 'backpressure'); return 'backpressure'; }
    db.run('INSERT INTO account_mail_outbox(event_key,key_id,nonce,tag,ciphertext,state,attempts,next_attempt_at,expires_at,lease_id,lease_until,uncertain,created_at) VALUES(?,?,?,?,?,\'queued\',0,?,?,NULL,NULL,0,?)', event.event_key, sealed.key_id, sealed.nonce, sealed.tag, sealed.ciphertext, clock(), expiresAt, clock());
    db.run("UPDATE account_mail_events SET state='queued',updated_at=?,failure_code=NULL WHERE event_key=?", clock(), event.event_key);
    return 'queued';
  }
  function setBlocked(key, state) { db.run('UPDATE account_mail_events SET state=?,updated_at=?,failure_code=NULL WHERE event_key=?', state, clock(), key); }
  function requestStatus(row) {
    if (!row.notification_revision) return { receipt: 'not_requested', support: 'not_requested', retryable: false };
    const keys = eventKeys(row.id), result = {};
    for (const name of ['receipt', 'support']) result[name] = db.get('SELECT state FROM account_mail_events WHERE event_key=?', keys[name])?.state || 'unavailable';
    return { ...result, retryable: blocked.has(result.receipt) || blocked.has(result.support) };
  }
  function admitRequest(row) {
    if (!row.notification_revision) return requestStatus(row);
    const record = parseAccountRequest(JSON.parse(row.record_json)), user = db.get('SELECT * FROM account_users WHERE id=?', row.user_id);
    if (!record || record.version !== 3 || !user) return requestStatus(row);
    const keys = eventKeys(row.id), now = clock();
    for (const name of ['receipt', 'support']) {
      const event = { event_key: keys[name], kind: name === 'receipt' ? 'request_receipt' : 'support_alert', user_id: user.id, request_id: row.id, recipient_kind: name === 'receipt' ? 'account' : 'support', recipient_hash: name === 'receipt' ? digest(user.email) : enabled() ? digest(config.smtp.supportTo) : null, created_at: now };
      const previous = insertEvent(event, 'unavailable'); if (active.has(previous.state) || !blocked.has(previous.state)) continue;
      if (name === 'receipt' && !user.email_verified_at) { setBlocked(event.event_key, 'not_verified'); continue; }
      if (name === 'receipt' && !validMailbox(user.email)) { setBlocked(event.event_key, 'unsupported_address'); continue; }
      if (!enabled()) { setBlocked(event.event_key, 'not_configured'); continue; }
      if (name === 'support') {
        try { rate([['support-user', user.id, 10, 3600000], ['support-global', 'all', 1000, 3600000]]); }
        catch (error) { if (error.code !== 'RATE_LIMITED') throw error; setBlocked(event.event_key, 'backpressure'); continue; }
      }
      db.run('UPDATE account_mail_events SET recipient_hash=? WHERE event_key=?', event.recipient_hash, event.event_key);
      const recipient = name === 'receipt' ? user.email : config.smtp.supportTo;
      admit(event, mailTemplate(event, { config, recipient, user, record, revision: row.revision }), now + 86400000);
    }
    return requestStatus(row);
  }
  function requestAdmission(row) {
    db.exec('SAVEPOINT request_mail');
    try { const result = admitRequest(row); db.exec('RELEASE request_mail'); return result; }
    catch { db.exec('ROLLBACK TO request_mail'); db.exec('RELEASE request_mail'); return requestStatus(row); }
  }
  function reportStatus(code) { return { state: db.get('SELECT state FROM account_mail_events WHERE event_key=?', 'report:' + code + ':publication:v1')?.state || 'not_requested' }; }
  function admitReport(code, recipient) {
    return db.transaction(() => {
      const key = 'report:' + code + ':publication:v1', previous = db.get('SELECT * FROM account_mail_events WHERE event_key=?', key), recipientHash = digest(recipient);
      if (previous && previous.recipient_hash !== recipientHash) throw accountError(409, 'RECIPIENT_CONFLICT', 'This publication notice already has a recipient.');
      if (!previous && db.get("SELECT count(*) AS n FROM account_mail_events WHERE kind='report_notice'").n >= 4096) return { state: 'backpressure' };
      const event = { event_key: key, kind: 'report_notice', report_code: code, recipient_kind: 'report', recipient_hash: recipientHash, created_at: clock() };
      const current = insertEvent(event, 'unavailable');
      if (active.has(current.state) || !blocked.has(current.state)) return { state: current.state };
      if (!enabled() || !config.reportNoticesEnabled) { setBlocked(key, 'not_configured'); return { state: 'not_configured' }; }
      db.exec('SAVEPOINT report_mail');
      try { const state = admit(event, mailTemplate(event, { config, recipient, reportCode: code }), clock() + 86400000); db.exec('RELEASE report_mail'); return { state }; }
      catch { db.exec('ROLLBACK TO report_mail'); db.exec('RELEASE report_mail'); setBlocked(key, 'unavailable'); return { state: 'unavailable' }; }
    });
  }
  function invalidateUser(userId) { db.run('DELETE FROM account_mail_tokens WHERE user_id=?', userId); }
  function cancel(key, state, code = state) {
    db.run('UPDATE account_mail_events SET state=?,updated_at=?,failure_code=? WHERE event_key=? AND state<>\'accepted\'', state, clock(), failureCodes.has(code) ? code : 'unavailable', key);
    db.run('DELETE FROM account_mail_outbox WHERE event_key=?', key);
  }
  function isEligible(row) {
    const event = db.get('SELECT * FROM account_mail_events WHERE event_key=?', row.event_key);
    if (!event || event.state === 'accepted') return false;
    if (event.request_id && !db.get('SELECT 1 FROM account_requests WHERE id=? AND user_id=? AND notification_revision IS NOT NULL', event.request_id, event.user_id)) return false;
    if (event.kind === 'request_receipt') { const user = db.get('SELECT email,email_verified_at FROM account_users WHERE id=?', event.user_id); if (!user?.email_verified_at || digest(user.email) !== event.recipient_hash || !validMailbox(user.email)) return false; }
    if (event.kind === 'support_alert' && (!enabled() || event.recipient_hash !== digest(config.smtp.supportTo))) return false;
    if (event.token_hash) {
      const token = db.get('SELECT t.*,u.email,u.email_verified_at,u.security_version AS live_security,u.recovery_version AS live_recovery FROM account_mail_tokens t JOIN account_users u ON u.id=t.user_id WHERE t.token_hash=?', event.token_hash);
      if (!token || token.consumed_at !== null || token.expires_at <= clock() || token.security_version !== token.live_security || token.recovery_version !== token.live_recovery || digest(token.email) !== token.email_hash || token.purpose !== event.kind || event.recipient_hash !== digest(token.email) || !validMailbox(token.email) || token.purpose === 'reset_password' && !token.email_verified_at) return false;
    }
    return true;
  }
  function paused() { return !enabled() || !!db.get('SELECT 1 FROM account_mail_outbox WHERE key_id<>? LIMIT 1', mailKeyId(config.key)); }
  function claim() {
    if (stopping || paused()) return null;
    return db.transaction(() => {
      const now = clock();
      db.run('DELETE FROM account_mail_tokens WHERE token_hash IN (SELECT token_hash FROM account_mail_tokens WHERE expires_at<=? LIMIT 64)', now);
      for (const row of db.all('SELECT event_key FROM account_mail_outbox WHERE expires_at<=? LIMIT 64', now)) cancel(row.event_key, 'expired');
      const cooldownRow = db.get('SELECT expires_at,count FROM account_mail_rates WHERE bucket_hash=?', cooldownKey);
      const cooldown = cooldownRow?.expires_at || 0; providerFailures = cooldownRow?.count || 0;
      if (now < Math.max(cooldownUntil, cooldown)) return null;
      const row = db.get("SELECT * FROM account_mail_outbox WHERE expires_at>? AND ((state IN ('queued','retry') AND next_attempt_at<=?) OR (state='leased' AND lease_until<=?)) ORDER BY next_attempt_at,event_key LIMIT 1", now, now, now);
      if (!row) return null;
      if (row.attempts >= 6) { cancel(row.event_key, 'failed', 'permanent'); return null; }
      if (!isEligible(row)) { cancel(row.event_key, 'canceled'); return null; }
      const lease = randomBytes(16).toString('hex');
      db.run("UPDATE account_mail_outbox SET state='leased',lease_id=?,lease_until=?,attempts=attempts+1 WHERE event_key=?", lease, now + 120000, row.event_key);
      db.run('UPDATE account_mail_events SET state=?,updated_at=? WHERE event_key=?', row.attempts ? 'retrying' : 'queued', now, row.event_key);
      return { ...row, lease_id: lease, attempts: row.attempts + 1, event: db.get('SELECT * FROM account_mail_events WHERE event_key=?', row.event_key) };
    });
  }
  function ownsLease(row) { return !!db.get("SELECT 1 FROM account_mail_outbox WHERE event_key=? AND lease_id=? AND state='leased' AND lease_until>?", row.event_key, row.lease_id, clock()); }
  async function perform() {
    const row = claim(); if (!row) return { sent: false };
    let result;
    try {
      const payload = decryptMailPayload(config.key, row.event, row);
      if (digest(payload.to) !== row.event.recipient_hash) throw new MailCryptoError('integrity');
      const current = () => !stopping && ownsLease(row) && isEligible(row) && row.expires_at > clock();
      const beforeData = async () => current() && (!row.event.report_code || await reportEligible(row.event.report_code)) && current();
      if (!await beforeData()) result = { outcome: 'canceled', code: 'canceled' };
      else { controller = new AbortController(); result = await sender.send(payload, { signal: controller.signal, beforeData }); }
    } catch (error) { result = error instanceof MailCryptoError ? { outcome: error.code === 'unavailable' ? 'paused' : 'failed', code: error.code === 'unavailable' ? 'unavailable' : 'integrity' } : { outcome: 'retry', code: 'network' }; }
    finally { controller = null; }
    if (!result || !['paused','accepted','retry','cooldown','failed','canceled'].includes(result.outcome)) result = { outcome: 'retry', code: 'network' };
    if (result.outcome === 'paused') {
      db.transaction(() => { if (ownsLease(row)) db.run("UPDATE account_mail_outbox SET state='queued',attempts=attempts-1,lease_id=NULL,lease_until=NULL WHERE event_key=? AND lease_id=?", row.event_key, row.lease_id); });
      return { sent: false, paused: true };
    }
    db.transaction(() => {
      if (!ownsLease(row)) return;
      const now = clock();
      if (result.outcome === 'accepted') { db.run("UPDATE account_mail_events SET state='accepted',accepted_at=?,updated_at=?,failure_code=NULL WHERE event_key=?", now, now, row.event_key); db.run('DELETE FROM account_mail_outbox WHERE event_key=? AND lease_id=?', row.event_key, row.lease_id); providerFailures = 0; cooldownUntil = 0; db.run('DELETE FROM account_mail_rates WHERE bucket_hash=?', cooldownKey); return; }
      if (stopping && result.outcome === 'canceled' && isEligible(row) && row.expires_at > now) result = { outcome: 'retry', code: result.uncertain ? 'uncertain' : 'network', uncertain: !!result.uncertain };
      const code = failureCodes.has(result.code) ? result.code : 'network';
      if (result.outcome === 'canceled') { cancel(row.event_key, 'canceled'); return; }
      if (row.expires_at <= now) { cancel(row.event_key, 'expired'); return; }
      if (result.outcome === 'failed' || row.attempts >= 6) { cancel(row.event_key, 'failed', code); return; }
      if (result.outcome === 'cooldown') {
        providerFailures = Math.min(5, providerFailures + 1); cooldownUntil = now + Math.min(900000, 60000 * 2 ** (providerFailures - 1));
        db.run('INSERT INTO account_mail_rates(bucket_hash,window_start,window_ms,count,expires_at) VALUES(?,?,?, ?,?) ON CONFLICT(bucket_hash) DO UPDATE SET window_start=excluded.window_start,window_ms=excluded.window_ms,count=excluded.count,expires_at=excluded.expires_at', cooldownKey, now, cooldownUntil - now, providerFailures, cooldownUntil);
      }
      const next = now + retryDelays[Math.min(row.attempts - 1, 4)] + Math.min(1000, Math.max(0, Number(jitter()) || 0));
      db.run("UPDATE account_mail_outbox SET state='retry',next_attempt_at=?,lease_id=NULL,lease_until=NULL,uncertain=? WHERE event_key=? AND lease_id=?", Math.max(next, cooldownUntil), result.uncertain ? 1 : 0, row.event_key, row.lease_id);
      db.run("UPDATE account_mail_events SET state='retrying',updated_at=?,failure_code=? WHERE event_key=?", now, code, row.event_key);
    });
    return { sent: result.outcome === 'accepted' };
  }
  function pump() { if (running) return running; if (stopping) return Promise.resolve({ sent: false }); running = perform().finally(() => { running = null; }); return running; }
  function start() { if (timer || !enabled()) return; stopping = false; const tick = () => { pump().catch(() => {}).finally(() => { if (!stopping) { timer = setTimeout(tick, 1000); timer.unref(); } }); }; timer = setTimeout(tick, 0); timer.unref(); }
  function stop() { stopping = true; clearTimeout(timer); timer = null; controller?.abort(); return running; }
  return { enabled, reportStatus, admitReport, reportEnabled: () => enabled() && !!config.reportNoticesEnabled, rate, admit, insertEvent, setBlocked, requestStatus, requestAdmission, invalidateUser, isEligible, pump, start, stop, config };
}
