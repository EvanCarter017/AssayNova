import { DatabaseSync, backup } from 'node:sqlite';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateDirectory, noSymlinks } from '../accounts/database.mjs';

export async function backupAccounts({ directory, output, projectRoot } = {}) {
  if (typeof output !== 'string' || !path.isAbsolute(output)) throw new Error('Choose an absolute new account-backup filename.');
  const root = await privateDirectory(directory, { create: false, projectRoot });
  const parent = await privateDirectory(path.dirname(output), { projectRoot });
  const destination = path.join(parent, path.basename(output)), source = path.join(root, 'accounts.sqlite');
  if (path.resolve(destination).toLowerCase() === path.resolve(source).toLowerCase()) throw new Error('The backup must use a new destination.');
  await noSymlinks(destination);
  // Reserve a new filename exclusively. Native backup may write only this file,
  // never an existing owner file. A failed backup is retained for inspection.
  const reservation = await open(destination, 'wx', 0o600); await reservation.close();
  let db, check;
  try {
    db = new DatabaseSync(source, { readOnly: true, allowExtension: false });
    if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error();
    await backup(db, destination);
    check = new DatabaseSync(destination, { readOnly: true, allowExtension: false });
    if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || check.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error();
    return { ok: true, schemaVersion: 1 };
  } catch { throw new Error('Customer account backup failed. Retain the incomplete destination for owner inspection.'); }
  finally { check?.close(); db?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const value = key => { const matches = process.argv.slice(2).filter(argument => argument.startsWith(key + '=')); if (matches.length !== 1) throw new Error('Supply --store=ABS_DIRECTORY and --output=ABS_NEW_FILE once.'); return matches[0].slice(key.length + 1); };
    await backupAccounts({ directory: value('--store'), output: value('--output') });
    console.log('Customer account backup verified.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
