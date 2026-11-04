import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORT_DRAFT_KEY, normalizeSupport, validateSupport, parseSupportDraft, formatSupportRequest } from '../dist/support.js';

const valid = { email: 'qa@example.invalid', reference: 'Project Alpha', notes: '' };

test('support normalization trims known fields and preserves company and email case', () => {
  assert.equal(SUPPORT_DRAFT_KEY, 'assaynova.support.recovery.v1');
  assert.deepEqual(normalizeSupport({ email: '  QA@example.invalid ', reference: ' Lab Alpha \n', notes: ' Context\n', extra: 'ignored' }), { email: 'QA@example.invalid', reference: 'Lab Alpha', notes: 'Context' });
  assert.deepEqual(normalizeSupport(null), { email: '', reference: '', notes: '' });
});

test('recovery validation requires email/reference and enforces raw limits and text types', () => {
  assert.deepEqual(validateSupport(valid), {});
  for (const email of ['', 'name', 'a@b', 'a b@example.invalid']) assert.ok(validateSupport({ ...valid, email }).email);
  assert.ok(validateSupport({ ...valid, reference: ' \n' }).reference);
  for (const [key, max] of [['email', 160], ['reference', 160], ['notes', 1200]]) {
    assert.ok(validateSupport({ ...valid, [key]: ' '.repeat(max + 1) })[key]);
    assert.ok(validateSupport({ ...valid, [key]: 3 })[key]);
  }
  assert.deepEqual(validateSupport({ ...valid, reference: 'x'.repeat(160), notes: 'n'.repeat(1200) }), {});
});

test('versioned recovery parsing fails closed on corrupt, unknown, oversized or extra data', () => {
  const record = { version: 1, ...valid };
  assert.deepEqual(parseSupportDraft(JSON.stringify({ ...record, reference: ' Project Alpha ' })), record);
  for (const raw of [null, '', '{', '[]', 'null', '42', JSON.stringify({ ...record, version: 2 }), JSON.stringify({ ...record, extra: 'not allowed' }), JSON.stringify({ version: 1, email: valid.email, reference: valid.reference }), JSON.stringify({ ...record, notes: [] }), JSON.stringify({ ...record, notes: 'n'.repeat(1201) }), JSON.stringify({ ...record, reference: ' '.repeat(161) }), JSON.stringify({ ...record, email: 'bad' }), ' '.repeat(4097)]) assert.equal(parseSupportDraft(raw), null, String(raw).slice(0, 80));
});

test('request formatting is complete plain text and never claims sending or report verification', () => {
  const values = { ...valid, reference: '<Project & Team>', notes: '</textarea><script>text only</script>\nMore context' };
  const message = formatSupportRequest(values);
  assert.ok(message.startsWith('AssayNova / Nova Support — Report recovery request\n'));
  for (const value of Object.values(values)) assert.ok(message.includes(value));
  assert.match(message, /additional verification is required/);
  assert.ok(!/ticket ID|sent successfully|report found|AN-7K9Q/i.test(message));
  assert.match(formatSupportRequest(valid), /Additional context: Not provided/);
  assert.throws(() => formatSupportRequest({ ...valid, email: '' }), TypeError);
});
