export const SERVICE_NAMES = Object.freeze({
  purity: 'Purity analysis',
  identity: 'Identity confirmation',
  comprehensive: 'Comprehensive panel',
  custom: 'Custom testing'
});

export function normalizeLookupCode(value) {
  if (typeof value !== 'string' || value.length > 128) return '';
  const code = value.trim().toUpperCase();
  return /^AN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) ? code : '';
}

// Invalid input gets a fixed, recoverable URL rather than leaking it into a path.
// Valid-looking unknown codes keep their exact identity, with no first-record fallback.
export function lookupResultPath(value) {
  const code = normalizeLookupCode(value);
  return code ? '/coa/' + code : '/coa/not-found';
}

// Accept one narrow, URL-safe segment only; no asset or arbitrary-path fallback.
export function resolveCOARoute(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const match = /^\/coa\/([a-z0-9-]{1,64})\/?$/i.exec(decoded);
  if (!match) return null;
  return { code: normalizeLookupCode(match[1]) };
}

export function validateSubmission(values) {
  const errors = {};
  if (!String(values.name ?? '').trim()) errors.name = 'Enter your name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(values.email ?? '').trim())) errors.email = 'Enter a valid email address.';
  if (!String(values.sample ?? '').trim()) errors.sample = 'Enter a sample or project name.';
  if (!Object.hasOwn(SERVICE_NAMES, values.service)) errors.service = 'Choose a testing service.';
  if (!Number.isInteger(Number(values.quantity)) || Number(values.quantity) < 1 || Number(values.quantity) > 100) errors.quantity = 'Choose between 1 and 100 samples.';
  return errors;
}
