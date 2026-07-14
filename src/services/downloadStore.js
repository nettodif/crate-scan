import { cleanupTempFile } from './ytDlpService.js';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h, same window as analysisCache

const store = new Map();

/**
 * Keeps a downloaded audio file alive (past the end of the analysis pipeline)
 * so the user can fetch it via /api/download/:id. Auto-deletes it after ttlMs
 * since we don't have a UI signal for "user is done downloading this".
 */
export function set(id, filePath, fileName, ttlMs = DEFAULT_TTL_MS) {
  const existing = store.get(id);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    store.delete(id);
    cleanupTempFile(filePath);
  }, ttlMs);
  timer.unref?.();

  store.set(id, { filePath, fileName, timer });
}

export function get(id) {
  const entry = store.get(id);
  return entry ? { filePath: entry.filePath, fileName: entry.fileName } : null;
}
