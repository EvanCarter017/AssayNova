import { SERVICE_NAMES } from './data.js';

// Pure request state and compatibility helpers. No storage, files or network I/O.
export const REQUEST_DRAFT_KEY = 'assaynova.prototype.requests.v1';
export const REQUEST_LIMITS = Object.freeze({ entries: 10, quantity: 100, name: 100, email: 160, company: 160, notes: 1200, reportRecipient: 160, sampleName: 160, batch: 160, amount: 80, id: 64 });
export const SAMPLE_FORMS = Object.freeze({ vial: 'Vial', powder: 'Powder', capsule: 'Capsule', other: 'Other' });
export const IMAGE_CHOICES = Object.freeze({ none: 'No image', include: 'Include a product image' });
export const IMAGE_STYLES = Object.freeze({ branded: 'Branded label', unlabelled: 'Unlabelled image' });
const contactKeys = ['name', 'email', 'company', 'notes', 'reportRecipient'];
const sampleKeys = ['id', 'name', 'service', 'quantity', 'batch', 'form', 'amount', 'image', 'imageStyle'];
const recordKeys = ['version', 'id', 'createdAt', 'status', ...contactKeys, 'sample', 'service', 'quantity', 'samples'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const clean = value => typeof value === 'string' ? value.trim() : '';
const stableId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const enumValue = (value, choices) => typeof value === 'string' && Object.hasOwn(choices, value);
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sampleTextBudget = REQUEST_LIMITS.id + REQUEST_LIMITS.sampleName + REQUEST_LIMITS.batch + REQUEST_LIMITS.amount + 32 + 16 + 16 + 16;
const contactTextBudget = contactKeys.reduce((sum, key) => sum + REQUEST_LIMITS[key], 0);
export const MAX_REQUEST_RECORD_CHARS = 6 * (REQUEST_LIMITS.entries * sampleTextBudget + contactTextBudget + 80 + 24 + 32 + 160 + 32) + 2048;
const maxListChars = MAX_REQUEST_RECORD_CHARS * 50 + 128;

export function newSample(id, service = 'comprehensive') {
  if (!stableId(id)) throw new TypeError('A sample needs a stable ID.');
  return { id, name: '', service: enumValue(service, SERVICE_NAMES) ? service : 'comprehensive', quantity: 1, batch: '', form: 'vial', amount: '', image: 'none', imageStyle: 'branded' };
}

export function newSubmission(sampleId, service) {
  return { name: '', email: '', company: '', notes: '', reportRecipient: '', samples: [newSample(sampleId, service)] };
}

export function normalizeSubmission(state) {
  return { ...Object.fromEntries(contactKeys.map(key => [key, clean(state?.[key])])), samples: Array.isArray(state?.samples) ? state.samples.map(sample => ({ id: clean(sample?.id), name: clean(sample?.name), service: sample?.service, quantity: Number(sample?.quantity), batch: clean(sample?.batch), form: sample?.form, amount: clean(sample?.amount), image: sample?.image, imageStyle: sample?.imageStyle })) : [] };
}

export function submissionTotals(state) {
  const samples = Array.isArray(state?.samples) ? state.samples : [];
  return { entries: samples.length, units: samples.reduce((sum, sample) => { const quantity = Number(sample.quantity); return sum + (Number.isInteger(quantity) && quantity >= 1 && quantity <= 100 ? quantity : 0); }, 0) };
}

export function validateSubmissionState(state, step = 0) {
  const errors = {};
  if (!object(state)) return { samples: 'Add your sample details.' };
  const validateText = (value, maximum, required, key, label) => {
    if (typeof value !== 'string') errors[key] = `Enter ${label} as text.`;
    else if (value.length > maximum) errors[key] = `Use ${maximum} characters or fewer.`;
    else if (required && !value.trim()) errors[key] = `Enter ${label}.`;
  };
  if (step === 0 || step === 1) {
    if (!Array.isArray(state.samples) || state.samples.length < 1 || state.samples.length > 10) errors.samples = 'Include between 1 and 10 sample entries.';
    else {
      const ids = new Set();
      for (const sample of state.samples) {
        if (!object(sample) || !stableId(sample.id) || ids.has(sample.id)) { errors.samples = 'Each sample needs its own valid reference.'; continue; }
        ids.add(sample.id);
        const key = name => `sample:${sample.id}:${name}`;
        validateText(sample.name, 160, true, key('name'), 'a sample or project name');
        validateText(sample.batch, 160, false, key('batch'), 'a batch or lot');
        validateText(sample.amount, 80, false, key('amount'), 'the stated amount');
        if (!enumValue(sample.service, SERVICE_NAMES)) errors[key('service')] = 'Choose a testing service.';
        if (!['string', 'number'].includes(typeof sample.quantity) || String(sample.quantity).trim() === '' || !Number.isInteger(Number(sample.quantity)) || Number(sample.quantity) < 1 || Number(sample.quantity) > 100) errors[key('quantity')] = 'Choose between 1 and 100 planned units.';
        if (!enumValue(sample.form, SAMPLE_FORMS)) errors[key('form')] = 'Choose a sample form.';
      }
    }
  }
  if (step === 0 || step === 2) {
    for (const key of contactKeys) validateText(state[key], REQUEST_LIMITS[key], ['name', 'email'].includes(key), key, key === 'name' ? 'your name' : key === 'email' ? 'a contact email' : key === 'reportRecipient' ? 'a report recipient or company name' : key);
    if (!errors.email && !email.test(state.email.trim())) errors.email = 'Enter a valid email address.';
    if (Array.isArray(state.samples)) for (const sample of state.samples) {
      if (!object(sample) || !stableId(sample.id)) { errors.samples = 'Check the sample entries first.'; continue; }
      if (!enumValue(sample.image, IMAGE_CHOICES)) errors[`sample:${sample.id}:image`] = 'Choose a product image option.';
      if (!enumValue(sample.imageStyle, IMAGE_STYLES)) errors[`sample:${sample.id}:imageStyle`] = 'Choose an image style.';
    }
  }
  return errors;
}

export function duplicateSubmissionSample(state, id, newId) {
  if (!stableId(newId) || !Array.isArray(state.samples) || state.samples.length >= 10 || state.samples.some(sample => sample.id === newId)) throw new TypeError('A request can contain up to 10 distinct sample entries.');
  const index = state.samples.findIndex(sample => sample.id === id);
  if (index < 0) throw new TypeError('Sample entry not found.');
  const samples = state.samples.map(sample => ({ ...sample }));
  samples.splice(index + 1, 0, { ...samples[index], id: newId });
  return { ...state, samples };
}

export function effectiveReportRecipient(state) {
  return clean(state.reportRecipient) || clean(state.name);
}

export function createRequestRecord(state, { id, createdAt }) {
  if (Object.keys(validateSubmissionState(state)).length || typeof id !== 'string' || !/^AN-REQ-[A-Z0-9-]{1,64}$/.test(id) || typeof createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(createdAt) || Number.isNaN(Date.parse(createdAt))) throw new TypeError('Check all request details before saving.');
  const normalized = normalizeSubmission(state);
  return { version: 2, id, createdAt, status: 'Draft request', ...normalized, sample: normalized.samples[0].name, service: normalized.samples[0].service, quantity: submissionTotals(normalized).units };
}

export function parseRequestRecord(value) {
  try {
    if (!exact(value, recordKeys) || value.version !== 2 || value.status !== 'Draft request' || !Array.isArray(value.samples) || value.samples.some(sample => !exact(sample, sampleKeys) || typeof sample.quantity !== 'number') || Object.keys(validateSubmissionState(value)).length || typeof value.quantity !== 'number') return null;
    const record = createRequestRecord(value, value);
    if (value.sample !== record.sample || value.service !== record.service || value.quantity !== record.quantity || value.quantity < 1 || value.quantity > 1000 || JSON.stringify(value).length > MAX_REQUEST_RECORD_CHARS) return null;
    return record;
  } catch { return null; }
}

export function requestStateFromRecord(value) {
  const record = parseRequestRecord(value);
  if (!record) return null;
  return normalizeSubmission(record);
}

export function isLegacyRequest(value) {
  return object(value) && !Object.hasOwn(value, 'version') && typeof value.id === 'string' && typeof value.sample === 'string' && enumValue(value.service, SERVICE_NAMES);
}

// Explicit user-selected conversion only. The legacy list is never rewritten.
export function legacyRequestState(value, sampleId) {
  if (!isLegacyRequest(value)) return null;
  const state = newSubmission(sampleId, value.service);
  for (const key of ['name', 'email', 'company', 'notes']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return null;
    state[key] = value[key] ?? '';
  }
  state.samples[0].name = value.sample;
  if (!['string', 'number'].includes(typeof value.quantity)) return null;
  state.samples[0].quantity = value.quantity;
  return Object.keys(validateSubmissionState(state)).length ? null : normalizeSubmission(state);
}

export function decodeRequestList(raw) {
  try {
    if (raw === null || raw === undefined) return [];
    if (typeof raw !== 'string' || raw.length > maxListChars) return null;
    const values = JSON.parse(raw);
    return Array.isArray(values) ? values : null;
  } catch { return null; }
}

export function readableRequests(raw) {
  return (decodeRequestList(raw) || []).flatMap(value => {
    if (object(value) && Object.hasOwn(value, 'version')) { const record = parseRequestRecord(value); return record ? [record] : []; }
    return isLegacyRequest(value) ? [value] : [];
  }).slice(0, 50);
}

export function prepareRequestSave(raw, value) {
  const values = decodeRequestList(raw);
  const record = parseRequestRecord(value);
  if (!values || !record) throw new TypeError('Stored drafts could not be read safely. Nothing was changed.');
  const existing = values.findIndex(item => parseRequestRecord(item)?.id === record.id);
  const next = values.filter(item => parseRequestRecord(item)?.id !== record.id);
  next.splice(existing < 0 ? 0 : Math.min(existing, next.length), 0, record);
  const serialized = JSON.stringify(next.slice(0, 50));
  if (serialized.length > maxListChars) throw new TypeError('These drafts exceed this device’s storage limit. Nothing was changed.');
  return serialized;
}
