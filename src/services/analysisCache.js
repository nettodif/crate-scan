const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

const store = new Map();

export function get(videoId) {
  const entry = store.get(videoId);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    store.delete(videoId);
    return null;
  }

  return entry.result;
}

export function set(videoId, result, ttlMs = DEFAULT_TTL_MS) {
  store.set(videoId, { result, expiresAt: Date.now() + ttlMs });
}

export function clear(videoId) {
  store.delete(videoId);
}

export function clearAll() {
  store.clear();
}
