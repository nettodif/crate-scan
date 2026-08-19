import path from 'node:path';
import * as ytDlp from './ytDlpService.js';
import * as ffmpeg from './ffmpegService.js';
import * as spectrumAnalyzer from './spectrumAnalyzer.js';
import * as structureAnalyzer from './structureAnalyzer.js';
import * as analysisCache from './analysisCache.js';
import * as downloadStore from './downloadStore.js';

// Codecs Rekordbox/Serato actually import — notably excludes Opus/Vorbis (the
// formats YouTube's "bestaudio" most commonly resolves to), which is the whole
// reason the extra AAC variants below exist.
const REKORDBOX_COMPATIBLE_CODECS = new Set(['aac', 'mp3', 'flac', 'wav', 'pcm_s16le', 'pcm_s24le']);

const AAC_NATIVE_FORMAT_SELECTOR = 'bestaudio[acodec^=mp4a]/bestaudio[acodec^=aac]';

/**
 * Runs the full download + analysis pipeline for a URL, emitting stage events
 * via onProgress(stage, data) so callers (SSE route, tests) can report progress.
 * Shared by the blocking POST route and the streaming SSE route so both stay in sync.
 *
 * Always analyzes the native "bestaudio/best" stream. When that native codec
 * isn't importable into Rekordbox/Serato (i.e. not aac/mp3/flac/wav — typically
 * Opus/Vorbis on YouTube), it additionally attempts an AAC-native download
 * (best-effort — yt-dlp may not offer one for a given video) and an
 * AAC transcode of the native file (always possible, but carries real
 * generation loss), so the user can compare and pick which file to actually
 * use for DJing.
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
  let nativeDownload;
  try {
    nativeDownload = await ytDlp.downloadAsync(url, info, {
      onProgress: (p) => emit('download_progress', p),
    });
  } catch (err) {
    throw taggedError(err, 502, 'Falha ao baixar o áudio');
  }

  const filePathsForCleanup = [nativeDownload.filePath];

  let result;
  try {
    emit('metadata_start');
    const nativeMetadata = await ffmpeg.getMetadataAsync(nativeDownload.filePath);
    emit('metadata_done');

    const needsExtraVariants = !REKORDBOX_COMPATIBLE_CODECS.has(nativeMetadata.codecName);
    const plannedVariantIds = needsExtraVariants ? ['native', 'aac_native', 'aac_transcoded'] : ['native'];
    emit('variant_plan', { variantIds: plannedVariantIds, needsExtraVariants });

    const variantSources = {
      native: {
        filePath: nativeDownload.filePath,
        metadata: nativeMetadata,
        sourceFormat: nativeDownload.sourceFormat,
        cookieInvalid: nativeDownload.cookieInvalid,
        isTranscoded: false,
      },
    };
    const unavailableReasons = {};

    if (needsExtraVariants) {
      const [aacNativeSettled, aacTranscodedSettled] = await Promise.allSettled([
        fetchAacNativeVariant(url, info, emit),
        transcodeAacVariant(nativeDownload.filePath, emit),
      ]);

      if (aacNativeSettled.status === 'fulfilled' && aacNativeSettled.value) {
        const d = aacNativeSettled.value;
        filePathsForCleanup.push(d.filePath);
        variantSources.aac_native = {
          filePath: d.filePath,
          sourceFormat: d.sourceFormat,
          cookieInvalid: d.cookieInvalid,
          isTranscoded: false,
        };
      } else {
        const reason = aacNativeSettled.status === 'rejected'
          ? (aacNativeSettled.reason?.message ?? 'Falha desconhecida ao buscar AAC nativo.')
          : 'yt-dlp não encontrou um stream AAC nativo pra esse vídeo.';
        unavailableReasons.aac_native = reason;
        emit('variant_unavailable', { variantId: 'aac_native', reason });
      }

      if (aacTranscodedSettled.status === 'fulfilled') {
        filePathsForCleanup.push(aacTranscodedSettled.value);
        variantSources.aac_transcoded = {
          filePath: aacTranscodedSettled.value,
          sourceFormat: null,
          cookieInvalid: false,
          isTranscoded: true,
        };
      } else {
        const reason = aacTranscodedSettled.reason?.message ?? 'Falha ao transcodificar para AAC.';
        unavailableReasons.aac_transcoded = reason;
        emit('variant_unavailable', { variantId: 'aac_transcoded', reason });
      }
    }

    let nativePcm = null;
    await Promise.all(Object.keys(variantSources).map(async (variantId) => {
      const source = variantSources[variantId];

      if (!source.metadata) {
        emit('variant_metadata_start', { variantId });
        source.metadata = await ffmpeg.getMetadataAsync(source.filePath);
        emit('variant_metadata_done', { variantId });
      }

      emit('variant_spectrogram_start', { variantId });
      source.spectrogramUrl = await ffmpeg.generateSpectrogramAsync(source.filePath, `${info.id}_${variantId}`);
      emit('variant_spectrogram_done', { variantId });

      emit('variant_fft_start', { variantId });
      const pcm = await ffmpeg.decodeToMonoPcmAsync(source.filePath, source.metadata.sampleRateHz);
      source.spectrum = spectrumAnalyzer.analyze(pcm, source.metadata.sampleRateHz);
      emit('variant_fft_done', { variantId });

      if (variantId === 'native') nativePcm = pcm;
    }));

    emit('structure_start');
    const structure = structureAnalyzer.analyze(
      nativePcm,
      variantSources.native.metadata.sampleRateHz,
      variantSources.native.metadata.durationSec
    );
    emit('structure_done');

    const variants = plannedVariantIds.map((variantId) => {
      const source = variantSources[variantId];
      if (!source) {
        return {
          variantId,
          label: buildVariantLabel(variantId, null),
          available: false,
          unavailableReason: unavailableReasons[variantId] ?? 'Indisponível',
          isTranscoded: variantId === 'aac_transcoded',
          rekordboxCompatible: null,
          metadata: null,
          spectrum: null,
          spectrogramUrl: null,
          downloadUrl: null,
        };
      }
      return {
        variantId,
        label: buildVariantLabel(variantId, source.metadata.codecName),
        available: true,
        unavailableReason: null,
        isTranscoded: source.isTranscoded,
        rekordboxCompatible: REKORDBOX_COMPATIBLE_CODECS.has(source.metadata.codecName),
        metadata: source.metadata,
        spectrum: source.spectrum,
        spectrogramUrl: source.spectrogramUrl,
        downloadUrl: `/api/download/${info.id}/${variantId}`,
      };
    });

    const recommendedVariantId = pickRecommendedVariant(variants);
    const recommended = variants.find((v) => v.variantId === recommendedVariantId);

    const notes = [
      ...buildNativeNotes(variantSources.native),
      ...buildVariantComparisonNotes({ variants, recommendedVariantId, needsExtraVariants }),
    ];

    result = {
      videoId: info.id,
      title: nativeDownload.title,
      uploader: nativeDownload.uploader,
      sourceUrl: url,
      variants,
      recommendedVariantId,
      structure,
      notes,
      // Mirror fields sourced from the recommended variant, kept for backward
      // compatibility with reportGenerator.js and any other flat-shape reader.
      metadata: recommended.metadata,
      spectrum: recommended.spectrum,
      spectrogramUrl: recommended.spectrogramUrl,
      overallVerdict: recommended.spectrum.verdict,
      overallVerdictLevel: recommended.spectrum.verdictLevel,
      downloadUrl: recommended.downloadUrl,
    };

    analysisCache.set(info.id, result);

    await Promise.all(variants.filter((v) => v.available).map(async (v) => {
      const source = variantSources[v.variantId];
      const downloadFilePath = await ffmpeg.remuxForDownloadAsync(source.filePath, source.metadata.codecName);
      downloadStore.set(
        info.id,
        v.variantId,
        downloadFilePath,
        buildDownloadFileName(nativeDownload.title, v.variantId, downloadFilePath)
      );
    }));
  } catch (err) {
    await Promise.all(filePathsForCleanup.map((fp) => ytDlp.cleanupTempFile(fp)));
    throw taggedError(err, 500, 'Falha ao analisar o áudio');
  }

  return result;
}

async function fetchAacNativeVariant(url, info, emit) {
  emit('variant_fetch_start', { variantId: 'aac_native' });
  const download = await ytDlp.downloadVariantAsync(url, info, AAC_NATIVE_FORMAT_SELECTOR);
  emit('variant_fetch_done', { variantId: 'aac_native', available: Boolean(download) });
  return download;
}

async function transcodeAacVariant(nativeFilePath, emit) {
  emit('variant_transcode_start', { variantId: 'aac_transcoded' });
  const outputDir = await ytDlp.createTempJobDirAsync();
  const filePath = await ffmpeg.transcodeToAacAsync(nativeFilePath, outputDir);
  emit('variant_transcode_done', { variantId: 'aac_transcoded' });
  return filePath;
}

function buildVariantLabel(variantId, codecName) {
  if (variantId === 'native') return `Nativo (${(codecName ?? 'desconhecido').toUpperCase()})`;
  if (variantId === 'aac_native') return 'AAC nativo';
  if (variantId === 'aac_transcoded') return 'AAC transcodificado';
  return variantId;
}

/**
 * Highest measured spectral cutoff among available variants wins; an exact
 * tie prefers the non-transcoded option (no generation loss). Deliberately
 * doesn't exclude aac_transcoded from candidacy outright — if it genuinely
 * measures best (e.g. AAC native was unavailable), it can still win, and a
 * note is added to flag that it's a transcode regardless.
 */
