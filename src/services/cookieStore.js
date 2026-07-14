import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const cookiesPath = path.join(config.cookiesDir, 'cookies.txt');

// Docker distribution runs one container per user, so a single file (no
// per-session isolation) is safe — this instance only ever serves one person.
let hasCookies = existsSync(cookiesPath);

export async function save(content) {
  await fs.mkdir(config.cookiesDir, { recursive: true });
  await fs.writeFile(cookiesPath, content, 'utf8');
  hasCookies = true;
}

export function getPath() {
  return hasCookies ? cookiesPath : null;
}

export async function clear() {
  hasCookies = false;
  await fs.rm(cookiesPath, { force: true });
}
