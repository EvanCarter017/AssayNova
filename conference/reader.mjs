import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReportPDFRoute, sendReportPDF } from '../report-pdf.mjs';

export const REPORT_ASSET_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
export const DEFAULT_STORE = fileURLToPath(new URL('../work/report-studio', import.meta.url));
export const validCode = value => typeof value === 'string' && value.length === 12 && /^AN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value);
const sampleCodes = new Set(['AN-7K9Q-2M4X', 'AN-8P6R-3N5Y']);
export const isReservedSampleCode = code => sampleCodes.has(code);

// Every saved studio snapshot includes this marker, including historical saves.
// Independently supplied reports have no marker. Never read its private contents.
export async function hasStudioProvenance(folder) {
  try { await lstat(path.join(folder, 'private.json')); }
  catch (error) { return error.code !== 'ENOENT'; }
  return true;
}

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const scalar = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const clean = value => {
  if (scalar(value)) return value;
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/path|seed|provenance|token|source|private/i.test(key)).map(([key,item]) => [key,clean(item)]));
  return null;
};
export function publicBundle(bundle, code) {
  if (!validCode(code) || bundle?.report?.lookupCode !== code || bundle.report.publication !== 'published' || !bundle.record || typeof bundle.label !== 'string') throw new Error('Invalid published bundle.');
  const report = pick(bundle.report, ['id','lookupCode','publication','version','sample','batch','received','issued','purity','identity','identityOutcome','method','status','retentionTime']);
  if (!Object.values(report).every(scalar)) throw new Error('Invalid report values.');
  const record = clean(pick(bundle.record, ['label','product','appearance','client','reportId','accession','lot','received','reported','purity','identity','retentionTime','composition','screenings','method','spectra','chromatogram','signoffTitle','contentUnit']));
  for (const key of ['purity','composition','screenings','spectra','chromatogram']) if (!Array.isArray(record[key])) throw new Error('Incomplete report.');
  return { report, record, label: bundle.label, assets: { svg: '/__reports/' + code + '/report.svg', pdf: '/__reports/' + code + '/report.pdf' } };
}
export async function readPublished(store, code, asset = 'bundle.json') {
  if (!validCode(code) || isReservedSampleCode(code) || !['bundle.json', 'report.svg', 'report.pdf'].includes(asset)) return null;
  try {
    const published = await realpath(path.join(store, 'published'));
    const folder = await realpath(path.join(published, code));
    if (folder !== path.join(published, code)) return null;
    const bundle = await readReportFile(folder, 'bundle.json');
    const dto = publicBundle(JSON.parse(bundle), code);
    return asset === 'bundle.json' ? dto : await readReportFile(folder, asset);
  } catch { return null; }
}

async function readReportFile(folder, asset) {
  const filename = await realpath(path.join(folder, asset));
  if (filename !== path.join(folder, asset) || !(await stat(filename)).isFile()) throw new Error('Invalid report file.');
  return readFile(filename);
}

export async function handlePublicReport(request, response, pathname, store) {
  const pdfCode = parseReportPDFRoute(request.url);
  if (pdfCode) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end('Method not allowed'); return true;
    }
    const bytes = await readPublished(store, pdfCode, 'report.pdf');
    sendReportPDF(request, response, pdfCode, bytes); return true;
  }
  if (!pathname.startsWith('/__reports')) return false;
  const match = /^\/__reports\/(AN-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})(?:\/(report\.svg|report\.pdf))?$/i.exec(pathname);
  const code = match?.[1].toUpperCase();
  const asset = match?.[2]?.toLowerCase() ?? 'bundle.json';
  const result = match ? await readPublished(store, code, asset) : null;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, noarchive', 'Content-Security-Policy': REPORT_ASSET_POLICY, 'Content-Type': asset === 'bundle.json' ? 'application/json; charset=utf-8' : asset === 'report.svg' ? 'image/svg+xml' : 'application/pdf' };
  if (asset === 'report.pdf') headers['Content-Disposition'] = `attachment; filename="${code}.pdf"`;
  response.writeHead(result ? 200 : 404, headers);
  response.end(request.method === 'HEAD' ? undefined : result ? (Buffer.isBuffer(result) ? result : JSON.stringify(result)) : 'Not found');
  return true;
}
