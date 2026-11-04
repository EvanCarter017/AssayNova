export const CONTACT_DRAFT_KEY = 'assaynova.contact.enquiry.v1';
export const CONTACT_TOPICS = Object.freeze({ testing: 'Testing enquiry', report: 'Report question', website: 'Website issue', other: 'Something else' });
const keys = ['name', 'email', 'topic', 'message'];
const limits = { name: 120, email: 160, topic: 7, message: 4000 };
const bindings = new WeakMap();

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

export function createContactForm(form, options = {}) {
  if (!form) return null;
  if (bindings.has(form)) return bindings.get(form);
  const storage = options.storage || { getItem: key => globalThis.localStorage.getItem(key), setItem: (key, value) => globalThis.localStorage.setItem(key, value), removeItem: key => globalThis.localStorage.removeItem(key) };
  const clipboard = options.clipboard || { writeText: value => globalThis.navigator.clipboard.writeText(value) };
  const fields = Object.fromEntries(keys.map(key => [key, form.querySelector('#contact-' + key)]));
  const fieldErrors = Object.fromEntries(keys.map(key => [key, form.querySelector('#contact-error-' + key)]));
  const error = form.querySelector('#contact-error');
  const status = form.querySelector('#contact-status');
  const fallback = form.querySelector('#contact-copy-fallback');
  const copyValue = form.querySelector('#contact-copy-value');
  if ([...Object.values(fields), ...Object.values(fieldErrors), error, status, fallback, copyValue].some(node => !node)) throw new TypeError('Contact form controls are incomplete');
  let revision = 0;
  const current = () => Object.fromEntries(keys.map(key => [key, fields[key].value]));
  function beginAction() {
    revision++;
    error.textContent = '';
    status.textContent = '';
    fallback.hidden = true;
    copyValue.value = '';
  }
  function clearErrors() {
    for (const key of keys) { fields[key].removeAttribute('aria-invalid'); fieldErrors[key].textContent = ''; }
  }
  function validated() {
    const value = current();
    const errors = validateContact(value);
    for (const key of keys) {
      fieldErrors[key].textContent = errors[key] || '';
      if (errors[key]) fields[key].setAttribute('aria-invalid', 'true');
      else fields[key].removeAttribute('aria-invalid');
    }
    const first = keys.find(key => errors[key]);
    if (first) { fields[first].focus(); return null; }
    return normalizeContact(value);
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    beginAction();
    const value = validated();
    if (!value) return;
    try {
      const serialized = JSON.stringify({ version: 1, ...value });
      storage.setItem(CONTACT_DRAFT_KEY, serialized);
      if (storage.getItem(CONTACT_DRAFT_KEY) !== serialized) throw new Error('Draft was not persisted');
      status.textContent = 'Draft saved on this device. No message has been sent.';
    } catch { error.textContent = 'Your draft could not be saved. Keep your message here or copy it.'; }
  });
  const onInput = event => {
    const key = keys.find(key => fields[key] === event.target);
    if (!key) return;
    beginAction();
    fields[key].removeAttribute('aria-invalid');
    fieldErrors[key].textContent = '';
  };
  form.addEventListener('input', onInput);
  form.addEventListener('change', onInput);
  form.addEventListener('click', async event => {
    const button = event.target.closest('[data-contact-action]');
    if (!button || !form.contains(button)) return;
    event.preventDefault();
    const action = button.dataset.contactAction;
    if (action === 'select') { copyValue.focus(); copyValue.select(); return; }
    if (!['copy', 'restore', 'clear'].includes(action)) return;
    beginAction();
    if (action === 'restore') {
      try {
        const raw = storage.getItem(CONTACT_DRAFT_KEY);
        if (raw === null) { status.textContent = 'No saved contact draft was found. Your current message is unchanged.'; return; }
        const value = parseContactDraft(raw);
        if (!value) { error.textContent = 'The saved draft could not be opened. Your current message is unchanged.'; return; }
        for (const key of keys) fields[key].value = value[key];
        clearErrors();
        status.textContent = 'Saved draft restored. No message has been sent.';
      } catch { error.textContent = 'Your saved draft could not be read. Your current message is unchanged.'; }
      return;
    }
    if (action === 'clear') {
      try {
        storage.removeItem(CONTACT_DRAFT_KEY);
        if (storage.getItem(CONTACT_DRAFT_KEY) !== null) throw new Error('Draft was not removed');
        clearErrors();
        status.textContent = 'Saved contact draft cleared. Your current message is still here.';
      } catch { error.textContent = 'Your saved draft could not be cleared. Your current message is unchanged.'; }
      return;
    }
    const value = validated();
    if (!value) return;
    const text = formatContactMessage(value);
    const ticket = revision;
    const snapshot = JSON.stringify(current());
    const stillCurrent = () => revision === ticket && form.isConnected && !form.closest('[hidden]') && !form.ownerDocument?.hidden && JSON.stringify(current()) === snapshot;
    try {
      await clipboard.writeText(text);
      if (stillCurrent()) status.textContent = 'Message copied. No message has been sent.';
    } catch {
      if (!stillCurrent()) return;
      fallback.hidden = false;
      copyValue.value = text;
      copyValue.focus();
      copyValue.select();
    }
  });
  const controller = Object.freeze({});
  bindings.set(form, controller);
  for (const button of form.querySelectorAll('button')) button.disabled = false;
  return controller;
}
