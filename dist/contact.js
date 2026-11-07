export const CONTACT_DRAFT_KEY = 'assaynova.contact.enquiry.v1';
export const CONTACT_TOPICS = Object.freeze({ testing: 'Testing enquiry', report: 'Report question', website: 'Website issue', other: 'Something else' });
const keys = ['name', 'email', 'topic', 'message'];
const limits = { name: 120, email: 160, topic: 7, message: 4000 };

export function normalizeContact(input) {
  return Object.fromEntries(keys.map(key => [key, typeof input?.[key] === 'string' ? input[key].trim() : '']));
}

export function validateContact(input) {
  const errors = {};
  for (const key of keys) {
    if (typeof input?.[key] !== 'string') errors[key] = 'Enter a valid ' + (key === 'name' ? 'name.' : key + '.');
    else if (input[key].length > limits[key]) errors[key] = key === 'topic' ? 'Select one of the listed topics.' : `Use ${limits[key]} characters or fewer.`;
  }
  const values = normalizeContact(input);
  if (!errors.name && !values.name) errors.name = 'Enter your name.';
  if (!errors.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = 'Enter a valid email address.';
  if (!errors.topic && !Object.hasOwn(CONTACT_TOPICS, input.topic)) errors.topic = 'Select a topic.';
  if (!errors.message && !values.message) errors.message = 'Enter your message.';
  return errors;
}

export function parseContactDraft(raw) {
  try {
    if (typeof raw !== 'string' || !raw || raw.length > 6 * (120 + 160 + 7 + 4000) + 128) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || Object.keys(value).length !== 5 || !['version', ...keys].every(key => Object.hasOwn(value, key)) || Object.keys(validateContact(value)).length) return null;
    return normalizeContact(value);
  } catch { return null; }
}

export function formatContactMessage(input) {
  const value = normalizeContact(input);
  return `AssayNova / Contact enquiry\n\nName: ${value.name}\nEmail: ${value.email}\nTopic: ${CONTACT_TOPICS[value.topic] || ''}\n\nMessage:\n${value.message}`;
}
