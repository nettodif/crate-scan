import path from 'node:path';
import { config } from '../config.js';
import * as ytDlp from './ytDlpService.js';
import { FORMAT_SELECTORS } from './ytDlpService.js';
import * as ffmpeg from './ffmpegService.js';
import * as spectrumAnalyzer from './spectrumAnalyzer.js';
import * as downloadStore from './downloadStore.js';
import * as libraryStore from './libraryStore.js';

const FORMAT_LABELS = {
  opus: 'Opus',
  aac_native: 'AAC nativo',
  aac_transcoded: 'AAC transcodificado',
};

// Static (not measured) comparison notes — the download-only pipeline only
// ever fetches one format at a time, so unlike analysisPipeline.js's
// side-by-side variants there's no second file here to actually compare
// against. Opus needs no note: it's already the native, non-transcoded pick.
function buildFormatNote(format) {
  if (format === 'aac_transcoded') {
    return 'AAC transcodificado é gerado localmente a partir do áudio nativo (recodificação) — carrega perda de geração adicional. Quando o yt-dlp oferece um stream AAC nativo para essa faixa, "AAC nativo" tende a preservar mais qualidade.';
  }
  if (format === 'aac_native') {
    return 'AAC nativo foi baixado direto nesse codec, sem recodificação adicional — geralmente preferível ao "AAC transcodificado" quando o YouTube oferece esse stream.';
  }
  return null;
}

// Distinct from any variantId analysisPipeline.js ever uses ('native',
// 'aac_native', 'aac_transcoded') so a download-only run never collides with
// a downloadStore entry an earlier analysis of the same video left behind.
const DOWNLOAD_VARIANT_ID = 'download';

/**
 * Downloads the best native audio stream for a URL and makes it available via
 * /api/download/:videoId/:variantId, skipping analysis entirely (no ffprobe
 * cross-checks, no spectrogram, no FFT) — for users who just want the file to
 * organize locally and don't need the quality pre-analysis. Mirrors
 * runAnalysis's onProgress(stage, data) callback shape so the SSE route can
 * reuse the same event-forwarding pattern.
 *
 * destination ({ subfolder, fileNameBase }) is always saved into the library
 * (config.libraryRoot) — subfolder '' just means the library's root. The
 * final file is still kept in downloadStore afterward so the manual "baixar
 * novamente" link keeps working as a fallback alongside the copy that landed
 * in the library.
 *
 * format picks between 'opus'/'aac_native' (downloaded directly in that
 * codec — best-effort, throws a clear 422 if the video doesn't offer it) and
 * 'aac_transcoded' (always downloads native, then re-encodes to AAC locally
 * — real generation loss, but never unavailable). Mirrors the 3 variants
 * analysisPipeline.js already compares side by side, but here the user picks
 * one upfront instead of getting all of them.
 */
export async function runDownload(url, { onProgress, destination, format = 'opus' } = {}) {
  const emit = (stage, data) => onProgress?.(stage, data);

  emit('info_start');
  let info;
  try {
    info = await ytDlp.fetchInfoAsync(url);
  } catch (err) {
    throw taggedError(err, 502, 'Falha ao obter informações do vídeo');
  }
  emit('info_done', { title: info.title });

  emit('download_start');
  let download;
  try {
    if (format === 'aac_transcoded') {
      download = await ytDlp.downloadAsync(url, info, {
        onProgress: (p) => emit('download_progress', p),
      });
    } else {
      download = await ytDlp.downloadVariantAsync(url, info, FORMAT_SELECTORS[format], {
        onProgress: (p) => emit('download_progress', p),
      });
      if (!download) {
        throw taggedError(
          new Error(`Formato "${FORMAT_LABELS[format]}" não disponível para essa faixa — tente outro formato.`),
          422,
          'Formato indisponível'
        );
      }
    }
  } catch (err) {
    throw taggedError(err, 502, 'Falha ao baixar o áudio');
  }

  const cleanupCandidates = [download.filePath];

  try {
    let finalFilePath;
    let metadata;
    if (format === 'aac_transcoded') {
      emit('transcode_start');
      const outputDir = await ytDlp.createTempJobDirAsync();
      finalFilePath = await ffmpeg.transcodeToAacAsync(download.filePath, outputDir);
      cleanupCandidates.push(finalFilePath);
      emit('transcode_done');
      metadata = await ffmpeg.getMetadataAsync(finalFilePath);
    } else {
      emit('remux_start');
      metadata = await ffmpeg.getMetadataAsync(download.filePath);
      finalFilePath = await ffmpeg.remuxForDownloadAsync(download.filePath, metadata.codecName);
      emit('remux_done');
    }

    // Best-effort — the download and library save already succeeded by this
    // point, so a quality-check failure (corrupt edge-case file, etc.) is
    // logged and degrades to spectrum: null rather than failing the whole
    // download over a nice-to-have.
    let spectrum = null;
    try {
      emit('quality_check_start');
      const pcm = await ffmpeg.decodeToMonoPcmAsync(finalFilePath, metadata.sampleRateHz);
      const analyzed = spectrumAnalyzer.analyze(pcm, metadata.sampleRateHz);
      spectrum = {
        cutoffHz: analyzed.cutoffHz,
        verdict: analyzed.verdict,
        verdictLevel: analyzed.verdictLevel,
      };
      emit('quality_check_done');
    } catch (err) {
      console.error('Falha ao verificar qualidade espectral (não crítico)', err);
    }

    let savedPath = null;
    if (destination) {
      emit('save_start');
      const ext = path.extname(finalFilePath).slice(1) || 'm4a';
      const absoluteSavedPath = await libraryStore.saveToLibraryAsync(
        finalFilePath,
        destination.subfolder,
        destination.fileNameBase || download.title,
        ext
      );
      savedPath = path.relative(config.libraryRoot, absoluteSavedPath);
      emit('save_done');
    }

    // Only finalFilePath needs to survive going forward (downloadStore keeps
    // it alive for the manual re-download link) — the original native temp
    // file is a separate dir only in the aac_transcoded case, so discard it
    // now instead of leaking it past this function's lifetime.
    if (finalFilePath !== download.filePath) {
      await ytDlp.cleanupTempFile(download.filePath);
    }

    downloadStore.set(
      info.id,
      DOWNLOAD_VARIANT_ID,
      finalFilePath,
      buildDownloadFileName(download.title, finalFilePath)
    );

    return {
      videoId: info.id,
      title: download.title,
      uploader: download.uploader,
      cookieInvalid: download.cookieInvalid,
      downloadUrl: `/api/download/${info.id}/${DOWNLOAD_VARIANT_ID}`,
      savedPath,
      spectrum,
      formatNote: buildFormatNote(format),
    };
  } catch (err) {
    await Promise.all(cleanupCandidates.map((fp) => ytDlp.cleanupTempFile(fp)));
    throw taggedError(err, 500, 'Falha ao preparar o áudio para download');
  }
}

function buildDownloadFileName(title, downloadFilePath) {
  const ext = path.extname(downloadFilePath).slice(1) || 'm4a';
  const safeTitle = (title || 'faixa').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 150) || 'faixa';
  return `${safeTitle}.${ext}`;
}

function taggedError(err, httpStatus, title) {
  if (err.httpStatus) return err; // already tagged closer to the source
  err.httpStatus = httpStatus;
  err.title = title;
  return err;
}
