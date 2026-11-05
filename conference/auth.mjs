import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_AUTH_STORE = fileURLToPath(new URL('../work/admin-auth', import.meta.url));
const derive = promisify(scrypt);
const cost = { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 };
const hex = /^[a-f0-9]{64}$/;
const problem = (status, message, retryAfter) => Object.assign(new Error(message), { status, retryAfter });

export function validPassword(value) {
  return typeof value === 'string' && Array.from(value).length >= 10 && Array.from(value).length <= 128 && Buffer.byteLength(value, 'utf8') <= 512;
}

export function createAuth({ store = DEFAULT_AUTH_STORE, origin, clock = Date.now, absoluteMs = 8 * 60 * 60 * 1000, idleMs = 30 * 60 * 1000, maxSessions = 32 } = {}) {
  if (!path.isAbsolute(store)) throw new Error('Choose an absolute admin credential directory.');
  if (typeof clock !== 'function' || !Number.isFinite(absoluteMs) || absoluteMs <= 0 || !Number.isFinite(idleMs) || idleMs <= 0 || !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 1024) throw new Error('Invalid administrator session limits.');
  const filename = path.join(store, 'credential.json');
  const challenge = randomBytes(32).toString('hex');
  const sessions = new Map();
  let busy = false, failures = 0, cooldownUntil = 0;
  const currentOrigin = () => typeof origin === 'function' ? origin() : origin;
  const cookieName = () => { const url = new URL(currentOrigin()); return 'an_admin_' + (url.port || (url.protocol === 'https:' ? '443' : '80')); };
  const cookie = (id, maxAge) => `${cookieName()}=${id}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(currentOrigin()).protocol === 'https:' ? '; Secure' : ''}`;

  async function readRecord() {
    let file;
    try { file = await open(filename, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw problem(503, 'Administrator credential storage is unavailable.'); }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > 1024) throw new Error('Invalid record size.');
      const bytes = Buffer.alloc(1025), result = await file.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead < 1 || result.bytesRead > 1024) throw new Error('Invalid record size.');
      const record = JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8'));
      if (!record || Array.isArray(record) || Object.keys(record).sort().join(',') !== 'hash,salt,version' || record.version !== 1 || typeof record.salt !== 'string' || !/^[a-f0-9]{32}$/.test(record.salt) || typeof record.hash !== 'string' || !hex.test(record.hash)) throw new Error('Invalid credential record.');
      return record;
    } catch { throw problem(503, 'Administrator credential storage is unavailable.'); }
    finally { await file.close(); }
  }
  function purge() {
    const now = clock();
    for (const [id, session] of sessions) if (now >= session.expires || now - session.lastSeen >= idleMs) sessions.delete(id);
  }
  function requestId(request) {
    const raw = request.headers.cookie;
    if (typeof raw !== 'string' || raw.length > 4096) return '';
    const values = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(cookieName() + '='));
    if (values.length !== 1) return '';
    const id = values[0].slice(cookieName().length + 1);
    return hex.test(id) ? id : '';
  }
  function authorized(request) {
    purge();
    const session = sessions.get(requestId(request));
    if (!session) return false;
    session.lastSeen = clock(); return true;
  }
  function issue() {
    purge();
    while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    const id = randomBytes(32).toString('hex'), now = clock();
    sessions.set(id, { expires: now + absoluteMs, lastSeen: now });
    return cookie(id, Math.floor(absoluteMs / 1000));
  }
  function rejectLogin() {
    failures++;
    if (failures >= 5) { cooldownUntil = clock() + 60000; throw problem(429, 'Too many attempts. Try again later.', 60); }
    throw problem(401, 'Administrator password was not accepted.');
  }
  async function unlock(password, setup) {
    if (clock() < cooldownUntil) throw problem(429, 'Too many attempts. Try again later.', Math.ceil((cooldownUntil - clock()) / 1000));
    if (cooldownUntil) { failures = 0; cooldownUntil = 0; }
    if (busy) throw problem(429, 'Another sign-in attempt is being processed. Try again shortly.', 1);
    busy = true;
    try {
      const record = await readRecord();
      if (!validPassword(password)) {
        if (!setup) rejectLogin();
        throw problem(400, 'Use a password with 10 to 128 characters (at most 512 UTF-8 bytes).');
      }
      if (setup) {
        if (record) throw problem(409, 'The administrator password is already configured.');
        const salt = randomBytes(16).toString('hex');
        const hash = (await derive(Buffer.from(password, 'utf8'), Buffer.from(salt, 'hex'), 32, cost)).toString('hex');
        let file;
        try {
          await mkdir(store, { recursive: true, mode: 0o700 });
          file = await open(filename, 'wx', 0o600);
          await file.writeFile(JSON.stringify({ version: 1, salt, hash }), 'utf8'); await file.sync();
        } catch (error) {
          if (error.code === 'EEXIST') { await readRecord(); throw problem(409, 'The administrator password is already configured.'); }
          throw problem(503, 'Administrator credential storage is unavailable.');
        } finally { await file?.close(); }
      } else {
        if (!record) throw problem(409, 'Set the administrator password first.');
        const actual = await derive(Buffer.from(password, 'utf8'), Buffer.from(record.salt, 'hex'), 32, cost);
        const expected = Buffer.from(record.hash, 'hex');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) rejectLogin();
      }
      failures = 0; cooldownUntil = 0;
      return issue();
    } finally { busy = false; }
  }
  return {
    challenge,
    validChallenge: value => typeof value === 'string' && hex.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(challenge)),
    configured: async () => !!(await readRecord()), authorized, unlock,
    logout(request) { sessions.delete(requestId(request)); return cookie('', 0); }
  };
}
