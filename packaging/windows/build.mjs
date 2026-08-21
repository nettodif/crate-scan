#!/usr/bin/env node
// Builds the packaged Windows CrateScan.exe: downloads yt-dlp.exe + a static
// ffmpeg/ffprobe Windows build (same "no host install required" idea as the
// Dockerfile — just Windows binaries instead of apt/curl'd Linux ones),
// packages launcher.mjs (+ src/ + node_modules + public/) into a single exe
// via pkg, and copies the downloaded binaries next to it. Run manually or
// from CI when cutting a Windows release — this is not part of
// `npm install`/`npm start` and never runs for the normal dev/Docker path.
//
// Prerequisites: `npm install` (for the devDependencies below), internet
// access to GitHub releases. See packaging/windows/README.md.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import extractZip from 'extract-zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const binDir = path.join(__dirname, 'bin');
const distDir = path.join(repoRoot, 'dist');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
// BtbN's GitHub Actions builds: static, win64, no license-gated download page —
// same reasoning as picking yt-dlp's own GitHub releases directly.
const FFMPEG_ZIP_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';

async function downloadFile(url, destPath) {
  console.log(`Baixando ${url} ...`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Falha ao baixar ${url}: HTTP ${res.status}`);
  await fs.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

async function findFile(dir, fileName) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(entryPath, fileName);
      if (found) return found;
    } else if (entry.name === fileName) {
      return entryPath;
    }
  }
  return null;
}

async function ensureBinaries() {
  await fs.mkdir(binDir, { recursive: true });

  await downloadFile(YTDLP_URL, path.join(binDir, 'yt-dlp.exe'));

  const zipPath = path.join(binDir, '_ffmpeg.zip');
  await downloadFile(FFMPEG_ZIP_URL, zipPath);

  const extractDir = path.join(binDir, '_ffmpeg_extract');
  await fs.rm(extractDir, { recursive: true, force: true });
  console.log('Extraindo ffmpeg...');
  await extractZip(zipPath, { dir: extractDir });

  // The zip's top-level folder name embeds a build date/version, so locate
  // bin/ffmpeg.exe wherever it actually landed instead of hardcoding a path.
  const foundFfmpeg = await findFile(extractDir, 'ffmpeg.exe');
  if (!foundFfmpeg) throw new Error('ffmpeg.exe não encontrado dentro do zip baixado.');
  const sourceBinDir = path.dirname(foundFfmpeg);

  await fs.copyFile(path.join(sourceBinDir, 'ffmpeg.exe'), path.join(binDir, 'ffmpeg.exe'));
  await fs.copyFile(path.join(sourceBinDir, 'ffprobe.exe'), path.join(binDir, 'ffprobe.exe'));

  await fs.rm(zipPath, { force: true });
  await fs.rm(extractDir, { recursive: true, force: true });
}

function runPkg() {
  console.log('Empacotando com pkg...');
  const result = spawnSync(
    'npx',
    [
      '@yao-pkg/pkg',
      path.join(__dirname, 'launcher.mjs'),
      '--targets', 'node20-win-x64',
      '--output', path.join(distDir, 'CrateScan.exe'),
    ],
    { stdio: 'inherit', cwd: repoRoot, shell: true }
  );
  if (result.status !== 0) throw new Error('pkg falhou — veja a saída acima.');
}

async function copyBinariesToDist() {
  const distBinDir = path.join(distDir, 'bin');
  await fs.mkdir(distBinDir, { recursive: true });
  for (const name of ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe']) {
    await fs.copyFile(path.join(binDir, name), path.join(distBinDir, name));
  }
}

async function main() {
  await fs.mkdir(distDir, { recursive: true });
  await ensureBinaries();
  runPkg();
  await copyBinariesToDist();
  console.log(`\nPronto: ${path.join(distDir, 'CrateScan.exe')} + ${path.join(distDir, 'bin')}`);
  console.log('Próximo passo: iscc packaging/windows/installer.iss (ver README.md desta pasta).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
