/**
 * Estimates a track's rough structure (intro, drop(s), breakdown, outro) from a mono PCM
 * energy envelope, and turns that into suggested Rekordbox hot cues plus a mixing-style
 * hint (classic long blend vs. hard cut vs. hybrid).
 *
 * This is a coarse, self-relative heuristic — thresholds are computed from the track's own
 * energy percentiles, not absolute dB — not a beatgrid/onset-detection engine. Treat the
 * output as a suggestion to sanity-check by ear, same spirit as spectrumAnalyzer's verdicts.
 */
const FRAME_SEC = 0.5;
const HOP_RATIO = 0.5;
const SMOOTH_RADIUS = 3;
const MIN_DURATION_SEC = 90;
const MAX_CUES = 5;
const MIN_SECTION_GAP_SEC = 30;
const SUSTAIN_SEC = 1.5;
const RISE_WINDOW_SEC = 4;
const RISE_HOLD_SEC = 4;

export function analyze(samples, sampleRate, durationSec) {
  const frameSize = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const hop = Math.max(1, Math.round(frameSize * HOP_RATIO));

  const { energyDb, frameTimesSec } = buildEnergyEnvelope(samples, sampleRate, frameSize, hop);
  const smoothed = movingAverage(energyDb, SMOOTH_RADIUS);

  const sorted = [...smoothed].sort((a, b) => a - b);
  const p10 = percentile(sorted, 0.10);
  const p50 = percentile(sorted, 0.50);
  const p90 = percentile(sorted, 0.90);
  const energyRangeDb = Math.max(p90 - p10, 1e-6);

  const framesPerSec = 1 / (hop / sampleRate);
  const sustainFrames = Math.max(1, Math.round(SUSTAIN_SEC * framesPerSec));
  const riseWindowFrames = Math.max(1, Math.round(RISE_WINDOW_SEC * framesPerSec));
  const riseHoldFrames = Math.max(1, Math.round(RISE_HOLD_SEC * framesPerSec));
  const minGapFrames = Math.max(1, Math.round(MIN_SECTION_GAP_SEC * framesPerSec));

  const introEndIdx = findIntroEnd(smoothed, p50, energyRangeDb, sustainFrames);
  const outroStartIdx = findOutroStart(smoothed, p50, energyRangeDb, sustainFrames);

  const drops = findDrops(smoothed, introEndIdx, outroStartIdx, energyRangeDb, riseWindowFrames, riseHoldFrames, minGapFrames, 2);
  const breakdown = drops.length > 0
    ? findBreakdown(smoothed, drops[0].peakIdx, outroStartIdx, energyRangeDb, riseHoldFrames, minGapFrames)
    : null;

  const introEnd = frameTimesSec[introEndIdx] ?? 0;
  const outroStart = frameTimesSec[outroStartIdx] ?? durationSec;

  const sections = buildSections(introEnd, drops, breakdown, outroStart, durationSec, frameTimesSec);
  const hotCues = buildHotCues(introEnd, drops, breakdown, outroStart, energyRangeDb, frameTimesSec);

  const overallConfidence = confidenceFromRange(energyRangeDb);
  const { mixingStyle, mixingStyleConfidence } = classifyMixingStyle(
    smoothed, p50, energyRangeDb, introEnd, outroStart, durationSec
  );

  return {
    sections,
    hotCues,
    mixingStyle,
    mixingStyleConfidence,
    overallConfidence,
  };
}

function buildEnergyEnvelope(samples, sampleRate, frameSize, hop) {
  const energyDb = [];
  const frameTimesSec = [];

  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    let sumSquares = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = samples[start + i];
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / frameSize);
    energyDb.push(20 * Math.log10(Math.max(rms, 1e-9)));
    frameTimesSec.push((start + frameSize / 2) / sampleRate);
  }

  if (energyDb.length === 0) {
    energyDb.push(20 * Math.log10(1e-9));
    frameTimesSec.push(0);
  }

  return { energyDb, frameTimesSec };
}

function findIntroEnd(energy, p50, rangeDb, sustainFrames) {
  const threshold = p50 - 0.25 * rangeDb;
  for (let i = 0; i + sustainFrames <= energy.length; i++) {
    if (sustainsAbove(energy, i, sustainFrames, threshold)) return i;
  }
  return 0;
}

function findOutroStart(energy, p50, rangeDb, sustainFrames) {
  const threshold = p50 - 0.25 * rangeDb;
  for (let i = energy.length - sustainFrames; i >= 0; i--) {
    if (sustainsAbove(energy, i, sustainFrames, threshold)) return i + sustainFrames - 1;
  }
  return energy.length - 1;
}

function sustainsAbove(energy, startIdx, count, threshold) {
  for (let j = 0; j < count; j++) {
    if (energy[startIdx + j] <= threshold) return false;
  }
  return true;
}