function pickRecommendedVariant(variants) {
  const available = variants.filter((v) => v.available);
  const sorted = [...available].sort((a, b) => {
    if (b.spectrum.cutoffHz !== a.spectrum.cutoffHz) return b.spectrum.cutoffHz - a.spectrum.cutoffHz;
    if (a.isTranscoded !== b.isTranscoded) return a.isTranscoded ? 1 : -1;
    return 0;
  });
  return sorted[0]?.variantId ?? null;
}

function buildNativeNotes(nativeSource) {
  const notes = [];
  const { metadata, spectrum, sourceFormat, cookieInvalid } = nativeSource;

  if (cookieInvalid) {
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
  if (sourceFormat?.abrKbps && metadata.declaredBitrateBps > 0) {
    const measuredKbps = metadata.declaredBitrateBps / 1000;
    if (measuredKbps > sourceFormat.abrKbps * 1.15) {
      notes.push(
        `Atenção: bitrate medido no arquivo (${measuredKbps.toFixed(0)}kbps) é maior que o bitrate da ` +
        `fonte nativa informada pelo yt-dlp (${sourceFormat.abrKbps.toFixed(0)}kbps, codec ${sourceFormat.acodec ?? 'desconhecido'}). ` +
        'Isso sugere que o arquivo foi reencodado/convertido depois do download original, inflando o ' +
        'bitrate declarado sem ganho real de qualidade.'
      );
    }
  }

  if (metadata.sampleRateHz < 44100) {
    notes.push(`Sample rate de ${metadata.sampleRateHz}Hz está abaixo do padrão de CD/streaming (44.1kHz).`);
  }

  return notes;
}

function buildVariantComparisonNotes({ variants, recommendedVariantId, needsExtraVariants }) {
  if (!needsExtraVariants) return [];

  const notes = [];
  const nativeVariant = variants.find((v) => v.variantId === 'native');
  const aacNativeVariant = variants.find((v) => v.variantId === 'aac_native');
  const aacTranscodedVariant = variants.find((v) => v.variantId === 'aac_transcoded');

  if (aacNativeVariant && !aacNativeVariant.available) {
    notes.push(`AAC nativo indisponível: ${aacNativeVariant.unavailableReason}`);
  }

  if (nativeVariant?.available && !nativeVariant.rekordboxCompatible) {
    if (recommendedVariantId !== 'native') {
      const recommended = variants.find((v) => v.variantId === recommendedVariantId);
      notes.push(
        `A versão nativa (${nativeVariant.metadata.codecName.toUpperCase()}) não é compatível com Rekordbox/Serato. ` +
        `Recomendado baixar "${recommended.label}" para uso em software de DJ.`
      );
    } else {
      notes.push(
        `A versão nativa (${nativeVariant.metadata.codecName.toUpperCase()}) não é compatível com Rekordbox/Serato.`
      );
    }
  }

  if (recommendedVariantId === 'aac_transcoded' && aacTranscodedVariant) {
    notes.push(
      'A variante recomendada é uma transcodificação (AAC gerado a partir do arquivo nativo) — carrega perda ' +
      'de geração real, mesmo tendo medido o melhor corte espectral entre as opções disponíveis.'
    );
  }

  return notes;
}

function buildDownloadFileName(title, variantId, downloadFilePath) {
  const ext = path.extname(downloadFilePath).slice(1) || 'm4a';
  const safeTitle = (title || 'faixa').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 150) || 'faixa';
  const suffix = variantId === 'native' ? '' : `_${variantId}`;
  return `${safeTitle}${suffix}.${ext}`;
}

function taggedError(err, httpStatus, title) {
  if (err.httpStatus) return err; // already tagged closer to the source
  err.httpStatus = httpStatus;
  err.title = title;
  return err;
}
