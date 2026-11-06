import { SUPPORT_DRAFT_KEY } from '../support.js';
import { CONTACT_DRAFT_KEY } from '../contact.js';
export { SUPPORT_DRAFT_KEY, CONTACT_DRAFT_KEY };

// First-party permission boundary. No service is imported or started by this module.
export const POLICY = Object.freeze({ version: 1, revision: 1, days: 180, cookie: 'assaynova_privacy' });
export const DRAFT_KEY = 'assaynova.prototype.requests.v1';
export const CATALOG = Object.freeze({ purposes: Object.freeze([]), services: Object.freeze([]) });
const duration = POLICY.days * 86400000;
const kinds = ['functional', 'analytics', 'marketing', 'sale', 'sharing'];
const restrictedKinds = ['marketing', 'sale', 'sharing'];
const idPattern = /^[a-z][a-z0-9_-]{0,39}$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const unique = (items) => new Set(items).size === items.length;
const protectedStorage = (key) => key === DRAFT_KEY || key === SUPPORT_DRAFT_KEY || key === CONTACT_DRAFT_KEY || key === POLICY.cookie || key.startsWith('assaynova.privacy');

export function validateCatalog(input) {
  if (!exactKeys(input, ['purposes', 'services']) || !Array.isArray(input.purposes) || !Array.isArray(input.services)) throw new TypeError('Invalid privacy catalog');
  const purposes = input.purposes.map((purpose) => {
    if (!exactKeys(purpose, ['id', 'kind', 'label', 'description']) || !idPattern.test(purpose.id) || !kinds.includes(purpose.kind) || !text(purpose.label) || !text(purpose.description) || purpose.id === 'necessary') throw new TypeError('Invalid optional purpose');
    return Object.freeze({ ...purpose });
  });
  const services = input.services.map((service) => {
    if (!exactKeys(service, ['id', 'purpose', 'label', 'description', 'retention', 'cookies', 'storage', 'start', 'stop']) || !idPattern.test(service.id) || !purposes.some(({ id }) => id === service.purpose) || !text(service.label) || !text(service.description) || !text(service.retention) || typeof service.start !== 'function' || typeof service.stop !== 'function' || !Array.isArray(service.cookies) || !Array.isArray(service.storage)) throw new TypeError('Invalid optional service');
    const cookies = service.cookies.map((cookie) => {
      // Exact names and host-only paths only. No broad regex or domain deletion.
      if (!exactKeys(cookie, ['name', 'path']) || !/^[a-zA-Z0-9_-]{1,80}$/.test(cookie.name) || cookie.name === POLICY.cookie || cookie.name.startsWith('an_customer_') || typeof cookie.path !== 'string' || !/^\/[a-zA-Z0-9/_-]*$/.test(cookie.path)) throw new TypeError('Invalid optional cookie');
      return Object.freeze({ ...cookie });
    });
    const storage = service.storage.map((item) => {
      if (!exactKeys(item, ['type', 'key']) || !['localStorage', 'sessionStorage'].includes(item.type) || !text(item.key) || protectedStorage(item.key)) throw new TypeError('Invalid optional storage');
      return Object.freeze({ ...item });
    });
    return Object.freeze({ ...service, cookies: Object.freeze(cookies), storage: Object.freeze(storage) });
  });
  if (!unique(purposes.map(({ id }) => id)) || !unique(services.map(({ id }) => id)) || purposes.some(({ id }) => !services.some(({ purpose }) => purpose === id))) throw new TypeError('Catalog must describe actual, uniquely named services');
  const cookieKeys = services.flatMap(({ cookies }) => cookies.map(({ name, path }) => `${name}:${path}`));
  const storageKeys = services.flatMap(({ storage }) => storage.map(({ type, key }) => `${type}:${key}`));
  if (!unique(cookieKeys) || !unique(storageKeys)) throw new TypeError('Optional storage must have a single owner');
  return Object.freeze({ purposes: Object.freeze(purposes), services: Object.freeze(services) });
}

export function catalogSignature(catalog) {
  // Canonical policy description, not a cryptographic signature or identity.
  return JSON.stringify({
    purposes: [...catalog.purposes].sort((a, b) => a.id.localeCompare(b.id)),
    services: [...catalog.services].sort((a, b) => a.id.localeCompare(b.id)).map(({ start, stop, ...declaration }) => declaration)
  });
}

