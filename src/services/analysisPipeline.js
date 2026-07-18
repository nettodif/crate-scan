import path from 'node:path';
import * as ytDlp from './ytDlpService.js';
import * as ffmpeg from './ffmpegService.js';
import * as spectrumAnalyzer from './spectrumAnalyzer.js';
import * as structureAnalyzer from './structureAnalyzer.js';
import * as analysisCache from './analysisCache.js';
import * as downloadStore from './downloadStore.js';

/**
 * Runs the full download + analysis pipeline for a URL, emitting stage events
 * via onProgress(stage, data) so callers (SSE route, tests) can report progress.
 * Shared by the blocking POST route and the streaming SSE route so both stay in sync.
 */
export async function runAnalysis(url, { onProgress } = {}) {
  const emit = (stage, data) => onProgress?.(stage, data);

  emit('info_start');
  let info;
  try {
    info = await ytDlp.fetchInfoAsync(url);
  } catch (err) {
    throw taggedError(err, 502, 'Falha ao obter informações do vídeo');
  }
  emit('info_done', { title: info.title });

  const cached = analysisCache.get(info.id);
  if (cached) {
    emit('cached');
    return { ...cached, cached: true };
  }

  emit('download_start');
  let download;
  try {
    download = await ytDlp.downloadAsync(url, info, {
      onProgress: (p) => emit('download_progress', p),
    });
  } catch (err) {
    throw taggedError(err, 502, 'Falha ao baixar o áudio');
  }

  let result;
  try {
    emit('metadata_start');
    const metadata = await ffmpeg.getMetadataAsync(download.filePath);
    emit('metadata_done');

    emit('spectrogram_start');
    const spectrogramUrl = await ffmpeg.generateSpectrogramAsync(download.filePath, download.id);
    emit('spectrogram_done');

    emit('fft_start');
    const pcm = await ffmpeg.decodeToMonoPcmAsync(download.filePath, metadata.sampleRateHz);
    const spectrum = spectrumAnalyzer.analyze(pcm, metadata.sampleRateHz);
    emit('fft_done');

    emit('structure_start');
    const structure = structureAnalyzer.analyze(pcm, metadata.sampleRateHz, metadata.durationSec);
    emit('structure_done');

    const notes = [];

    if (download.cookieInvalid) {
      notes.push(
        'Atenção: o cookie configurado não é mais válido (expirado ou rotacionado) — ' +
        'essa análise rodou sem autenticação, como visitante anônimo. Exporte um cookies.txt novo e reenvie.'
      );
    }

    // Cross-check: does the declared bitrate roughly match what the spectrum suggests?
    if (metadata.declaredBitrateBps > 0) {
      const declaredKbps = metadata.declaredBitrateBps / 1000.0;
      const declaredIsHigh = declaredKbps >= 192;
      const spectrumIsLow = spectrum.verdictLevel === 'low';

      if (declaredIsHigh && spectrumIsLow) {
        notes.push(
          `Atenção: o bitrate declarado (${declaredKbps.toFixed(0)}kbps) é alto, mas o conteúdo espectral ` +
          'sugere uma fonte de baixa qualidade. É provável que o arquivo tenha sido transcodificado ' +
          "a partir de uma fonte já comprimida (ex.: MP3 128kbps reempacotado em algo 'maior')."
        );
      }
    } else {
      notes.push('O container não expôs um bitrate declarado explícito; use o corte espectral como referência principal.');
    }

    // Cross-check: o bitrate medido no arquivo baixado bate com o que o yt-dlp informou
    // pra esse formato nativo? Se o medido vier bem maior, o arquivo foi reencodado/remuxado
    // após o download original (ex.: Opus ~160kbps convertido pra AAC em qualidade alta) —
    // isso infla o número sem ganho real de qualidade, o mesmo problema que o corte espectral
    // tenta desmascarar.
    const source = download.sourceFormat;
    if (source?.abrKbps && metadata.declaredBitrateBps > 0) {
      const measuredKbps = metadata.declaredBitrateBps / 1000;
      if (measuredKbps > source.abrKbps * 1.15) {
        notes.push(
          `Atenção: bitrate medido no arquivo (${measuredKbps.toFixed(0)}kbps) é maior que o bitrate da ` +
          `fonte nativa informada pelo yt-dlp (${source.abrKbps.toFixed(0)}kbps, codec ${source.acodec ?? 'desconhecido'}). ` +
          'Isso sugere que o arquivo foi reencodado/convertido depois do download original, inflando o ' +
          'bitrate declarado sem ganho real de qualidade.'
        );
      }
    }

    if (metadata.sampleRateHz < 44100) {
      notes.push(`Sample rate de ${metadata.sampleRateHz}Hz está abaixo do padrão de CD/streaming (44.1kHz).`);
    }

    result = {
      videoId: info.id,
      title: download.title,
      uploader: download.uploader,
      sourceUrl: url,
      metadata,
      spectrum,
      structure,
      spectrogramUrl,
      overallVerdict: spectrum.verdict,
      overallVerdictLevel: spectrum.verdictLevel,
      notes,
      downloadUrl: `/api/download/${info.id}`,
    };

    analysisCache.set(info.id, result);

    const downloadFilePath = await ffmpeg.remuxForDownloadAsync(download.filePath, metadata.codecName);
    downloadStore.set(info.id, downloadFilePath, buildDownloadFileName(download, downloadFilePath));
  } catch (err) {
    await ytDlp.cleanupTempFile(download.filePath);
    throw taggedError(err, 500, 'Falha ao analisar o áudio');
  }

  return result;
}

function buildDownloadFileName(download, downloadFilePath) {
  const ext = path.extname(downloadFilePath).slice(1) || 'm4a';
  const safeTitle = (download.title || 'faixa').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 150) || 'faixa';
  return `${safeTitle}.${ext}`;
}

function taggedError(err, httpStatus, title) {
  if (err.httpStatus) return err; // already tagged closer to the source
  err.httpStatus = httpStatus;
  err.title = title;
  return err;
}
