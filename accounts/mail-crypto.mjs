import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { validMailbox } from './mail-config.mjs';

export class MailCryptoError extends Error { constructor(code) { super('Mail payload is unavailable.'); this.code = code; } }
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const mailKeyId = key => { if (!Buffer.isBuffer(key) || key.length !== 32) throw new MailCryptoError('unavailable'); return createHash('sha256').update(key).digest('hex').slice(0, 16); };
const aad = (event, keyId) => Buffer.from(JSON.stringify([1, event.event_key, event.kind, event.recipient_kind, keyId]));
export function validMailPayload(value) {
  return exact(value, ['version', 'to', 'messageId', 'date', 'subject', 'body']) && value.version === 1 && validMailbox(value.to) && typeof value.messageId === 'string' && /^<[a-f0-9]{64}@[a-z0-9.-]+>$/.test(value.messageId) && typeof value.date === 'string' && new Date(value.date).toUTCString() === value.date && typeof value.subject === 'string' && /^[\x20-\x7e]{1,120}$/.test(value.subject) && typeof value.body === 'string' && Buffer.byteLength(value.body) <= 65536 && !value.body.includes('\0');
}
export function encryptMailPayload(key, event, payload) {
  if (!validMailPayload(payload)) throw new MailCryptoError('integrity');
  const raw = Buffer.from(JSON.stringify(payload)); if (raw.length > 98304) throw new MailCryptoError('integrity');
  const key_id = mailKeyId(key), nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(event, key_id)); const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  return { key_id, nonce, tag: cipher.getAuthTag(), ciphertext };
}
export function decryptMailPayload(key, event, encrypted) {
  const id = mailKeyId(key); if (encrypted.key_id !== id) throw new MailCryptoError('unavailable');
  try {
    if (encrypted.nonce.length !== 12 || encrypted.tag.length !== 16 || encrypted.ciphertext.length < 1 || encrypted.ciphertext.length > 98304) throw Error();
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.nonce); decipher.setAAD(aad(event, id)); decipher.setAuthTag(encrypted.tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8'));
    if (!validMailPayload(payload)) throw Error(); return payload;
  } catch { throw new MailCryptoError('integrity'); }
}
