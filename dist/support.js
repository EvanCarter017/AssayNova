// Pure recovery-draft helpers. Importing this module never reads or writes storage.
export const SUPPORT_DRAFT_KEY = 'assaynova.support.recovery.v1';
const limits = Object.freeze({ email: 160, reference: 160, notes: 1200 });
const maxSerializedLength = 6 * Object.values(limits).reduce((sum, maximum) => sum + maximum, 0) + 128;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeSupport(values = {}) {
  return Object.fromEntries(Object.keys(limits).map((key) => [key, typeof values?.[key] === 'string' ? values[key].trim() : '']));
}

export function validateSupport(values) {
  const normalized = normalizeSupport(values);
  const errors = {};
  for (const [key, maximum] of Object.entries(limits)) {
    if (typeof values?.[key] !== 'string') errors[key] = 'Enter this information as text.';
    else if (values[key].length > maximum) errors[key] = `Use ${maximum} characters or fewer.`;
  }
  if (!errors.email && !emailPattern.test(normalized.email)) errors.email = 'Enter a valid email address used for testing.';
  if (!errors.reference && !normalized.reference) errors.reference = 'Enter your company or project name.';
  return errors;
}

export function parseSupportDraft(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > maxSerializedLength) return null;
    const value = JSON.parse(raw);
    const keys = ['version', 'email', 'reference', 'notes'];
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)) || value.version !== 1 || Object.keys(validateSupport(value)).length) return null;
    return { version: 1, ...normalizeSupport(value) };
  } catch { return null; }
}

export function formatSupportRequest(values) {
  if (Object.keys(validateSupport(values)).length) throw new TypeError('A recovery request needs valid contact details.');
  const draft = normalizeSupport(values);
  return `AssayNova / Nova Support — Report recovery request\n\nTesting email: ${draft.email}\nCompany or project: ${draft.reference}\nAdditional context: ${draft.notes || 'Not provided'}\n\nPlease help identify the relevant report and let me know what additional verification is required before it can be shared.`;
}
