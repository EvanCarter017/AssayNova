import test from 'node:test';
import assert from 'node:assert/strict';
import { newSubmission, newSample, normalizeSubmission, validateSubmissionState, submissionTotals, duplicateSubmissionSample, createRequestRecord, parseRequestRecord, requestStateFromRecord, readableRequests, prepareRequestSave, effectiveReportRecipient, MAX_REQUEST_RECORD_CHARS } from '../dist/submission.js';

const identity = { id: 'AN-REQ-TEST01', createdAt: '2026-11-05T00:00:00.000Z' };
function valid() { const value = newSubmission('s1', 'purity'); Object.assign(value, { name: 'Synthetic Contact', email: 'qa@example.invalid', company: 'Lab Alpha', notes: '', reportRecipient: '' }); value.samples[0].name = 'Sample Alpha'; return value; }

test('request model uses four known services and separates sample entries from planned units', () => {
  const state = valid(); state.samples.push({ ...newSample('s2', 'custom'), name: 'Other sample', quantity: 100 });
  assert.deepEqual(validateSubmissionState(state), {});
  assert.deepEqual(submissionTotals(state), { entries: 2, units: 101 });
  state.samples[0].quantity = '';
  assert.deepEqual(submissionTotals(state), { entries: 2, units: 100 });
  assert.ok(validateSubmissionState(state, 1)['sample:s1:quantity']);
  assert.equal(newSample('new', 'not-a-service').service, 'comprehensive');
});

test('request duplicates ordinary fields with a new stable ID and rejects duplicate IDs and entry overflow', () => {
  const state = valid(); state.samples[0].image = 'include';
  const copy = duplicateSubmissionSample(state, 's1', 's2');
  assert.equal(copy.samples.length, 2); assert.equal(state.samples.length, 1);
  assert.deepEqual(copy.samples[1], { ...copy.samples[0], id: 's2' });
  assert.throws(() => duplicateSubmissionSample(state, 's1', 's1'));
  copy.samples[1].id = 's1'; assert.ok(validateSubmissionState(copy).samples);
  const ten = valid(); ten.samples = Array.from({ length: 10 }, (_, i) => ({ ...newSample('s' + i), name: 'Sample ' + i, quantity: 100 }));
  assert.deepEqual(submissionTotals(ten), { entries: 10, units: 1000 });
  assert.throws(() => duplicateSubmissionSample(ten, 's0', 'overflow'));
});

test('request validates every step, raw text limits, enums, quantities and required contact details', () => {
  for (const [key, max] of [['name', 100], ['email', 160], ['company', 160], ['notes', 1200], ['reportRecipient', 160]]) { const state = valid(); state[key] = ' '.repeat(max + 1); assert.ok(validateSubmissionState(state)[key]); state[key] = {}; assert.ok(validateSubmissionState(state)[key]); }
  for (const [key, value] of [['name', ''], ['batch', 'b'.repeat(161)], ['amount', 'x'.repeat(81)], ['service', 'missing'], ['form', 'liquid'], ['quantity', 0], ['quantity', 101], ['quantity', 1.5], ['quantity', null], ['image', 'remote'], ['imageStyle', 'svg']]) { const state = valid(); state.samples[0][key] = value; assert.ok(Object.keys(validateSubmissionState(state)).length, key); }
  const blank = newSubmission('blank'); assert.ok(validateSubmissionState(blank, 1)['sample:blank:name']); assert.ok(!validateSubmissionState(blank, 1).email); assert.ok(validateSubmissionState(blank, 2).email);
});

test('version2 records normalize safely and reject conflicting projections, unknown versions or file metadata', () => {
  const state = valid(); state.name = '  Synthetic Contact '; state.samples[0].name = ' Sample Alpha ';
  state.file = { name: 'PRIVATE-FILE.png' }; state.samples[0].filename = 'PRIVATE-FILE.png';
  const record = createRequestRecord(state, identity);
  assert.equal(record.sample, 'Sample Alpha'); assert.equal(record.quantity, 1);
  assert.deepEqual(parseRequestRecord(record), record);
  assert.deepEqual(requestStateFromRecord(record), normalizeSubmission(state));
  assert.ok(!JSON.stringify(record).includes('PRIVATE-FILE'));
  for (const patch of [{ version: 3 }, { sample: 'Conflict' }, { service: 'identity' }, { quantity: 2 }, { filename: 'unsafe.png' }, { createdAt: 'not-a-date' }]) assert.equal(parseRequestRecord({ ...record, ...patch }), null);
  assert.equal(parseRequestRecord({ ...record, samples: [{ ...record.samples[0], quantity: '1' }] }), null);
  assert.equal(parseRequestRecord({ ...record, samples: [{ ...record.samples[0], blobURL: 'blob:private' }] }), null);
  assert.equal(effectiveReportRecipient(state), 'Synthetic Contact'); assert.equal(state.company, 'Lab Alpha'); state.reportRecipient = ' Research Team '; assert.equal(effectiveReportRecipient(state), 'Research Team'); state.reportRecipient = state.company = ''; assert.equal(effectiveReportRecipient(state), 'Synthetic Contact');
});

test('maximum escaped fields survive exact serialized roundtrip within the derived bound', () => {
  const state = valid(); state.name = '\u0001'.repeat(100); state.email = 'a'.repeat(144) + '@example.invalid'; state.company = '\u0001'.repeat(160); state.notes = '\u0001'.repeat(1200); state.reportRecipient = '\u0001'.repeat(160);
  state.samples = Array.from({ length: 10 }, (_, i) => ({ ...newSample('sample_' + i), name: '\u0001'.repeat(160), batch: '\u0001'.repeat(160), amount: '\u0001'.repeat(80), quantity: 100 }));
  const record = createRequestRecord(state, identity); const raw = JSON.stringify(record);
  assert.ok(raw.length > 20000 && raw.length < MAX_REQUEST_RECORD_CHARS);
  assert.deepEqual(parseRequestRecord(JSON.parse(raw)), record);
  const list = prepareRequestSave(null, record); assert.deepEqual(readableRequests(list), [record]);
});

test('explicit save preserves legacy values, enforces50, updates the same v2 ID and refuses corrupt lists', () => {
  const legacy = Array.from({ length: 50 }, (_, i) => ({ id: 'AN-DEMO-' + i, sample: 'Legacy ' + i, service: 'purity', quantity: 1, extra: 'preserve' }));
  const record = createRequestRecord(valid(), identity);
  let raw = prepareRequestSave(JSON.stringify(legacy), record); let values = JSON.parse(raw);
  assert.equal(values.length, 50); assert.deepEqual(values[1], legacy[0]); assert.deepEqual(values.at(-1), legacy[48]);
  const changed = valid(); changed.samples[0].name = 'Changed'; const update = createRequestRecord(changed, identity);
  raw = prepareRequestSave(raw, update); values = JSON.parse(raw);
  assert.equal(values.length, 50); assert.equal(values.filter(value => value.id === identity.id).length, 1); assert.equal(values[0].createdAt, identity.createdAt); assert.equal(values[0].sample, 'Changed');
  for (const bad of ['', '{', '{}', 'null']) assert.throws(() => prepareRequestSave(bad, record));
  assert.deepEqual(readableRequests(JSON.stringify([legacy[0], { ...record, version: 99 }, { version: 2, ...legacy[1] }])), [legacy[0]]);
});
