import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { runAsync } from './processRunner.js';

const tempRoot = path.join(os.tmpdir(), 'cratescan');

/**
 * Downloads the best available audio stream (no re-encoding) for the given URL
 * and returns the local file path plus basic metadata.
 */
const DOWNLOAD_PROGRESS_RE = /\[download\]\s+([\d.]+)%/;

/**
 * Auth args for yt-dlp so it can act as a logged-in (e.g. YouTube Music Premium)
 * session, unlocking higher-bitrate formats when available.
 */
function authArgs() {
  if (config.ytDlpCookiesFile) return ['--cookies', config.ytDlpCookiesFile];
  if (config.ytDlpCookiesFromBrowser) return ['--cookies-from-browser', config.ytDlpCookiesFromBrowser];
  return [];
}

export async function downloadAsync(url, info, { onProgress } = {}) {
  await fs.mkdir(tempRoot, { recursive: true });

  const jobId = randomUUID().replace(/-/g, '');
  const jobDir = path.join(tempRoot, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const outputTemplate = path.join(jobDir, '%(id)s.%(ext)s');

  const args = [
    '-f', 'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '--newline',
    ...authArgs(),
    '-o', outputTemplate,
    '--print', 'after_move:filepath',
    '--print', 'after_move:%(acodec)s|%(abr)s|%(ext)s',
    url,
  ];

  const onStdout = onProgress
    ? (text) => {
      const match = text.match(DOWNLOAD_PROGRESS_RE);
      if (match) onProgress({ percent: Number(match[1]) });
    }
    : undefined;

  const result = await runAsync(config.ytDlpPath, args, { onStdout });

  if (result.exitCode !== 0) {
    throw new Error(`Falha ao baixar áudio com yt-dlp (código ${result.exitCode}). Detalhe: ${result.stdErr}`);
  }

  const lines = result.stdOut
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const filePath = lines.slice().reverse().find((line) => existsSync(line));

  if (!filePath) {
    throw new Error(`yt-dlp concluiu, mas o arquivo de áudio não foi encontrado. Saída: ${result.stdOut}`);
  }

  // Native format yt-dlp actually picked (acodec/abr/ext), so we can later cross-check
  // it against what ffprobe measures on the downloaded file (see analysisPipeline.js) —
  // catches cases where the "declared" bitrate was inflated by a re-encode/remux.
  const sourceFormat = parseSourceFormatLine(lines.find((line) => line.includes('|') && !existsSync(line)));

  const { title, uploader, duration, id } = info ?? await fetchInfoAsync(url);

  return { filePath, id, title, uploader, durationSec: duration, sourceFormat };
}

function parseSourceFormatLine(line) {
  if (!line) return null;
  const [acodec, abr, ext] = line.split('|');
  return {
    acodec: acodec && acodec !== 'NA' ? acodec : null,
    abrKbps: abr && abr !== 'NA' && !Number.isNaN(Number(abr)) ? Number(abr) : null,
    ext: ext && ext !== 'NA' ? ext : null,
  };
}

/**
 * Lists the entries of a playlist URL without downloading anything (flat-playlist).
 * Returns one { id, url, title } per entry, in playlist order. Works for a plain
 * (non-playlist) video URL too — resolves to a single-item array in that case.
 */
export async function fetchPlaylistEntriesAsync(url) {
  const args = ['--flat-playlist', '--no-warnings', ...authArgs(), '--dump-json', url];
  const result = await runAsync(config.ytDlpPath, args);

  if (result.exitCode !== 0) {
    throw new Error(`Falha ao listar playlist com yt-dlp (código ${result.exitCode}). Detalhe: ${result.stdErr}`);
  }

  const entries = result.stdOut
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null)
    .map((entry) => {
      const id = entry.id ?? 'unknown';
      const rawUrl = entry.webpage_url ?? entry.url ?? '';
      const resolvedUrl = rawUrl.startsWith('http') ? rawUrl : `https://www.youtube.com/watch?v=${id}`;
      return { id, url: resolvedUrl, title: entry.title ?? 'Título desconhecido' };
    });

  if (entries.length === 0) {
    throw new Error('yt-dlp não retornou nenhuma faixa para essa URL.');
  }

  return entries;
}

export async function fetchInfoAsync(url) {
  const args = ['--no-playlist', '--no-warnings', ...authArgs(), '--dump-json', url];
  const result = await runAsync(config.ytDlpPath, args);

  if (result.exitCode !== 0) {
    return fallbackInfo();
  }

  try {
    const info = JSON.parse(result.stdOut);
    return {
      title: info.title ?? 'Título desconhecido',
      uploader: info.uploader ?? null,
      duration: typeof info.duration === 'number' ? info.duration : null,
      id: info.id ?? 'unknown',
    };
  } catch {
    return fallbackInfo();
  }
}

function fallbackInfo() {
  return {
    title: 'Título desconhecido',
    uploader: null,
    duration: null,
    id: randomUUID().replace(/-/g, '').slice(0, 8),
  };
}

export async function cleanupTempFile(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (dir.startsWith(tempRoot) && existsSync(dir)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  } catch {
    // best-effort cleanup; nothing else to do if it fails.
  }
}
