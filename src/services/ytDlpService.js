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
    '-o', outputTemplate,
    '--print', 'after_move:filepath',
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

  const filePath = result.stdOut
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse()
    .find((line) => existsSync(line));

  if (!filePath) {
    throw new Error(`yt-dlp concluiu, mas o arquivo de áudio não foi encontrado. Saída: ${result.stdOut}`);
  }

  const { title, uploader, duration, id } = info ?? await fetchInfoAsync(url);

  return { filePath, id, title, uploader, durationSec: duration };
}

export async function fetchInfoAsync(url) {
  const args = ['--no-playlist', '--no-warnings', '--dump-json', url];
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
