export const IMPORT_LIMITS = Object.freeze({ chunk: 256 * 1024, json: 8192, file: 8 * 1024 * 1024, folder: 512 * 1024 * 1024, images: 500, jobs: 4, idleMs: 30 * 60 * 1000 });
export function importChunkRoute(method, target) {
  if (method !== 'PUT' || typeof target !== 'string') return null;
  const match = /^\/admin\/api\/imports\/([a-f0-9]{32})\/files\/([a-f0-9]{32})\?offset=(0|[1-9]\d*)$/.exec(target);
  if (!match || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) > IMPORT_LIMITS.file) return null;
  return { jobId: match[1], fileId: match[2], offset: Number(match[3]) };
}
export const importBodyLimit = (method, target) => importChunkRoute(method, target) ? IMPORT_LIMITS.chunk : IMPORT_LIMITS.json;
