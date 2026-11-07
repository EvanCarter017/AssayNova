import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as records from '../dist/account-requests.js';
import * as submissions from '../dist/submission.js';
import * as contact from '../dist/contact.js';
import * as support from '../dist/support.js';

const identity = { id: 'AN-REQ-TEST099', createdAt: '2026-11-07T00:00:00.000Z' };
const testing = () => { const value = submissions.newSubmission('sample-1'); Object.assign(value, { name: 'Synthetic person', email: 'fixture@example.invalid' }); value.samples[0].name = '<img src=x onerror=alert(1)> 中文 😀'; return value; };
const examples = () => ({ testing: testing(), contact: { name: 'Person', email: 'fixture@example.invalid', topic: 'testing', message: '<script>private</script> 中文 😀' }, 'report-recovery': { email: 'fixture@example.invalid', reference: 'Synthetic company', notes: '<svg onload=alert(1)> 中文' } });

test('three account request kinds roundtrip canonical details without losing Unicode or treating text as HTML', () => {
  for (const [kind, details] of Object.entries(examples())) {
    const record = records.createAccountRequest(kind, details, identity);
    assert.deepEqual(records.parseAccountRequest(JSON.parse(JSON.stringify(record))), record);
    assert.equal(records.requestKind(record), kind); assert.equal(records.requestStatus(record), 'Submitted');
    assert.deepEqual(Object.keys(record), ['version', 'id', 'createdAt', 'kind', 'status', 'details']);
    assert.equal(record.version, 3);
  }
});

test('strict parsing rejects raw overflow, unknown nested fields, polluted prototypes, arrays, accessors and invalid identity/status/kind', () => {
  const original = records.createAccountRequest('testing', testing(), identity);
  const bad = [null, [], { ...original, extra: true }, { ...original, status: 'Accepted' }, { ...original, kind: 'unknown' }, { ...original, version: 0 }, { ...original, id: 'secret@email.invalid' }, { ...original, createdAt: '2026-02-30T00:00:00.000Z' }, { ...original, details: [] }, { ...original, details: { ...original.details, notes: ' '.repeat(1201) } }, { ...original, details: { ...original.details, name: ' Untrimmed ' } }, { ...original, details: { ...original.details, unknown: true } }, { ...original, details: { ...original.details, samples: [{ ...original.details.samples[0], token: 'forbidden' }] } }, { ...original, details: Object.assign(Object.create({ polluted: true }), original.details) }, JSON.parse(JSON.stringify(original).replace('"notes":""', '"notes":"","__proto__":{}'))];
  const arrayExtra = structuredClone(original); arrayExtra.details.samples.extra = 'reject'; bad.push(arrayExtra);
  const arrayPrototype = structuredClone(original); Object.setPrototypeOf(arrayPrototype.details.samples, {}); bad.push(arrayPrototype);
  const getter = { ...original }; Object.defineProperty(getter, 'details', { enumerable: true, get() { throw Error('must not invoke getter'); } }); bad.push(getter);
  for (const value of bad) assert.equal(records.parseAccountRequest(value), null);
  for (const [kind, details] of Object.entries(examples())) for (const key of Object.keys(details)) if (key !== 'samples') assert.throws(() => records.createAccountRequest(kind, { ...details, [key]: [] }, identity));
});

test('maximum escaped and multibyte requests including API wrappers fit the unchanged 65536 byte boundary', () => {
  const value = testing(); Object.assign(value, { name: '\u0001'.repeat(100), email: 'e'.repeat(140) + '@example.invalid', company: '\u0001'.repeat(160), notes: '\u0001'.repeat(1200), reportRecipient: '\u0001'.repeat(160) });
  value.samples = Array.from({ length: 10 }, (_, index) => ({ ...value.samples[0], id: 's' + String(index).repeat(63), name: '\u0001'.repeat(160), batch: '\u0001'.repeat(160), amount: '\u0001'.repeat(80), quantity: 100 }));
  const maximum = { testing: value, contact: { name: '\u0001'.repeat(120), email: value.email, topic: 'testing', message: '\u0001'.repeat(4000) }, 'report-recovery': { email: value.email, reference: '\u0001'.repeat(160), notes: '\u0001'.repeat(1200) } };
  assert.ok(records.MAX_ACCOUNT_REQUEST_BODY_BYTES < 65536);
  for (const [kind, details] of Object.entries(maximum)) for (const unicode of [false, true]) {
    const input = unicode ? JSON.parse(JSON.stringify(details).replaceAll('\\u0001', '中')) : details;
    const record = records.createAccountRequest(kind, input, identity);
    for (const wrap of [{ record, idempotencyKey: 'k'.repeat(128) }, { record, expectedRevision: Number.MAX_SAFE_INTEGER }]) assert.ok(Buffer.byteLength(JSON.stringify(wrap)) <= records.MAX_ACCOUNT_REQUEST_BODY_BYTES);
    assert.ok(records.parseAccountRequest(record));
  }
});

test('legacy version two is readable with exact field representation and truthful saved status', () => {
  const legacy = submissions.createRequestRecord(testing(), identity); legacy.notes = '  retained old bytes  ';
  const before = JSON.stringify(legacy), parsed = records.parseAccountRequest(legacy);
  assert.equal(JSON.stringify(parsed), before); assert.equal(JSON.stringify(legacy), before);
  assert.equal(records.requestStatus(parsed), 'Saved · Not submitted'); assert.equal(records.requestKind(parsed), 'testing');
  assert.equal(records.parseAccountRequest({ ...legacy, status: 'Submitted' }), null);
});

test('pure request contract imports without storage, DOM, network or circular controllers', async () => {
  const source = await readFile(new URL('../dist/account-requests.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /customer-account|contact-form|request-page/);
  const context = { ...submissions, ...contact, ...support, TextEncoder };
  for (const key of ['document', 'localStorage', 'fetch', 'navigator']) Object.defineProperty(context, key, { get() { throw Error('No import I/O'); } });
  runInNewContext(source.replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''), context);
});
