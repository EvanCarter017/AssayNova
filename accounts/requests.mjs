import { parseAccountRequest, requestKind } from '../dist/account-requests.js';
import { randomBytes } from 'node:crypto';
import { digest } from './auth.mjs';
import { accountError } from './errors.mjs';

const missing = () => accountError(404, 'REQUEST_NOT_FOUND', 'Request was not found.');
const conflict = () => accountError(409, 'REVISION_CONFLICT', 'This request changed. Reopen it before saving again.');
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
function record(value) {
  const parsed = parseAccountRequest(value);
  if (!parsed) throw accountError(400, 'INVALID_RECORD', 'Check the request details.');
  return parsed;
}
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) throw accountError(400, 'INVALID_REVISION', 'Reopen the request and try again.'); return value; }
export function createAccountRequests({ db, clock = Date.now }) {
  function document(row) {
    if (!row) throw missing();
    let parsed;
    try { parsed = parseAccountRequest(JSON.parse(row.record_json)); } catch {}
    if (!parsed) throw accountError(503, 'STORAGE_UNAVAILABLE', 'Account requests are unavailable. Try again later.');
    return { id: row.id, revision: row.revision, record: parsed, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
  }
  function owned(user, id) { if (!validId(id)) throw missing(); return db.get('SELECT * FROM account_requests WHERE user_id=? AND id=?', user.id, id); }
  function current(user) {
    const actual = db.get('SELECT security_version FROM account_users WHERE id=?', user.id);
    if (!actual || actual.security_version !== user.security_version) throw accountError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  }
  return {
    list(user) { return { requests: db.all('SELECT * FROM account_requests WHERE user_id=? ORDER BY updated_at DESC,id DESC LIMIT 50', user.id).map(document) }; },
    get(user, id) { return { request: document(owned(user, id)) }; },
    create(user, input) {
      const parsed = record(input.record), serialized = JSON.stringify(parsed), hash = digest(serialized), key = input.idempotencyKey;
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw accountError(400, 'INVALID_IDEMPOTENCY_KEY', 'Use a valid request save reference.');
      return db.transaction(() => {
        current(user);
        const replay = db.get('SELECT * FROM account_idempotency WHERE user_id=? AND request_key=?', user.id, key);
        if (replay) {
          if (replay.payload_hash !== hash) throw accountError(409, 'IDEMPOTENCY_CONFLICT', 'This save reference already has different request details.');
          if (!replay.request_id) throw accountError(409, 'REQUEST_DELETED', 'The request for this save reference was deleted.');
          return { status: 200, data: { request: document(owned(user, replay.request_id)) } };
        }
        if (db.get('SELECT count(*) AS n FROM account_requests WHERE user_id=?', user.id).n >= 50) throw accountError(409, 'DRAFT_LIMIT', 'Your account already has 50 requests. Remove a request before adding another.');
        if (db.get('SELECT count(*) AS n FROM account_idempotency WHERE user_id=?', user.id).n >= 1000) throw accountError(429, 'SAVE_LIMIT', 'This account has reached its submission reference limit.');
        const id = randomBytes(16).toString('hex'), now = clock();
        db.run('INSERT INTO account_requests VALUES(?,?,1,?,?,?)', id, user.id, serialized, now, now);
        db.run('INSERT INTO account_idempotency VALUES(?,?,?,?)', user.id, key, hash, id);
        return { status: 201, data: { request: document(owned(user, id)) } };
      });
    },
    update(user, id, input) {
      const parsed = record(input.record), expected = revision(input.expectedRevision);
      return db.transaction(() => {
        current(user); const old = owned(user, id); if (!old) throw missing(); if (old.revision !== expected) throw conflict();
        const previous = document(old).record;
        if (parsed.id !== previous.id || parsed.createdAt !== previous.createdAt || requestKind(parsed) !== requestKind(previous)) throw accountError(400, 'INVALID_RECORD', 'The original request reference, date and kind must remain unchanged.');
        db.run('UPDATE account_requests SET revision=revision+1,record_json=?,updated_at=? WHERE user_id=? AND id=? AND revision=?', JSON.stringify(parsed), clock(), user.id, id, expected);
        return { request: document(owned(user, id)) };
      });
    },
    delete(user, id, input) {
      const expected = revision(input.expectedRevision);
      return db.transaction(() => { current(user); const old = owned(user, id); if (!old) throw missing(); if (old.revision !== expected) throw conflict(); db.run('DELETE FROM account_requests WHERE user_id=? AND id=? AND revision=?', user.id, id, expected); return { ok: true }; });
    }
  };
}
