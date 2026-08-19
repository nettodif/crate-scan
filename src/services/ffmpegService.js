import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { runAndCaptureBytesAsync, runAsync } from './processRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', '..', 'public');
const spectrogramDir = path.join(publicDir, 'spectrograms');

// yt-dlp's "bestaudio" often lands on an Opus stream muxed into a .webm container
// (itag 251) — bit-for-bit fine for analysis, but an awkward extension for a user to
// download and open. Remux (stream copy, no re-encode) into a container extension that
// matches the codec, so the downloaded file plays anywhere without touching quality.
const CODEC_TO_CONTAINER_EXT = {
  opus: 'opus',
  vorbis: 'ogg',
  aac: 'm4a',
  mp3: 'mp3',
  flac: 'flac',
};

export async function remuxForDownloadAsync(filePath, codecName) {
  const targetExt = CODEC_TO_CONTAINER_EXT[codecName];
  const currentExt = path.extname(filePath).slice(1).toLowerCase();
  if (!targetExt || targetExt === currentExt) return filePath;

  const outputPath = filePath.slice(0, -currentExt.length) + targetExt;
  const args = ['-y', '-i', filePath, '-vn', '-acodec', 'copy', outputPath];

  const result = await runAsync(config.ffmpegPath, args);
  try {
    await fs.access(outputPath);
  } catch {
    console.error(`Remux para download falhou, mantendo arquivo original: ${result.stdErr}`);
    return filePath;
  }
  return outputPath;
}

/**
 * Real transcode (decode + re-encode), not the stream-copy remux above — used
 * to produce an AAC reference variant from a source codec (e.g. Opus) that
 * has no lossless path into an AAC/m4a container. Uses ffmpeg's built-in aac
 * encoder rather than libfdk_aac, which isn't guaranteed present in the
 * Docker image's ffmpeg build. outputDir must be a dedicated temp dir (never
 * the source file's own jobDir) so this variant's lifecycle in downloadStore
 * stays independent of the source variant's.
 */
export async function transcodeToAacAsync(filePath, outputDir, { bitrateKbps = 256 } = {}) {
  const baseName = path.parse(filePath).name;
  const outputPath = path.join(outputDir, `${baseName}.m4a`);
  const args = ['-y', '-i', filePath, '-vn', '-acodec', 'aac', '-b:a', `${bitrateKbps}k`, outputPath];

  const result = await runAsync(config.ffmpegPath, args);
  try {
    await fs.access(outputPath);
  } catch {
    throw new Error(`ffmpeg falhou ao transcodificar para AAC: ${result.stdErr}`);
  }
  return outputPath;
}

export async function getMetadataAsync(filePath) {
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];

  const result = await runAsync(config.ffprobePath, args);
  if (result.exitCode !== 0) {
    throw new Error(`ffprobe falhou (código ${result.exitCode}): ${result.stdErr}`);
  }

  const probe = JSON.parse(result.stdOut);
  const format = probe.format ?? {};
  const formatBitrate = format.bit_rate !== undefined ? Number(format.bit_rate) : null;
  const duration = format.duration !== undefined ? Number(format.duration) : 0;
  const containerFormat = format.format_name ?? 'desconhecido';

  const audioStream = (probe.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!audioStream) {
    throw new Error('Nenhuma faixa de áudio encontrada no arquivo baixado.');
  }

  const codecName = audioStream.codec_name ?? 'desconhecido';
  const sampleRateHz = audioStream.sample_rate !== undefined ? parseInt(audioStream.sample_rate, 10) : 44100;
  const channels = audioStream.channels ?? 2;
  const streamBitrate = audioStream.bit_rate !== undefined ? Number(audioStream.bit_rate) : null;

  return {
    codecName,
    containerFormat,
    sampleRateHz: Number.isFinite(sampleRateHz) ? sampleRateHz : 44100,
    channels,
    declaredBitrateBps: streamBitrate ?? formatBitrate,
    durationSec: duration,
  };
}

/**
 * Renders a spectrogram PNG (frequency vs time, intensity = energy) using ffmpeg's showspectrumpic filter.
 * legend=0 keeps the image as pure spectrogram data (no native ffmpeg axis) — the
 * frontend draws its own axis/cutoff overlay on top, since it knows the exact
 * cutoffHz our own analysis computed (something ffmpeg's legend can't show).
 * Returns a web-relative URL (served from public/spectrograms).
 */
export async function generateSpectrogramAsync(filePath, id) {
  await fs.mkdir(spectrogramDir, { recursive: true });

  const fileName = `${id}_${randomUUID().replace(/-/g, '')}.png`;
  const outputPath = path.join(spectrogramDir, fileName);

  const args = [
    '-y',
    '-i', filePath,
    '-lavfi', 'showspectrumpic=s=1200x600:mode=combined:color=intensity:scale=log:legend=0',
    '-frames:v', '1',
    outputPath,
  ];

  const result = await runAsync(config.ffmpegPath, args);
  try {
    await fs.access(outputPath);
  } catch {
    throw new Error(`ffmpeg falhou ao gerar espectrograma: ${result.stdErr}`);
  }

  return `/spectrograms/${fileName}`;
}

/**
 * Decodes the audio to raw mono 32-bit float PCM at its native sample rate, for FFT analysis.
 */
export async function decodeToMonoPcmAsync(filePath, sampleRate) {
  const args = [
    '-v', 'error',
    '-i', filePath,
    '-ac', '1',
    '-ar', String(sampleRate),
    '-f', 'f32le',
    '-acodec', 'pcm_f32le',
    'pipe:1',
  ];

  const bytes = await runAndCaptureBytesAsync(config.ffmpegPath, args);

  // Buffer.concat's result isn't guaranteed to be 4-byte aligned within its
  // underlying ArrayBuffer, so a direct Float32Array view can throw. DataView
  // has no alignment requirement, so read through it instead.
  const floatCount = bytes.length >> 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const samples = new Float32Array(floatCount);
  for (let i = 0; i < floatCount; i++) {
    samples[i] = view.getFloat32(i * 4, true);
  }
  return samples;
}
