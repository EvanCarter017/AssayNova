import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { publicBundle, validCode } from './reader.mjs';
import { SAMPLE_REPORT_DATA } from '../dist/reports/sample-data.js';
import { validMailbox } from '../accounts/mail-config.mjs';

const failure = (status = 404) => Object.assign(new Error('Publication notice is unavailable for this report.'), { status });
async function exactPath(filename, directory = false) {
  for (let current = path.resolve(filename); ; current = path.dirname(current)) {
    const info = await lstat(current); if (info.isSymbolicLink()) throw failure(); if (path.dirname(current) === current) break;
  }
  const info = await lstat(filename), canonical = await realpath(filename);
  if ((process.platform === 'win32' ? canonical.toLowerCase() !== path.resolve(filename).toLowerCase() : canonical !== path.resolve(filename)) || (directory ? !info.isDirectory() : !info.isFile())) throw failure();
  return info;
}
// Only the selected code and its three public files are touched. There is no
// report discovery, recipient inference, private snapshot read or rendering.
export async function reportMailEligible(store, code) {
  if (!path.isAbsolute(store) || !validCode(code) || Object.hasOwn(SAMPLE_REPORT_DATA, code)) return false;
  try {
    const folder = path.join(store, 'published', code); await exactPath(folder, true);
    for (const state of ['removed', 'previews']) { try { await lstat(path.join(store, state, code)); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    for (const [name, maximum] of [['bundle.json', 2097152], ['report.pdf', 33554432], ['report.svg', 33554432]]) {
      const filename = path.join(folder, name), info = await exactPath(filename);
      if (info.size < 1 || info.size > maximum) return false;
      const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const actual = await file.stat(); if (actual.ino !== info.ino || actual.dev !== info.dev || actual.size !== info.size) return false;
        const bytes = Buffer.alloc(name === 'bundle.json' ? info.size + 1 : Math.min(info.size, 4096)); const read = await file.read(bytes, 0, bytes.length, 0);
        if (name === 'bundle.json') { if (read.bytesRead !== info.size) return false; publicBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead))), code); }
        else if (name === 'report.pdf' ? !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) : !bytes.toString('utf8').includes('<svg')) return false;
      } finally { await file.close(); }
      await exactPath(filename);
    }
    await exactPath(folder, true); return true;
  } catch { return false; }
}
export function createReportMail({ store, mail } = {}) {
  return Object.freeze({
    enabled: () => !!mail?.reportEnabled(),
    status(code) { if (!validCode(code) || Object.hasOwn(SAMPLE_REPORT_DATA, code)) throw failure(400); return mail ? mail.reportStatus(code) : { state: 'not_configured' }; },
    async request(code, input) {
      if (!input || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'recipientEmail') || input.confirm !== true || !validMailbox(input.recipientEmail)) throw failure(400);
      if (!await reportMailEligible(store, code)) throw failure();
      return mail ? mail.admitReport(code, input.recipientEmail) : { state: 'not_configured' };
    }
  });
}
