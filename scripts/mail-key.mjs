import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateMailPath } from '../accounts/mail-config.mjs';

export async function createMailKey({ output, projectRoot, forbidden } = {}) {
  const filename = await privateMailPath(output, { projectRoot, forbidden, exists: false });
  const file = await open(filename, 'wx', 0o600);
  try { await file.writeFile(randomBytes(32)); await file.sync(); } finally { await file.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { if (process.argv.length !== 3 || !process.argv[2].startsWith('--output=')) throw Error(); await createMailKey({ output: process.argv[2].slice(9) }); console.log('Mail encryption key created. Keep it private with protected backups.'); }
  catch { console.error('Mail encryption key could not be created. Existing files are unchanged.'); process.exitCode = 1; }
}
