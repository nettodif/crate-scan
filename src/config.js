export const config = {
  ytDlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  port: Number(process.env.PORT) || 5178,
  ytDlpCookiesFile: process.env.YTDLP_COOKIES_FILE || null,
  ytDlpCookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || null,
};
