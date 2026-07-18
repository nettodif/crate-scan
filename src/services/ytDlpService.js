import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import * as cookieStore from './cookieStore.js';
import { runAsync } from './processRunner.js';

const tempRoot = path.join(os.tmpdir(), 'cratescan');

// Authenticated (cookie) requests make YouTube route yt-dlp to player clients
// (e.g. web_creator) that require solving an "n" challenge via a JS runtime —
// yt-dlp only trusts Deno by default, so without it every format gets filtered
// out ("No video formats found!") even though the video is fine. CrateScan
// already requires Node.js to run, so point yt-dlp at that same binary instead
// of asking users to install Deno separately. A JS runtime alone isn't enough
// though — yt-dlp also needs to fetch its challenge-solver script (EJS) on
// first use, which --remote-components ejs:github enables.
const JS_RUNTIME_ARGS = ['--js-runtimes', `node:${process.execPath}`, '--remote-components', 'ejs:github'];

/**
 * Downloads the best available audio stream (no re-encoding) for the given URL
 * and returns the local file path plus basic metadata.
 */
const DOWNLOAD_PROGRESS_RE = /\[download\]\s+([\d.]+)%/;

/**
 * Auth args for yt-dlp so it can act as a logged-in (e.g. YouTube Music Premium)
 * session, unlocking higher-bitrate formats when available. Source: a
 * cookies.txt uploaded via /api/cookies, or the YTDLP_COOKIES_FILE env var.
 */
function authArgs() {
  const uploadedCookiesPath = cookieStore.getPath();
  if (uploadedCookiesPath) return ['--cookies', uploadedCookiesPath];
  if (config.ytDlpCookiesFile) return ['--cookies', config.ytDlpCookiesFile];
  return [];
}

// Stable, always-public targets for a lightweight per-platform sanity check —
// same reasoning for both: no age/region/membership restriction, never
// disappears. (Using a search query here would be a bad idea: it returns
// whatever's currently trending, which could itself be restricted for a given
// account and produce a false "invalid cookie" result.)
const COOKIE_VALIDATION_URLS = {
  // "Me at the zoo" — the first YouTube video ever uploaded.
  youtube: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  // SoundCloud's own official account, first upload — same stability rationale.
  soundcloud: 'https://soundcloud.com/soundcloud/soundcloud-go',
};

// YouTube rotating/expiring a cookie doesn't make yt-dlp fail — it just warns
// and silently falls back to an unauthenticated client, so a stale cookie
// looks like a successful (but anonymous, lower-bitrate) analysis unless we
// explicitly watch for this warning ourselves. We deliberately don't pass
// --no-warnings anywhere anymore so this text is actually present in stderr.
function hasInvalidCookieWarning(stdErr) {
  return /cookies?.*no longer valid/i.test(stdErr);
}

async function validateCookiesAgainst(cookiesPath, platform) {
  const validationUrl = COOKIE_VALIDATION_URLS[platform];
  const args = ['--cookies', cookiesPath, ...JS_RUNTIME_ARGS, '--simulate', '--skip-download', '--dump-json', validationUrl];
  const result = await runAsync(config.ytDlpPath, args);

  if (result.exitCode !== 0) {
    throw new Error(`yt-dlp não conseguiu usar esse cookies.txt (código ${result.exitCode}). Detalhe: ${result.stdErr}`);
  }

  if (hasInvalidCookieWarning(result.stdErr)) {
    throw new Error('O serviço rejeitou esse cookie (provavelmente expirado ou rotacionado). Exporte um cookies.txt novo do navegador.');
  }
}

/**
 * Sanity-checks a cookies.txt by running a lightweight yt-dlp call against it —
 * catches a malformed/expired export at upload time instead of only failing
 * later during a real analysis. A single cookies.txt export can carry cookies
 * for both YouTube and SoundCloud at once, so this tries both services and
 * only fails if neither validates — it doesn't require the caller to know
 * which service the cookie is actually for.
 */
export async function validateCookiesAsync(cookiesPath) {
  const platforms = Object.keys(COOKIE_VALIDATION_URLS);
  const results = await Promise.allSettled(platforms.map((platform) => validateCookiesAgainst(cookiesPath, platform)));

  const validatedFor = platforms.filter((_, i) => results[i].status === 'fulfilled');
  if (validatedFor.length > 0) return validatedFor;

  const detail = results.map((r, i) => `${platforms[i]}: ${r.reason.message}`).join(' | ');
  throw new Error(`yt-dlp não conseguiu usar esse cookies.txt pra nenhum serviço suportado. Detalhe: ${detail}`);
}

/**
 * "Requested format is not available" with no -f override (as in
 * fetchPlaylistEntriesAsync) means yt-dlp couldn't resolve ANY format for the
 * video at all — with a cookie active, that's usually a stale/malformed
 * cookies.txt causing YouTube to serve a degraded player response, so hint at
 * that instead of leaving the user to guess from the raw yt-dlp error.
 */
function describeYtDlpFailure(stdErr) {
  if (cookieStore.getPath() && stdErr.includes('Requested format is not available')) {
    return `${stdErr}\n\nIsso pode indicar que o cookie enviado expirou ou está inválido — tente exportar um cookies.txt novo.`;
  }
  return stdErr;
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
    '--newline',
    ...JS_RUNTIME_ARGS,
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
    throw new Error(`Falha ao baixar áudio com yt-dlp (código ${result.exitCode}). Detalhe: ${describeYtDlpFailure(result.stdErr)}`);
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

  const cookieInvalid = cookieStore.getPath() !== null && hasInvalidCookieWarning(result.stdErr);

  return { filePath, id, title, uploader, durationSec: duration, sourceFormat, cookieInvalid };
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
  const args = ['--flat-playlist', ...JS_RUNTIME_ARGS, ...authArgs(), '--dump-json', url];
  const result = await runAsync(config.ytDlpPath, args);

  if (result.exitCode !== 0) {
    throw new Error(`Falha ao listar playlist com yt-dlp (código ${result.exitCode}). Detalhe: ${describeYtDlpFailure(result.stdErr)}`);
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
      const resolvedUrl = rawUrl.startsWith('http') ? rawUrl : url;
      return { id, url: resolvedUrl, title: entry.title ?? 'Título desconhecido' };
    });

  if (entries.length === 0) {
    throw new Error('yt-dlp não retornou nenhuma faixa para essa URL.');
  }

  return entries;
}

export async function fetchInfoAsync(url) {
  const args = ['--no-playlist', ...JS_RUNTIME_ARGS, ...authArgs(), '--dump-json', url];
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
