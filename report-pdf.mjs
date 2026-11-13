// Exact public alias only. A path, query or encoded variant is never a file name.
export function parseReportPDFRoute(rawURL) {
  if (typeof rawURL !== 'string') return null;
  const match = /^\/coa\/(AN-[A-Z0-9]{4}-[A-Z0-9]{4})\/report\.pdf$/.exec(rawURL);
  return match?.[0] === rawURL ? match[1] : null;
}
export function sendReportPDF(request, response, code, bytes) {
  const headers = { 'Content-Type': bytes ? 'application/pdf' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (bytes) headers['Content-Disposition'] = `inline; filename="${code}.pdf"`;
  response.writeHead(bytes ? 200 : 404, headers);
  response.end(request.method === 'HEAD' ? undefined : bytes ?? 'Not found');
}
