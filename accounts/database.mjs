import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, realpath, chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_ACCOUNT_STORE = fileURLToPath(new URL('../work/customer-accounts', import.meta.url));
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (value, root) => same(value, root) || (process.platform === 'win32' ? value.toLowerCase().startsWith(root.toLowerCase() + path.sep) : value.startsWith(root + path.sep));

export async function noSymlinks(filename) {
  for (let current = path.resolve(filename); ; current = path.dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Account storage must not use redirected paths.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}
async function prospectivePath(filename) {
  let current = filename; const remaining = [];
  for (;;) {
    try { return path.resolve(await realpath(current), ...remaining); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
      remaining.unshift(path.basename(current)); current = path.dirname(current);
    }
  }
}
export async function privateDirectory(directory, { create = true, projectRoot = PROJECT_ROOT } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\x00-\x1f]/.test(directory) || /^(?:\\\\|\/\/)/.test(directory)) throw new Error('Choose an absolute private account directory.');
  const full = path.resolve(directory);
  const canonicalProject = await realpath(projectRoot);
  const forbidden = [projectRoot, canonicalProject].flatMap(root => ['dist', 'work/admin-auth', 'work/report-studio'].map(name => path.resolve(root, name)));
  if (forbidden.some(root => inside(full, root))) throw new Error('Account storage must be separate from public, administrator and report data.');
  await noSymlinks(full);
  const prospective = await prospectivePath(full);
  if (forbidden.some(root => inside(prospective, root))) throw new Error('Account storage must be separate from public, administrator and report data.');
  await noSymlinks(prospective);
  if (create) await mkdir(full, { recursive: true, mode: 0o700 });
  const canonical = await realpath(full);
  if (!same(canonical, prospective) || forbidden.some(root => inside(canonical, root))) throw new Error('Account storage must not use redirected paths.');
  await noSymlinks(canonical);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const filename = path.join(canonical, 'accounts.sqlite' + suffix);
    try { const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid account database file.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return canonical;
}
  const normalizeSQL = value => {
    let result = '', quoted = false;
    for (let index = 0; index < value.length; index++) {
      const character = value[index];
      if (character === "'") { result += character; if (quoted && value[index + 1] === "'") result += value[++index]; else quoted = !quoted; }
      else if (quoted || !/\s/.test(character)) result += character;
    }
    return result;
  };
export const accountSchemaObjects = connection => connection.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => [row.name, row.type, normalizeSQL(row.sql || '')]);
  const expected = text => { const memory = new DatabaseSync(':memory:'); try { memory.exec(text); return JSON.stringify(accountSchemaObjects(memory)); } finally { memory.close(); } };

export async function accountSchemaDefinitions() {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const migration = await readFile(new URL('./migrate-1-to-2.sql', import.meta.url), 'utf8');
  const schema2 = await readFile(new URL('./schema-v2.sql', import.meta.url), 'utf8');
  const migrationTo3 = await readFile(new URL('./migrate-2-to-3.sql', import.meta.url), 'utf8');
  const previousSchema = schema2.split('-- Transactional mail tables')[0]
    .replace(/,\s*email_verified_at INTEGER CHECK\(email_verified_at IS NULL OR email_verified_at>0\)/, '')
    .replace(/,\s*notification_revision INTEGER CHECK\(notification_revision IS NULL OR notification_revision>0\)/, '');
  return { schema, migration, migrationTo3, shapes: { 1: expected(previousSchema), 2: expected(schema2), 3: expected(schema) } };
}

export async function openAccountDatabase({ directory = DEFAULT_ACCOUNT_STORE, projectRoot = PROJECT_ROOT } = {}) {
  const { schema, migration, migrationTo3, shapes } = await accountSchemaDefinitions();
  const root = await privateDirectory(directory, { projectRoot });
  let db;
  try {
    db = new DatabaseSync(path.join(root, 'accounts.sqlite'), { enableForeignKeyConstraints: true, allowExtension: false });
    db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read under the writer lock: concurrent startups cannot reapply DDL.
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version === 0) {
        if (accountSchemaObjects(db).length) throw new Error('Unknown account database schema.');
        db.exec(schema);
      } else {
        if (![1,2,3].includes(version) || JSON.stringify(accountSchemaObjects(db)) !== shapes[version]) throw new Error('Invalid previous account schema.');
        if (version === 1) { db.exec(migration); if (JSON.stringify(accountSchemaObjects(db)) !== shapes[2]) throw new Error('Invalid intermediate account schema.'); }
        if (version <= 2) db.exec(migrationTo3);
      }
      if (db.prepare('PRAGMA user_version').get().user_version !== 3 || JSON.stringify(accountSchemaObjects(db)) !== shapes[3] || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Invalid account schema.');
      if (db.prepare('SELECT 1 FROM account_sessions WHERE (google_reauth_at IS NULL)<>(google_reauth_purpose IS NULL) LIMIT 1').get()) throw new Error('Invalid session grant.');
      db.prepare('SELECT id,email,email_verified_at,password_hash,security_version FROM account_users LIMIT 0').all();
      db.prepare('SELECT token_hash,csrf_hash FROM account_sessions LIMIT 0').all();
      db.prepare('SELECT event_key,nonce,tag,ciphertext,lease_id FROM account_mail_outbox LIMIT 0').all();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await chmod(path.join(root, 'accounts.sqlite'), 0o600);
  } catch { db?.close(); throw new Error('Customer account storage is unavailable.'); }
  let closed = false;
  return {
    directory: root,
    get: (sql, ...values) => db.prepare(sql).get(...values),
    all: (sql, ...values) => db.prepare(sql).all(...values),
    run: (sql, ...values) => db.prepare(sql).run(...values),
    exec: sql => db.exec(sql),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); if (result?.then) throw new Error('Account transactions must be synchronous.'); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { if (!closed) { closed = true; db.close(); } }
  };
}
