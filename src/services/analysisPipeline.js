import * as ytDlp from './ytDlpService.js';
import * as ffmpeg from './ffmpegService.js';
import * as spectrumAnalyzer from './spectrumAnalyzer.js';
import * as analysisCache from './analysisCache.js';

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

    const notes = [];

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

    if (metadata.sampleRateHz < 44100) {
      notes.push(`Sample rate de ${metadata.sampleRateHz}Hz está abaixo do padrão de CD/streaming (44.1kHz).`);
    }

    result = {
      title: download.title,
      uploader: download.uploader,
      sourceUrl: url,
      metadata,
      spectrum,
      spectrogramUrl,
      overallVerdict: spectrum.verdict,
      overallVerdictLevel: spectrum.verdictLevel,
      notes,
    };

    analysisCache.set(info.id, result);
  } catch (err) {
    throw taggedError(err, 500, 'Falha ao analisar o áudio');
  } finally {
    await ytDlp.cleanupTempFile(download.filePath);
  }

  return result;
}

function taggedError(err, httpStatus, title) {
  if (err.httpStatus) return err; // already tagged closer to the source
  err.httpStatus = httpStatus;
  err.title = title;
  return err;
}