export function deniedChoices(catalog) {
  return { purposes: Object.fromEntries(catalog.purposes.map(({ id }) => [id, false])), services: Object.fromEntries(catalog.services.map(({ id }) => [id, false])) };
}

function validChoices(choices, catalog) {
  return exactKeys(choices, ['purposes', 'services']) && exactKeys(choices.purposes, catalog.purposes.map(({ id }) => id)) && exactKeys(choices.services, catalog.services.map(({ id }) => id)) && [...Object.values(choices.purposes), ...Object.values(choices.services)].every((value) => typeof value === 'boolean') && catalog.services.every(({ id, purpose }) => !choices.services[id] || choices.purposes[purpose]);
}

export function createReceipt(catalog, choices, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0 || !validChoices(choices, catalog)) throw new TypeError('Invalid privacy choice');
  return { version: POLICY.version, revision: POLICY.revision, catalog: catalogSignature(catalog), issuedAt: now, expiresAt: now + duration, proof: 'explicit-choice', choices: structuredClone(choices) };
}

export function readReceipt(input, catalog, now = Date.now()) {
  try {
    if (!Number.isSafeInteger(now) || now < 0) return null;
    const value = typeof input === 'string' ? JSON.parse(input) : input;
    if (!exactKeys(value, ['version', 'revision', 'catalog', 'issuedAt', 'expiresAt', 'proof', 'choices']) || value.version !== POLICY.version || value.revision !== POLICY.revision || value.catalog !== catalogSignature(catalog) || value.proof !== 'explicit-choice' || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0 || value.issuedAt > now || value.expiresAt !== value.issuedAt + duration || now >= value.expiresAt || !validChoices(value.choices, catalog)) return null;
    return structuredClone(value);
  } catch { return null; }
}

export function gpcRestricted(purpose) { return restrictedKinds.includes(purpose.kind); }

export function readPreferenceCookie(raw, catalog) {
  try {
    if (typeof raw !== 'string' || !raw || raw.length > 12000) return null;
    const cookie = JSON.parse(decodeURIComponent(raw));
    const receipt = readReceipt(cookie.data, catalog);
    const categories = ['necessary', ...catalog.purposes.filter(({ id }) => receipt?.choices.purposes[id]).map(({ id }) => id)];
    const known = ['necessary', ...catalog.purposes.map(({ id }) => id)];
    if (!receipt || cookie.revision !== POLICY.revision || !Array.isArray(cookie.categories) || cookie.categories.length !== categories.length || !categories.every((id) => cookie.categories.includes(id)) || !record(cookie.services) || Object.keys(cookie.services).length !== known.length) return null;
    for (const purpose of known) {
      const services = catalog.services.filter((service) => service.purpose === purpose && receipt.choices.services[service.id]).map(({ id }) => id);
      const selected = cookie.services[purpose];
      if (!Array.isArray(selected) || selected.length !== services.length || !services.every((id) => selected.includes(id))) return null;
    }
    return receipt;
  } catch { return null; }
}

export function effectivePermissions(catalog, receipt, signal, now = Date.now()) {
  const valid = readReceipt(receipt, catalog, now);
  return Object.fromEntries(catalog.services.map(({ id, purpose }) => {
    const declaration = catalog.purposes.find((item) => item.id === purpose);
    return [id, !!valid && typeof signal === 'boolean' && !(signal && gpcRestricted(declaration)) && valid.choices.purposes[purpose] && valid.choices.services[id]];
  }));
}

// Cross-page messages may only remove permission. A session latch is cleared only
// by a new local explicit action whose exact receipt was actually persisted.
export function createPreferenceSyncGuard(input) {
  const catalog = validateCatalog(input);
  let blocked = false;
  let activeChoice = null;
  return Object.freeze({
    get blocked() { return blocked; },
    beginChoice() { activeChoice = Object.freeze({}); return activeChoice; },
    receipt(stored) { return blocked ? null : readReceipt(stored, catalog); },
    receive(message) {
      if (!exactKeys(message, ['version', 'type']) || message.version !== 1 || !['deny', 'changed'].includes(message.type)) return false;
      if (message.type === 'deny') { blocked = true; activeChoice = null; }
      return true;
    },
    commit(choice, intended, persisted, previous) {
      const expected = readReceipt(intended, catalog);
      const actual = readReceipt(persisted, catalog);
      const saved = choice !== null && choice === activeChoice && !!expected && !!actual && JSON.stringify(expected) === JSON.stringify(actual);
      activeChoice = null;
      blocked = !saved;
      const prior = readReceipt(previous, catalog);
      const withdrawal = !!expected && catalog.services.some(({ id }) => prior?.choices.services[id] && !expected.choices.services[id]);
      const rejection = !!expected && catalog.services.length > 0 && Object.values(expected.choices.services).every((value) => !value);
      return { saved, message: { version: 1, type: !saved || withdrawal || rejection ? 'deny' : 'changed' } };
    }
  });
}

