import path from 'node:path';

export const config = {
  cookiesDir: process.env.COOKIES_DIR || path.join(process.cwd(), 'data', 'auth'),
  libraryRoot: process.env.LIBRARY_ROOT || path.join(process.cwd(), 'data', 'library'),
  ytDlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  port: Number(process.env.PORT) || 5178,
  ytDlpCookiesFile: process.env.YTDLP_COOKIES_FILE || null,
};
