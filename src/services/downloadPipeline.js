import path from 'node:path';
import * as ytDlp from './ytDlpService.js';
import * as ffmpeg from './ffmpegService.js';
import * as downloadStore from './downloadStore.js';

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
 */
export async function runDownload(url, { onProgress } = {}) {
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
    download = await ytDlp.downloadAsync(url, info, {
      onProgress: (p) => emit('download_progress', p),
    });
  } catch (err) {
    throw taggedError(err, 502, 'Falha ao baixar o áudio');
  }

  try {
    emit('remux_start');
    const metadata = await ffmpeg.getMetadataAsync(download.filePath);
    const downloadFilePath = await ffmpeg.remuxForDownloadAsync(download.filePath, metadata.codecName);
    emit('remux_done');

    downloadStore.set(
      info.id,
      DOWNLOAD_VARIANT_ID,
      downloadFilePath,
      buildDownloadFileName(download.title, downloadFilePath)
    );

    return {
      videoId: info.id,
      title: download.title,
      uploader: download.uploader,
      cookieInvalid: download.cookieInvalid,
      downloadUrl: `/api/download/${info.id}/${DOWNLOAD_VARIANT_ID}`,
    };
  } catch (err) {
    await ytDlp.cleanupTempFile(download.filePath);
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
