import FFT from 'fft.js';

/**
 * Estimates the effective frequency cutoff of an audio signal by averaging the magnitude
 * spectrum across several windows spread throughout the track. Lossy sources (or files that
 * were transcoded from a low-bitrate lossy source and then upsampled/re-encoded into a
 * higher-bitrate container) show a sharp energy drop-off well below the theoretical Nyquist
 * frequency. This mirrors — approximately — what you'd see visually in a spectrogram from
 * rekordbox, Spek, or Sonic Visualiser.
 *
 * This is a heuristic, not a certified codec detector: treat the verdict as a strong hint
 * worth a listen, not a lab measurement.
 */
const WINDOW_SIZE = 4096;
const MAX_WINDOWS = 60;

const fft = new FFT(WINDOW_SIZE);
const hannWindow = buildHannWindow(WINDOW_SIZE);

export function analyze(samples, sampleRate) {
  if (samples.length < WINDOW_SIZE * 2) {
    throw new Error('Áudio decodificado é curto demais para análise espectral.');
  }

  const usableLength = samples.length - WINDOW_SIZE;
  const step = Math.max(WINDOW_SIZE / 2, Math.floor(usableLength / MAX_WINDOWS));

  const accum = new Float64Array(WINDOW_SIZE / 2);
  const windowed = new Float64Array(WINDOW_SIZE);
  const complexOut = fft.createComplexArray();
  let count = 0;

  for (let start = 0; start + WINDOW_SIZE <= samples.length && count < MAX_WINDOWS; start += step) {
    for (let i = 0; i < WINDOW_SIZE; i++) {
      windowed[i] = samples[start + i] * hannWindow[i];
    }

    fft.realTransform(complexOut, windowed);
    fft.completeSpectrum(complexOut);

    for (let i = 0; i < WINDOW_SIZE / 2; i++) {
      const re = complexOut[2 * i];
      const im = complexOut[2 * i + 1];
      accum[i] += Math.sqrt(re * re + im * im);
    }

    count++;
  }

  if (count === 0) {
    throw new Error('Não foi possível extrair janelas de FFT do áudio.');
  }

  for (let i = 0; i < accum.length; i++) {
    accum[i] /= count;
  }

  const maxMag = Math.max(...accum, 1e-12);
  const magnitudeDb = Array.from(accum, (m) => 20 * Math.log10(Math.max(m, 1e-12) / maxMag));
  const smoothed = movingAverage(magnitudeDb, 7);

  const nyquist = sampleRate / 2.0;
  const binHz = nyquist / (WINDOW_SIZE / 2);
  const freqBins = Array.from({ length: WINDOW_SIZE / 2 }, (_, i) => i * binHz);

  // Reference band: 1kHz-5kHz, where almost all encoders preserve full energy.
  const refStart = clampIndex(Math.floor(1000 / binHz), smoothed.length);
  const refEnd = clampIndex(Math.floor(5000 / binHz), smoothed.length);
  const midBandRefDb = average(smoothed.slice(refStart, Math.max(refStart + 1, refEnd)));

  // Noise floor: top 3% of the spectrum, right below Nyquist.
  const topStart = clampIndex(Math.floor(smoothed.length * 0.97), smoothed.length);
  const noiseFloorDb = average(smoothed.slice(topStart));

  const dropThresholdDb = midBandRefDb - 24.0; // 24dB below mid-band = effectively silent

  let cutoffHz = nyquist;
  for (let i = smoothed.length - 1; i >= refEnd; i--) {
    if (smoothed[i] > dropThresholdDb) {
      cutoffHz = freqBins[i];
      break;
    }
  }

  const { verdict, level, details } = classifyVerdict(cutoffHz, nyquist, noiseFloorDb, midBandRefDb);

  return {
    cutoffHz,
    nyquistHz: nyquist,
    noiseFloorDb,
    midBandRefDb,
    verdict,
    verdictLevel: level,
    details,
    freqBinsHz: freqBins,
    magnitudeDb: smoothed,
  };
}

function classifyVerdict(cutoffHz, nyquistHz, noiseFloorDb, midBandRefDb) {
  const cutoffRatio = cutoffHz / nyquistHz;
  const floorGap = midBandRefDb - noiseFloorDb; // how much the top of the spectrum has decayed

  const details = `Corte estimado em ${(cutoffHz / 1000.0).toFixed(1)} kHz de um Nyquist de ${(nyquistHz / 1000.0).toFixed(1)} kHz ` +
    `(piso de ruído ${noiseFloorDb.toFixed(1)} dB, referência de banda média ${midBandRefDb.toFixed(1)} dB).`;

  if (cutoffRatio > 0.95 && floorGap < 15) {
    return {
      verdict: 'Espectro completo até perto do limite teórico. Consistente com fonte sem perdas ou bitrate muito alto.',
      level: 'high',
      details,
    };
  }

  if (cutoffHz >= 19000) {
    return {
      verdict: 'Espectro preservado até ~19-20kHz. Consistente com MP3/AAC/Opus de alto bitrate (≈256-320kbps).',
      level: 'high',
      details,
    };
  }

  if (cutoffHz >= 16000) {
    return {
      verdict: 'Corte por volta de 16-19kHz. Consistente com bitrate médio (≈160-224kbps) — ainda razoável para pista, mas não é topo de linha.',
      level: 'medium',
      details,
    };
  }

  if (cutoffHz >= 13000) {
    return {
      verdict: 'Corte por volta de 13-16kHz. Sinal forte de fonte de baixo bitrate (≈128kbps ou reencode), mesmo que os metadados declarem outra coisa.',
      level: 'low',
      details,
    };
  }

  return {
    verdict: 'Corte abaixo de 13kHz. Fonte provavelmente muito comprimida, baixa qualidade ou transcodificação múltipla.',
    level: 'low',
    details,
  };
}

function buildHannWindow(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

function movingAverage(data, radius) {
  const result = new Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(data.length - 1, i + radius);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += data[j];
    result[i] = sum / (hi - lo + 1);
  }
  return result;
}

function average(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function clampIndex(index, length) {
  return Math.max(0, Math.min(index, length - 1));
}
