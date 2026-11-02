export const DEMO_REPORT = Object.freeze({
  id: 'AN-2026-0042',
  sample: 'Reference sample A',
  batch: 'DEMO-2401',
  received: '2026-10-26',
  issued: '2026-10-30',
  purity: '99.32%',
  identity: 'Consistent',
  method: 'HPLC / LC–MS',
  status: 'Completed',
  retentionTime: '8.42 min',
  disclaimer: 'Fictional demonstration data. This is not a valid certificate of analysis and must not be used for research, quality release, or purchasing decisions.'
});

export const SERVICE_NAMES = Object.freeze({
  purity: 'Purity analysis',
  identity: 'Identity confirmation',
  comprehensive: 'Comprehensive panel',
  custom: 'Custom testing'
});

export function normalizeReportId(value) {
  return String(value).trim().toUpperCase().replace(/\s+/g, '');
}

export function findDemoReport(value) {
  return normalizeReportId(value) === DEMO_REPORT.id ? DEMO_REPORT : null;
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
