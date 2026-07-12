import { spawn } from 'node:child_process';

/**
 * Runs a process to completion and returns its stdout/stderr as text.
 */
export function runAsync(fileName, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(fileName, args, { signal });
    } catch (err) {
      reject(wrapSpawnError(fileName, err));
      return;
    }

    let stdOut = '';
    let stdErr = '';

    child.stdout.on('data', (chunk) => { stdOut += chunk; });
    child.stderr.on('data', (chunk) => { stdErr += chunk; });

    child.on('error', (err) => reject(wrapSpawnError(fileName, err)));
    child.on('close', (exitCode) => resolve({ exitCode, stdOut, stdErr }));
  });
}

/**
 * Runs a process and returns its raw stdout bytes (used for piping raw PCM audio from ffmpeg).
 */
export function runAndCaptureBytesAsync(fileName, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(fileName, args, { signal });
    } catch (err) {
      reject(wrapSpawnError(fileName, err));
      return;
    }

    const chunks = [];
    let stdErr = '';

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stdErr += chunk; });

    child.on('error', (err) => reject(wrapSpawnError(fileName, err)));
    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`'${fileName}' terminou com código ${exitCode}. Stderr: ${stdErr}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function wrapSpawnError(fileName, err) {
  if (err.code === 'ENOENT') {
    return new Error(
      `Não foi possível executar '${fileName}'. Verifique se está instalado e disponível no PATH. Detalhe: ${err.message}`
    );
  }
  return err;
}
