export const accountError = (status, code, message, retryAfter) => Object.assign(new Error(message), { status, code, retryAfter });
export function exactInput(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw accountError(400, 'INVALID_INPUT', 'Check the supplied account details.');
  return value;
}
export const validUnicode = value => typeof value === 'string' && value.isWellFormed();
export function text(value, maximum) {
  if (!validUnicode(value) || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw accountError(400, 'INVALID_INPUT', 'Check the supplied account details.');
  return value.trim();
}
export function emailKey(value) {
  const email = text(value, 160).toLowerCase();
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw accountError(400, 'INVALID_INPUT', 'Enter a valid email address.');
  return email;
}
