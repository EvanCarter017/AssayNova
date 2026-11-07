import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReportPDFRoute, sendReportPDF } from '../report-pdf.mjs';

export const DEFAULT_STORE = fileURLToPath(new URL('../work/report-studio', import.meta.url));
export const validCode = value => typeof value === 'string' && /^AN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value);
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
  if (!validCode(code) || !['bundle.json','report.svg','report.pdf'].includes(asset)) return null;
  try {
    const published = await realpath(path.join(store, 'published'));
    const folder = await realpath(path.join(published, code));
    const filename = await realpath(path.join(folder, asset));
    if (path.dirname(folder) !== published || path.dirname(filename) !== folder || !(await stat(filename)).isFile()) return null;
    const bytes = await readFile(filename);
    return asset === 'bundle.json' ? publicBundle(JSON.parse(bytes), code) : bytes;
  } catch { return null; }
}

export async function handlePublicReport(request, response, pathname, store) {
  const pdfCode = parseReportPDFRoute(request.url);
  if (pdfCode) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end('Method not allowed'); return true;
    }
    const published = await readPublished(store, pdfCode);
    const bytes = published ? await readPublished(store, pdfCode, 'report.pdf') : null;
    sendReportPDF(request, response, pdfCode, bytes); return true;
  }
  if (!pathname.startsWith('/__reports')) return false;
  const match = /^\/__reports\/(AN-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})(?:\/(report\.svg|report\.pdf))?$/i.exec(pathname);
  const code = match?.[1].toUpperCase();
  const asset = match?.[2]?.toLowerCase() ?? 'bundle.json';
  const result = match ? await readPublished(store, code, asset) : null;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox", 'Content-Type': asset === 'bundle.json' ? 'application/json; charset=utf-8' : asset === 'report.svg' ? 'image/svg+xml' : 'application/pdf' };
  if (asset === 'report.pdf') headers['Content-Disposition'] = `attachment; filename="${code}.pdf"`;
  response.writeHead(result ? 200 : 404, headers);
  response.end(request.method === 'HEAD' ? undefined : result ? (Buffer.isBuffer(result) ? result : JSON.stringify(result)) : 'Not found');
  return true;
}