function findDrops(energy, startIdx, endIdx, rangeDb, riseWindowFrames, riseHoldFrames, minGapFrames, maxDrops) {
  const drops = [];
  const jumpThreshold = 0.5 * rangeDb;
  let searchFrom = startIdx;

  while (drops.length < maxDrops) {
    const found = findNextDrop(energy, searchFrom, endIdx, jumpThreshold, riseWindowFrames, riseHoldFrames);
    if (!found) break;
    drops.push(found);
    searchFrom = found.peakIdx + minGapFrames;
  }

  return drops;
}

function findNextDrop(energy, from, to, jumpThreshold, riseWindowFrames, riseHoldFrames) {
  for (let i = from; i + riseWindowFrames + riseHoldFrames < to; i++) {
    const base = energy[i];
    let peakIdx = i;
    let peakVal = base;
    for (let j = i + 1; j <= i + riseWindowFrames; j++) {
      if (energy[j] > peakVal) {
        peakVal = energy[j];
        peakIdx = j;
      }
    }

    if (peakVal - base < jumpThreshold) continue;

    let holds = true;
    for (let j = peakIdx; j < peakIdx + riseHoldFrames && j < energy.length; j++) {
      if (peakVal - energy[j] > 3) {
        holds = false;
        break;
      }
    }
    if (!holds) continue;

    return { startIdx: i, peakIdx };
  }
  return null;
}

function findBreakdown(energy, fromIdx, toIdx, rangeDb, holdFrames, minGapFrames) {
  const dipThreshold = 0.35 * rangeDb;
  for (let i = fromIdx + minGapFrames; i + holdFrames < toIdx; i++) {
    const peakVal = energy[i];
    const dipVal = Math.min(...energy.slice(i, i + holdFrames));
    if (peakVal - dipVal >= dipThreshold) {
      const dipIdx = i + energy.slice(i, i + holdFrames).indexOf(dipVal);
      const endIdx = Math.min(dipIdx + holdFrames, toIdx);
      return { startIdx: dipIdx, endIdx };
    }
  }
  return null;
}

function buildSections(introEnd, drops, breakdown, outroStart, durationSec, frameTimesSec) {
  const sections = [{ type: 'intro', startSec: 0, endSec: round2(introEnd) }];

  drops.forEach((drop, i) => {
    const startSec = frameTimesSec[drop.startIdx] ?? introEnd;
    sections.push({ type: 'drop', startSec: round2(startSec), label: `Drop ${i + 1}` });
  });

  if (breakdown) {
    sections.push({
      type: 'breakdown',
      startSec: round2(frameTimesSec[breakdown.startIdx] ?? 0),
      endSec: round2(frameTimesSec[breakdown.endIdx] ?? 0),
    });
  }

  sections.push({ type: 'outro', startSec: round2(outroStart), endSec: round2(durationSec) });

  return sections.sort((a, b) => a.startSec - b.startSec);
}

function buildHotCues(introEnd, drops, breakdown, outroStart, rangeDb, frameTimesSec) {
  const confidence = confidenceFromRange(rangeDb);
  const cues = [];

  if (introEnd > 0) cues.push({ timeSec: round2(introEnd), label: 'Fim da Intro', confidence });
  drops.forEach((drop, i) => {
    cues.push({ timeSec: round2(frameTimesSec[drop.startIdx] ?? 0), label: `Drop ${i + 1}`, confidence });
  });
  if (breakdown) cues.push({ timeSec: round2(frameTimesSec[breakdown.startIdx] ?? 0), label: 'Breakdown', confidence });
  cues.push({ timeSec: round2(outroStart), label: 'Início do Outro', confidence });

  return cues.slice(0, MAX_CUES);
}

function classifyMixingStyle(energy, p50, rangeDb, introEnd, outroStart, durationSec) {
  if (durationSec <= 0) {
    return { mixingStyle: 'hybrid', mixingStyleConfidence: 'low' };
  }

  const introRatio = introEnd / durationSec;
  const outroRatio = Math.max(0, durationSec - outroStart) / durationSec;
  const startEnergyDb = average(energy.slice(0, Math.max(1, Math.round(energy.length * 0.02))));
  const endEnergyDb = average(energy.slice(-Math.max(1, Math.round(energy.length * 0.02))));

  const lowThreshold = p50 - 0.2 * rangeDb;

  let mixingStyle;
  if (introRatio >= 0.12 && outroRatio >= 0.12 && startEnergyDb <= lowThreshold && endEnergyDb <= lowThreshold) {
    mixingStyle = 'classic';
  } else if (introRatio < 0.06 || startEnergyDb > p50) {
    mixingStyle = 'cut';
  } else {
    mixingStyle = 'hybrid';
  }

  const mixingStyleConfidence = (rangeDb < 6 || durationSec < MIN_DURATION_SEC)
    ? 'low'
    : confidenceFromRange(rangeDb);

  return { mixingStyle, mixingStyleConfidence };
}

function confidenceFromRange(rangeDb) {
  if (rangeDb < 6) return 'low';
  if (rangeDb < 14) return 'medium';
  return 'high';
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

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = clampIndex(Math.floor(p * (sortedValues.length - 1)), sortedValues.length);
  return sortedValues[idx];
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

function round2(value) {
  return Math.round(value * 100) / 100;
}
