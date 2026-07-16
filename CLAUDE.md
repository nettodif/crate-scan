# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CrateScan does audio-quality pre-analysis for YouTube / YouTube Music tracks (inspired by
rekordbox's track loading): downloads the native audio stream, reads technical metadata
(codec, bitrate, sample rate), renders a spectrogram, and runs an FFT-based heuristic to
estimate the real spectral cutoff — catching transcoded/upsampled tracks even when the
declared bitrate looks fine.

## Stack

- **Backend**: Node.js, plain JavaScript (ESM, `"type": "module"`), no TypeScript, no build
  step, no bundler. Express only for routing and serving static files.
- **Frontend**: plain HTML/CSS/JS in `public/`, no framework, no build step — served directly
  via `express.static`.
- No test suite, no linter configured in this repo.

External tool dependencies (must be on PATH, or pointed to via env vars — see below):
`yt-dlp` (download), `ffmpeg`/`ffprobe` (metadata, spectrogram, PCM decode).

## Commands

```bash
npm install     # install deps (express, fft.js, pdfkit)
npm start        # run the server (node src/server.js), default http://localhost:5178
```

There is no lint or test script. Verify changes by running the server and exercising the
relevant `/api/*` route (curl or the UI at `http://localhost:5178`).

Docker:
```bash
docker compose up --build       # image already bundles Node 20 + ffmpeg + yt-dlp, no host deps needed
```

Env vars that override tool locations/behavior (see `src/config.js`): `PORT`, `YTDLP_PATH`,
`FFMPEG_PATH`, `FFPROBE_PATH`, `COOKIES_DIR`, `YTDLP_COOKIES_FILE`.

## Architecture

Everything flows through `runAnalysis(url, { onProgress })` in
`src/services/analysisPipeline.js` — this is the single orchestration point shared by both
the blocking `POST /api/analyze` route and the SSE `GET /api/analyze/stream` route in
`src/server.js`, so both stay in sync. It emits stage events (`info_start`,
`download_start`, `download_progress`, `metadata_start`, `spectrogram_start`, `fft_start`,
`done`/`cached`) via a callback rather than returning progress separately.

Pipeline stages, each delegated to a dedicated service under `src/services/`:

1. **`ytDlpService.js`** — resolves video info, downloads the best native audio stream
   (no re-encoding), lists playlist entries (`--flat-playlist`), and handles cookie-based
   auth (see below). Shells out to `yt-dlp` via `processRunner.js`.
2. **`ffmpegService.js`** — reads metadata via `ffprobe` (codec, declared bitrate, sample
   rate), generates the spectrogram PNG (`ffmpeg showspectrumpic`), decodes to mono PCM for
   FFT input, and remuxes the downloaded audio into a download-friendly container without
   re-encoding.
3. **`spectrumAnalyzer.js`** — runs FFT (Hann-windowed, via `fft.js`) across ~60 points along
   the track, averages the spectrum in dB, and estimates the frequency where energy
   consistently drops off (the "cutoff"). This is the core heuristic: a low cutoff despite a
   high declared bitrate is the signal that a track was transcoded from a lossy source.

After the pipeline runs, `analysisPipeline.js` cross-checks the results and appends
human-readable `notes` when something looks off: declared-bitrate-vs-spectrum mismatch,
measured-bitrate-vs-source-format mismatch (re-encoded after original download), sample rate
below 44.1kHz, or an invalid/expired cookie having silently downgraded the download to
anonymous quality.

Supporting state (all in-memory or on local disk — **no database**):

- **`analysisCache.js`** — in-memory cache of analysis results keyed by `videoId`, TTL 1h.
  Cleared per-track or fully via `DELETE /api/cache/:videoId` / `DELETE /api/cache` — needed
  after changing cookies, since a stale cached result would otherwise outlive the change.
- **`downloadStore.js`** — keeps the downloaded (remuxed) audio file available on disk for
  `GET /api/download/:id`, same TTL window as the analysis cache.
- **`cookieStore.js`** — persists an uploaded `cookies.txt` (for YouTube Music Premium
  auth) under `config.cookiesDir`. Single file, no per-user isolation — the app is designed
  to run as one container per user, not multi-tenant.
- **`reportGenerator.js`** — builds CSV/PDF exports from client-supplied session results
  (`POST /api/report`); there is no server-side session storage, the client resends what it
  already has.
- **`processRunner.js`** — shared helper for spawning/awaiting external processes
  (`yt-dlp`/`ffmpeg`/`ffprobe`).

### Cookie-based authentication

Without cookies, `yt-dlp` downloads anonymously and YouTube caps quality (~128kbps). A valid
`cookies.txt` from a YouTube Music Premium session unlocks higher-bitrate formats. Two ways
in: upload via the UI (`POST /api/cookies`, validated immediately with a real `yt-dlp`
check before being accepted) or `YTDLP_COOKIES_FILE` env var. The uploaded-cookie path wins
if both are present. If a cookie has expired/rotated, the pipeline detects the download
silently falling back to anonymous quality and surfaces it as a note rather than failing
outright (`download.cookieInvalid` in `analysisPipeline.js`).

### Playlist handling

Two distinct flows, both listing entries via `yt-dlp --flat-playlist` (no download at listing
time):

- `GET /api/playlist/entries` — lists entries only, so the UI can let the user pick which
  tracks to analyze before anything downloads. This is the flow the current UI actually uses.
- `GET /api/analyze-playlist/stream` — lists *and* analyzes every entry sequentially over
  SSE, with per-track events prefixed `track_`. Exists as a standalone endpoint but isn't
  wired into the current UI flow.