// Capture records intent only. afterDispatch must run in the bubbling listener,
// after the pinned vendor's target listener has constructed its complete cookie.
// A microtask from capture can run BEFORE that target listener in real browsers.
export function createConsentActionAdapter(input, synchronization, { readStored, readVendor, writeReceipt, onResult }) {
  const catalog = validateCatalog(input);
  let pending = null;
  function finish(cookie) {
    if (!pending) return;
    const action = pending;
    pending = null;
    let receipt = null;
    try {
      const choices = deniedChoices(catalog);
      for (const purpose of catalog.purposes) choices.purposes[purpose.id] = cookie.categories.includes(purpose.id);
      for (const service of catalog.services) choices.services[service.id] = choices.purposes[service.purpose] && cookie.services[service.purpose]?.includes(service.id) === true;
      receipt = createReceipt(catalog, choices);
      writeReceipt(receipt);
    } catch { /* Exact read-back below also covers throwing and silent writes. */ }
    onResult(synchronization.commit(action.ticket, receipt, readStored(), action.previous));
  }
  return Object.freeze({
    begin() { pending = { ticket: synchronization.beginChoice(), previous: readStored() }; },
    onVendorChoice({ cookie }) { finish(cookie); },
    afterDispatch() {
      if (!pending) return;
      let cookie;
      try { cookie = readVendor(); } catch { cookie = null; }
      finish(cookie);
    }
  });
}

export function createServiceGate(input, { removeCookie = () => {}, removeStorage = () => {}, onError = () => {} } = {}) {
  const catalog = validateCatalog(input);
  const running = new Map();
  let latest = { receipt: null, signal: null };
  let queue = Promise.resolve();
  let reloadRequired = false;
  const report = (error) => { try { onError(error); } catch { /* Reporting cannot grant permission. */ } };
  async function cleanup(service) {
    for (const item of service.cookies) { try { await removeCookie(item); } catch (error) { reloadRequired = true; report(error); } }
    for (const item of service.storage) { try { await removeStorage(item); } catch (error) { reloadRequired = true; report(error); } }
  }
  async function stop(service, state) {
    state.controller.abort();
    try { await service.stop(); } catch (error) { reloadRequired = true; report(error); }
    await cleanup(service);
    running.delete(service.id);
  }
  async function reconcile() {
    let permissions = effectivePermissions(catalog, latest.receipt, latest.signal);
    for (const service of catalog.services) {
      const state = running.get(service.id);
      if (state && (state.controller.signal.aborted || !permissions[service.id])) await stop(service, state);
      else if (!state && !permissions[service.id]) await cleanup(service);
    }
    for (const service of catalog.services) {
      permissions = effectivePermissions(catalog, latest.receipt, latest.signal);
      if (!permissions[service.id] || running.has(service.id) || reloadRequired) continue;
      const state = { controller: new AbortController() };
      running.set(service.id, state);
      try { await service.start({ signal: state.controller.signal }); }
      catch (error) { report(error); await stop(service, state); }
      if (running.has(service.id) && (state.controller.signal.aborted || !effectivePermissions(catalog, latest.receipt, latest.signal)[service.id])) await stop(service, state);
    }
    return { running: [...running.keys()], reloadRequired };
  }
  return Object.freeze({
    update(receipt, signal) {
      latest = { receipt: readReceipt(receipt, catalog), signal };
      const permissions = effectivePermissions(catalog, latest.receipt, signal);
      for (const [id, state] of running) if (!permissions[id]) state.controller.abort();
      queue = queue.then(reconcile, reconcile);
      return queue;
    }
  });
}
