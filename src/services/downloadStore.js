import { cleanupTempFile } from './ytDlpService.js';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h, same window as analysisCache

const store = new Map();

function makeKey(videoId, variantId) {
  return `${videoId}:${variantId}`;
}

/**
 * Keeps a downloaded audio file alive (past the end of the analysis pipeline)
 * so the user can fetch it via /api/download/:videoId/:variantId. Auto-deletes
 * it after ttlMs since we don't have a UI signal for "user is done downloading
 * this". Keyed per (videoId, variantId) since a track can now have multiple
 * simultaneous downloadable variants — each with its own isolated temp dir
 * (see ytDlpService.createTempJobDirAsync), so one variant's expiry never
 * touches another's file.
 */
export function set(videoId, variantId, filePath, fileName, ttlMs = DEFAULT_TTL_MS) {
  const key = makeKey(videoId, variantId);
  const existing = store.get(key);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    store.delete(key);
    cleanupTempFile(filePath);
  }, ttlMs);
  timer.unref?.();

  store.set(key, { filePath, fileName, timer });
}

export function get(videoId, variantId) {
  const entry = store.get(makeKey(videoId, variantId));
  return entry ? { filePath: entry.filePath, fileName: entry.fileName } : null;
}
