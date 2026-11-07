import { parseRequestRecord, normalizeSubmission, validateSubmissionState, REQUEST_LIMITS } from './submission.js';
import { CONTACT_TOPICS, normalizeContact, validateContact } from './contact.js';
import { normalizeSupport, validateSupport } from './support.js';

// Pure wire contract. Nothing in this module touches storage, network or DOM.
export const REQUEST_KINDS = Object.freeze({ testing: 'Testing', contact: 'Contact', 'report-recovery': 'Report recovery' });
const envelope = ['version', 'id', 'createdAt', 'kind', 'status', 'details'];
const testing = ['name', 'email', 'company', 'notes', 'reportRecipient', 'samples'];
const sample = ['id', 'name', 'service', 'quantity', 'batch', 'form', 'amount', 'image', 'imageStyle'];
const contact = ['name', 'email', 'topic', 'message'];
const support = ['email', 'reference', 'notes'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const dataProperty = (value, key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor?.enumerable && Object.hasOwn(descriptor, 'value'); };
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => dataProperty(value, key));
const list = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, index) => index).every(index => dataProperty(value, String(index)));
const text = (value, limit) => typeof value === 'string' && value.length <= limit;
const identity = value => text(value?.id, 71) && /^AN-REQ-[A-Z0-9-]{1,64}$/.test(value.id) && typeof value.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) && Number.isFinite(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt;
// Each UTF-16 code unit occupies at most six JSON bytes (escaped controls or
// lone surrogates). Includes ten complete samples, envelope, keys and API wrap.
const sampleBudget = 64 + 160 + 160 + 80 + 32 + 16 + 16 + 16;
const detailsBudget = Math.max(10 * sampleBudget + 100 + 160 + 160 + 1200 + 160, 120 + 160 + 7 + 4000, 160 + 160 + 1200);
export const MAX_ACCOUNT_REQUEST_BYTES = 6 * (detailsBudget + 71 + 24 + 15 + 9) + 4096;
export const MAX_ACCOUNT_REQUEST_BODY_BYTES = MAX_ACCOUNT_REQUEST_BYTES + 256;

function rawDetails(kind, value, canonical = false) {
  if (kind === 'testing') {
    if (!exact(value, testing) || testing.slice(0, -1).some(key => !text(value[key], REQUEST_LIMITS[key])) || !list(value.samples) || value.samples.length < 1 || value.samples.length > 10) return false;
    return value.samples.every(item => exact(item, sample) && sample.filter(key => key !== 'quantity').every(key => text(item[key], ({ id: 64, name: 160, batch: 160, amount: 80, service: 32, form: 16, image: 16, imageStyle: 16 })[key])) && (typeof item.quantity === 'number' || !canonical && typeof item.quantity === 'string' && item.quantity.length <= 3));
  }
  const keys = kind === 'contact' ? contact : kind === 'report-recovery' ? support : null;
  const limits = kind === 'contact' ? { name: 120, email: 160, topic: 7, message: 4000 } : { email: 160, reference: 160, notes: 1200 };
  return !!keys && exact(value, keys) && keys.every(key => text(value[key], limits[key]));
}
const normalize = (kind, value) => kind === 'testing' ? normalizeSubmission(value) : kind === 'contact' ? normalizeContact(value) : normalizeSupport(value);
const valid = (kind, value) => Object.keys(kind === 'testing' ? validateSubmissionState(value, 0) : kind === 'contact' ? validateContact(value) : validateSupport(value)).length === 0;

export function createAccountRequest(kind, details, reference) {
  if (!Object.hasOwn(REQUEST_KINDS, kind) || !identity(reference) || !rawDetails(kind, details) || !valid(kind, details)) throw new TypeError('Check the request details before submitting.');
  const normalized = normalize(kind, details);
  if (!rawDetails(kind, normalized, true) || !valid(kind, normalized)) throw new TypeError('Check the request details before submitting.');
  const record = { version: 3, id: reference.id, createdAt: reference.createdAt, kind, status: 'Submitted', details: normalized };
  if (new TextEncoder().encode(JSON.stringify(record)).length > MAX_ACCOUNT_REQUEST_BYTES) throw new TypeError('The request is too large.');
  return record;
}

export function parseAccountRequest(value) {
  try {
    if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !dataProperty(value, key))) return null;
    if (value?.version === 2) {
      if (!list(value.samples) || value.samples.some(item => !exact(item, sample)) || !parseRequestRecord(value)) return null;
      // Validate with the unchanged v2 parser, then preserve every original byte
      // represented by its fields. Reads must never silently promote old rows.
      return value;
    }
    if (!exact(value, envelope) || value.version !== 3 || value.status !== 'Submitted' || !Object.hasOwn(REQUEST_KINDS, value.kind) || !identity(value) || !rawDetails(value.kind, value.details, true)) return null;
    const record = createAccountRequest(value.kind, value.details, value);
    if (JSON.stringify(value.details) !== JSON.stringify(record.details)) return null;
    return record;
  } catch { return null; }
}
export const requestKind = record => record.version === 2 ? 'testing' : record.kind;
export const requestDetails = record => record.version === 2 ? normalizeSubmission(record) : record.details;
export const requestStatus = record => record.version === 2 ? 'Saved · Not submitted' : 'Submitted';
export function requestSummary(record) {
  const value = requestDetails(record), kind = requestKind(record);
  return kind === 'testing' ? value.samples[0].name : kind === 'contact' ? CONTACT_TOPICS[value.topic] : value.reference;
}
