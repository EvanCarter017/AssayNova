// Exact public alias only. A path, query or encoded variant is never a file name.
const builtins = new Map([['AN-7K9Q-2M4X', 'sample-a.pdf'], ['AN-8P6R-3N5Y', 'sample-c.pdf']]);
export function parseReportPDFRoute(rawURL) {
  if (typeof rawURL !== 'string') return null;
  const match = /^\/coa\/(AN-[A-Z0-9]{4}-[A-Z0-9]{4})\/report\.pdf$/.exec(rawURL);
  return match?.[0] === rawURL ? match[1] : null;
}
export const builtinReportPDF = code => builtins.get(code) ?? null;
export function sendReportPDF(request, response, code, bytes) {
  const headers = { 'Content-Type': bytes ? 'application/pdf' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (bytes) headers['Content-Disposition'] = `inline; filename="${code}.pdf"`;
  response.writeHead(bytes ? 200 : 404, headers);
  response.end(request.method === 'HEAD' ? undefined : bytes ?? 'Not found');
}
