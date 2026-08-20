import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

function sanitizeSegment(name) {
  return (name || '').replace(/[\\/:*?"<>|]+/g, '_').trim();
}

/**
 * Turns a user-supplied (possibly nested) subfolder string into an absolute
 * path guaranteed to stay inside config.libraryRoot: each path segment is
 * sanitized independently and any '.'/'..'/empty segment is dropped, then
 * path.relative() double-checks the joined result never escapes the root —
 * defense in depth in case a segment slips through sanitization untouched.
 */
function resolveLibraryTargetDir(subfolder) {
  const segments = (subfolder || '')
    .split(/[\\/]/)
    .map(sanitizeSegment)
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');

  const targetDir = path.join(config.libraryRoot, ...segments);
  const relative = path.relative(config.libraryRoot, targetDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Subpasta de destino inválida.');
  }
  return targetDir;
}

/**
 * Copies (not moves) the downloaded file into the organized library, so the
 * source in the yt-dlp temp dir stays intact for downloadStore's TTL-managed
 * manual-download link. Uses fs.copyFile rather than fs.rename because the
 * temp dir and a Docker-mounted library volume can be different
 * filesystems/devices, which would make rename fail with EXDEV. Overwrites
 * an existing file at the target path — no versioning/collision handling.
 */
export async function saveToLibraryAsync(sourceFilePath, subfolder, fileNameBase, ext) {
  const targetDir = resolveLibraryTargetDir(subfolder);
  await fs.mkdir(targetDir, { recursive: true });

  const safeBase = sanitizeSegment(fileNameBase).slice(0, 150) || 'faixa';
  const targetPath = path.join(targetDir, `${safeBase}.${ext}`);

  await fs.copyFile(sourceFilePath, targetPath);
  return targetPath;
}
