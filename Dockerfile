FROM node:20-slim

# ffmpeg (transcoding/analysis) + curl (fetch static yt-dlp binary), no python needed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  # Best-effort warm-up: an authenticated download needs yt-dlp to fetch its
  # EJS challenge-solver component from GitHub the first time it resolves a
  # real media URL (see JS_RUNTIME_ARGS in ytDlpService.js) — pre-fetch it now,
  # while network access is already guaranteed for the curl above, instead of
  # leaving that as the very first thing a real user download depends on.
  # `|| true`: never fail the image build over this — if yt-dlp doesn't cache
  # it here (e.g. the fetch is gated behind an authenticated request that
  # can't happen at build time), the app still works exactly as before.
  && (yt-dlp --js-runtimes node:"$(which node)" --remote-components ejs:github \
      --simulate --skip-download https://www.youtube.com/watch?v=jNQXAC9IVRw || true) \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=5178
EXPOSE 5178

CMD ["node", "src/server.js"]
