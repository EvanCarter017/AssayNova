const firstReport = Object.freeze({
  id: 'AN-2026-0042',
  lookupCode: 'AN-7K9Q-2M4X',
  publication: 'published',
  version: '1.0 demo',
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

const secondReport = Object.freeze({
  id: 'AN-2026-0043',
  lookupCode: 'AN-8P6R-3N5Y',
  publication: 'published',
  version: '1.0 demo',
  sample: 'Reference sample C',
  batch: 'DEMO-2402',
  received: '2026-10-27',
  issued: '2026-10-31',
  purity: '97.84%',
  identity: 'Illustrative match',
  method: 'HPLC / LC–MS',
  status: 'Completed',
  retentionTime: '9.16 min',
  disclaimer: firstReport.disclaimer
});

export const DEMO_REPORTS = Object.freeze([firstReport, secondReport]);
export const DEMO_REPORT = firstReport;

export const SERVICE_NAMES = Object.freeze({
  purity: 'Purity analysis',
  identity: 'Identity confirmation',
  comprehensive: 'Comprehensive panel',
  custom: 'Custom testing'
});

export function normalizeReportId(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function normalizeLookupCode(value) {
  if (typeof value !== 'string' || value.length > 128) return '';
  const code = value.trim().toUpperCase();
  return /^AN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) ? code : '';
}

export function findReportByLookupCode(value, reports = DEMO_REPORTS) {
  const code = normalizeLookupCode(value);
  if (!code || !Array.isArray(reports)) return null;
  // Even a published/draft collision is ambiguous: never choose the first match.
  const matches = reports.filter((report) => normalizeLookupCode(report?.lookupCode) === code);
  return matches.length === 1 && matches[0].publication === 'published' ? matches[0] : null;
}

export function findLegacyReport(value) {
  const id = normalizeReportId(value);
  const matches = DEMO_REPORTS.filter((report) => report.id === id);
  return matches.length === 1 ? findReportByLookupCode(matches[0].lookupCode) : null;
}

export function reportPath(value) {
  const report = findReportByLookupCode(value);
  return report ? '/coa/' + report.lookupCode : null;
}

// Accept one narrow, URL-safe segment only; no asset or arbitrary-path fallback.
export function resolveCOARoute(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const match = /^\/coa\/([a-z0-9-]{1,64})\/?$/i.exec(decoded);
  if (!match) return null;
  const report = findReportByLookupCode(match[1]);
  return { report, code: normalizeLookupCode(match[1]), canonicalPath: report ? reportPath(report.lookupCode) : null };
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
