import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { PROJECT_ROOT, noSymlinks } from './database.mjs';

const unavailable = () => new Error('Transactional mail configuration is unavailable.');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const mailOff = () => Object.freeze({ enabled: false, reportNoticesEnabled: false });
export function validMailbox(value) {
  if (typeof value !== 'string' || value.length > 254 || /[^\x21-\x7e]/.test(value)) return false;
  const pieces = value.split('@'); if (pieces.length !== 2) return false;
  const [local, domain] = pieces;
  return local.length >= 1 && local.length <= 64 && /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local) && validMailHost(domain.toLowerCase());
}
export const validMailHost = value => typeof value === 'string' && value.length <= 253 && value === value.toLowerCase() && value.includes('.') && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) && !/^\d+(?:\.\d+){3}$/.test(value);
export const isResendSMTPAuth = (host, username) => host === 'smtp.resend.com' && username === 'resend';

// Small bounded JSON grammar: objects, strings, finite numbers, booleans/null.
// Decoded keys are checked before assignment, including escaped duplicates.
export function parseMailConfigJSON(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 16384) throw unavailable();
  let index = 0;
  const space = () => { while (/[\t\r\n ]/.test(source[index] || '\0')) index++; };
  function string() {
    const start = index++; let escaped = false;
    while (index < source.length) { const character = source[index++]; if (!escaped && character === '"') { const result = JSON.parse(source.slice(start, index)); if (result.length > 4096) throw unavailable(); return result; } if (!escaped && character === '\\') escaped = true; else escaped = false; }
    throw unavailable();
  }
  function value(depth) {
    if (depth > 4) throw unavailable(); space();
    if (source[index] === '"') return string();
    if (source[index] === '{') {
      index++; const object = Object.create(null); space(); if (source[index] === '}') { index++; return object; }
      for (;;) { space(); if (source[index] !== '"') throw unavailable(); const key = string(); if (Object.hasOwn(object, key)) throw unavailable(); space(); if (source[index++] !== ':') throw unavailable(); object[key] = value(depth + 1); space(); const next = source[index++]; if (next === '}') return object; if (next !== ',') throw unavailable(); }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) if (source.startsWith(literal, index)) { index += literal.length; return result; }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index));
    if (!number || !Number.isFinite(Number(number[0]))) throw unavailable(); index += number[0].length; return Number(number[0]);
  }
  try { const result = value(0); space(); if (index !== source.length) throw unavailable(); return result; } catch { throw unavailable(); }
}
const inside = (file, root) => { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
export async function privateMailPath(filename, { projectRoot = PROJECT_ROOT, forbidden = [], exists = true } = {}) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || /^[\\/]{2}/.test(filename) || /[\x00-\x1f\x7f\uD800-\uDFFF]/.test(filename) || filename.split(/[\\/]/).some(part => part === '.' || part === '..')) throw unavailable();
  const full = path.resolve(filename), project = await realpath(projectRoot);
  if ([path.resolve(projectRoot), project, ...forbidden.filter(Boolean).map(root => path.resolve(root))].some(root => inside(full, root))) throw unavailable();
  await noSymlinks(full);
  const parent = await realpath(path.dirname(full));
  if (process.platform === 'win32' ? path.resolve(parent, path.basename(full)).toLowerCase() !== full.toLowerCase() : path.resolve(parent, path.basename(full)) !== full) throw unavailable();
  const directory = await lstat(parent);
  if (!directory.isDirectory() || process.platform !== 'win32' && (directory.uid !== process.getuid() || directory.mode & 0o077)) throw unavailable();
  if (exists) { const info = await lstat(full); if (!info.isFile() || info.isSymbolicLink() || process.platform !== 'win32' && (info.uid !== process.getuid() || info.mode & 0o077)) throw unavailable(); }
  return full;
}
export async function readPrivateMailFile(filename, maximum, options) {
  const full = await privateMailPath(filename, options), info = await lstat(full);
  if (info.size < 1 || info.size > maximum) throw unavailable();
  const file = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { const actual = await file.stat(); if (!actual.isFile() || actual.dev !== info.dev || actual.ino !== info.ino || actual.size !== info.size) throw unavailable();
    const bytes = Buffer.alloc(info.size + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0); if (bytesRead !== info.size) throw unavailable(); await noSymlinks(full); return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}
export async function loadMailConfig({ filename = process.env.ASSAYNOVA_MAIL_CONFIG_FILE, accountOrigin, adminOrigin, projectRoot = PROJECT_ROOT, accountDirectory, reportDirectory, adminAuthDirectory } = {}) {
  if (!filename) return mailOff();
  try {
    const options = { projectRoot, forbidden: [accountDirectory, reportDirectory, adminAuthDirectory] };
    const value = parseMailConfigJSON(new TextDecoder('utf-8', { fatal: true }).decode(await readPrivateMailFile(filename, 16384, options)));
    if (!exact(value, ['version', 'enabled', 'publicOrigin', 'smtp', 'outboxKeyFile', 'reportNoticesEnabled']) || value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.reportNoticesEnabled !== 'boolean') throw unavailable();
    if (!value.enabled) { if (value.publicOrigin !== null || value.smtp !== null || value.outboxKeyFile !== null || value.reportNoticesEnabled) throw unavailable(); return mailOff(); }
    const origin = new URL(value.publicOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== value.publicOrigin || value.publicOrigin !== accountOrigin || value.reportNoticesEnabled && value.publicOrigin !== adminOrigin) throw unavailable();
    const smtp = value.smtp;
    if (!exact(smtp, ['host', 'port', 'username', 'passwordFile', 'from', 'supportTo']) || !validMailHost(smtp.host) || smtp.port !== 587 || !validMailbox(smtp.from) || !validMailbox(smtp.supportTo) || !(validMailbox(smtp.username) && smtp.username === smtp.from || isResendSMTPAuth(smtp.host, smtp.username)) || smtp.from !== smtp.supportTo) throw unavailable();
    const passwordBytes = await readPrivateMailFile(smtp.passwordFile, 4096, options);
    const password = new TextDecoder('utf-8', { fatal: true }).decode(passwordBytes).replace(/\r?\n$/, '');
    if (!password || /[\x00\r\n]/.test(password)) throw unavailable();
    const key = await readPrivateMailFile(value.outboxKeyFile, 32, options); if (key.length !== 32) throw unavailable();
    return Object.freeze({ enabled: true, publicOrigin: value.publicOrigin, reportNoticesEnabled: value.reportNoticesEnabled, smtp: Object.freeze({ host: smtp.host, port: smtp.port, username: smtp.username, password, from: smtp.from, supportTo: smtp.supportTo }), key: Buffer.from(key) });
  } catch { throw unavailable(); }
}
