import path from 'node:path';
import { exec } from 'node:child_process';

// Entry point for the packaged CrateScan.exe (built via packaging/windows/build.mjs).
// Sets Windows-appropriate defaults for every env var src/config.js already reads —
// only when the user/installer hasn't already set them (??=) — then starts the
// server exactly like `node src/server.js` would, and opens the browser once it's
// had time to come up. No changes to src/ are needed for any of this: config.js
// was already 100% env-var-driven before this file existed.
function applyDefaultEnv() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
  const documents = path.join(process.env.USERPROFILE || '.', 'Documents');
  // process.execPath is the packaged CrateScan.exe itself when run via pkg —
  // packaging/windows/build.mjs copies bin/ next to it.
  const binDir = path.join(path.dirname(process.execPath), 'bin');

  process.env.COOKIES_DIR ??= path.join(appData, 'CrateScan', 'auth');
  process.env.LIBRARY_ROOT ??= path.join(documents, 'CrateScan');
  process.env.SPECTROGRAM_DIR ??= path.join(appData, 'CrateScan', 'spectrograms');
  process.env.YTDLP_PATH ??= path.join(binDir, 'yt-dlp.exe');
  process.env.FFMPEG_PATH ??= path.join(binDir, 'ffmpeg.exe');
  process.env.FFPROBE_PATH ??= path.join(binDir, 'ffprobe.exe');
}

applyDefaultEnv();

await import('../../src/server.js');

const port = process.env.PORT || 5178;
setTimeout(() => {
  exec(`start "" "http://localhost:${port}"`, (err) => {
    if (err) console.error('Não foi possível abrir o navegador automaticamente:', err.message);
  });
}, 1500);
