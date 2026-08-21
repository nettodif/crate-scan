# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CrateScan has two modes for a YouTube / YouTube Music / SoundCloud URL, picked via a
top-level tab in the UI:

- **Analisar**: audio-quality pre-analysis (inspired by rekordbox's track loading) —
  downloads the native audio stream, reads technical metadata (codec, bitrate, sample
  rate), renders a spectrogram, and runs an FFT-based heuristic to estimate the real
  spectral cutoff, catching transcoded/upsampled tracks even when the declared bitrate
  looks fine.
- **Baixar**: skips all of that and just downloads (track/album/playlist) in a
  user-chosen format (Opus / AAC native / AAC transcoded), saving straight into an
  organized local library — optional destination subfolder, an aggregating folder named
  after the playlist/album, and playlist-position numbering.

Also packageable as a standalone Windows `.exe` (see `packaging/windows/`) — same web UI,
no separate frontend.

## Stack

- **Backend**: Node.js, plain JavaScript (ESM, `"type": "module"`), no TypeScript, no build
  step, no bundler for normal dev. Express only for routing and serving static files.
- **Frontend**: plain HTML/CSS/JS in `public/`, no framework, no build step — served directly
  via `express.static`.
- No test suite, no linter configured in this repo.
- `packaging/windows/` is the one place a build step exists (`pkg`, opt-in via
  `npm run package:win`) — it never runs as part of `npm install`/`npm start` and doesn't
  affect the normal dev workflow.

External tool dependencies (must be on PATH, or pointed to via env vars — see below):
`yt-dlp` (download), `ffmpeg`/`ffprobe` (metadata, spectrogram, PCM decode, format
transcoding).

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

Windows packaging (opt-in, see `packaging/windows/README.md` for the full picture):
```bash
npm run package:win             # cross-builds dist/CrateScan.exe + dist/bin/*.exe, no Windows needed
```

Env vars that override tool locations/behavior (see `src/config.js`): `PORT`, `YTDLP_PATH`,
`FFMPEG_PATH`, `FFPROBE_PATH`, `COOKIES_DIR`, `LIBRARY_ROOT`, `SPECTROGRAM_DIR`,
`YTDLP_COOKIES_FILE`.

## Architecture

Two independent orchestration points, one per mode, both following the same
`fn(url, { onProgress, ... })` shape — emit stage events via a callback rather than
returning progress separately, so both the blocking and the SSE route for each mode can
share the exact same function and stay in sync:

- **`runAnalysis(url, { onProgress })`** in `src/services/analysisPipeline.js` — shared by
  `POST /api/analyze` and `GET /api/analyze/stream`. Stages: `info_start`, `download_start`,
  `download_progress`, `metadata_start`, `spectrogram_start`, `fft_start`, `done`/`cached`.
- **`runDownload(url, { onProgress, destination, format })`** in
  `src/services/downloadPipeline.js` — the "Baixar" mode's pipeline, used only by
  `GET /api/download-track/stream`. Deliberately lighter than `runAnalysis`: no ffprobe
  cross-checks, no spectrogram, no FFT. `format` (`'opus'` | `'aac_native'` |
  `'aac_transcoded'`, default `'opus'`) picks how the audio gets downloaded/produced;
  `destination` (`{ subfolder, fileNameBase }`) is always saved into the library via
  `libraryStore.js` — see "Download-only mode & library" below.

Services under `src/services/`, shared by both pipelines where noted:

1. **`ytDlpService.js`** — resolves video info, downloads audio (best native, or a
   codec-targeted format via `FORMAT_SELECTORS` — `opus`/`aac_native` yt-dlp format
   selectors, exported here and used by both pipelines), lists playlist entries
   (`--flat-playlist`, also returns the playlist's own title via
   `fetchPlaylistEntriesAsync` → `{ entries, playlistTitle }`), and handles cookie-based
   auth (see below). Shells out to `yt-dlp` via `processRunner.js`.
2. **`ffmpegService.js`** — reads metadata via `ffprobe` (codec, declared bitrate, sample
   rate), generates the spectrogram PNG (`ffmpeg showspectrumpic`, written to
   `config.spectrogramDir` — kept in `config.js` rather than computed from `__dirname` so
   it can point outside the app's own directory tree, needed for the packaged Windows
   build's read-only snapshot), decodes to mono PCM for FFT input, remuxes downloaded audio
   into a download-friendly container without re-encoding
   (`remuxForDownloadAsync`), and does the one real transcode in the codebase
   (`transcodeToAacAsync`, used by the analysis pipeline's AAC-transcoded variant and by
   `downloadPipeline.js`'s `format: 'aac_transcoded'`).
3. **`spectrumAnalyzer.js`** — runs FFT (Hann-windowed, via `fft.js`) across ~60 points along
   the track, averages the spectrum in dB, and estimates the frequency where energy
   consistently drops off (the "cutoff"). This is the core heuristic: a low cutoff despite a
   high declared bitrate is the signal that a track was transcoded from a lossy source.
   Analysis-only — `downloadPipeline.js` never runs this.

After `runAnalysis` runs, `analysisPipeline.js` cross-checks the results and appends
human-readable `notes` when something looks off: declared-bitrate-vs-spectrum mismatch,
measured-bitrate-vs-source-format mismatch (re-encoded after original download), sample rate
below 44.1kHz, or an invalid/expired cookie having silently downgraded the download to
anonymous quality.

Supporting state (all in-memory or on local disk — **no database**):

- **`analysisCache.js`** — in-memory cache of analysis results keyed by `videoId`, TTL 1h.
  Cleared per-track or fully via `DELETE /api/cache/:videoId` / `DELETE /api/cache` — needed
  after changing cookies, since a stale cached result would otherwise outlive the change.
  Only `runAnalysis` uses this — `runDownload` never caches.
- **`downloadStore.js`** — keeps a downloaded (remuxed/transcoded) audio file available on
  disk for `GET /api/download/:videoId/:variantId`, same TTL window as the analysis cache.
  Both pipelines use it: `analysisPipeline.js` keys by variant id (`native`/`aac_native`/
  `aac_transcoded`), `downloadPipeline.js` always uses `'download'` so a "Baixar" run on a
  video that was already analyzed never collides with that analysis's stored variants.
- **`libraryStore.js`** — only used by `downloadPipeline.js`. Copies (never moves —
  `fs.copyFile`, not `fs.rename`, since the source temp dir and a Docker-mounted
  `LIBRARY_ROOT` can be different filesystems/devices) the final downloaded file into
  `config.libraryRoot`, constrained there regardless of what subfolder string the client
  sends: each path segment is sanitized and empty/`.`/`..` segments are dropped, then
  `path.relative` double-checks the joined path never escaped the root. The original temp
  file is left alone in `downloadStore` afterward, so the manual re-download link still
  works alongside the library copy.
- **`cookieStore.js`** — persists an uploaded `cookies.txt` (for YouTube Music Premium
  auth) under `config.cookiesDir`. Single file, no per-user isolation — the app is designed
  to run as one container/instance per user, not multi-tenant.
- **`reportGenerator.js`** — builds CSV/PDF exports from client-supplied session results
  (`POST /api/report`); there is no server-side session storage, the client resends what it
  already has. Analysis-only — nothing from `downloadPipeline.js` feeds into reports.
- **`processRunner.js`** — shared helper for spawning/awaiting external processes
  (`yt-dlp`/`ffmpeg`/`ffprobe`).

### Download-only mode & library organization

The "Baixar" tab (`public/app.js`'s `downloadMode`) is a parallel, lighter-weight flow to
"Analisar": paste a track/album/playlist URL, pick a format, and it downloads straight into
`config.libraryRoot` (env `LIBRARY_ROOT`, same `process.cwd()`-relative-default pattern as
`cookiesDir`). Per-batch options set once and applied to every track downloaded in that
action: destination subfolder (free text, sanitized server-side), an "aggregating folder"
toggle (subfolder named after the playlist/album title, from `playlistTitle`), a
"number tracks" toggle (`01 - `, `02 - ` prefix from playlist position), and the format
selector (`opus`/`aac_native`/`aac_transcoded`). `opus`/`aac_native` are best-effort — if
yt-dlp doesn't offer that codec for a given video, `runDownload` throws a `422` with a
clear message instead of silently falling back to a different format, since the user
picked one explicitly.

### Windows packaging

`packaging/windows/` builds a standalone `CrateScan.exe` (via `pkg`/`@yao-pkg/pkg`) that
bundles `yt-dlp.exe`/`ffmpeg.exe`/`ffprobe.exe` and needs nothing installed on the target
machine. `launcher.mjs` is the packaged entry point — it only sets env var defaults
(pointing `COOKIES_DIR`/`LIBRARY_ROOT`/`SPECTROGRAM_DIR` at `%APPDATA%`/Documents and the
tool paths at the binaries bundled next to the `.exe`, only when not already set) before
importing `src/server.js` unchanged, then opens the default browser. `build.mjs` downloads
the Windows binaries and runs `pkg`; `installer.iss` (Inno Setup) produces a per-user
installer (no admin/UAC). None of this touches `src/`'s behavior for the normal
`npm start`/Docker path — see `packaging/windows/README.md` for the full build/CI story
(including `packaging/windows/build.Dockerfile` and `.github/workflows/build-windows.yml`,
which cross-build the `.exe` without needing an actual Windows machine).

### Cookie-based authentication

Without cookies, `yt-dlp` downloads anonymously and YouTube caps quality (~128kbps). A valid
`cookies.txt` from a YouTube Music Premium session unlocks higher-bitrate formats. Two ways
in: upload via the UI (`POST /api/cookies`, validated immediately with a real `yt-dlp`
check before being accepted) or `YTDLP_COOKIES_FILE` env var. The uploaded-cookie path wins
if both are present. If a cookie has expired/rotated, both pipelines detect the download
silently falling back to anonymous quality (`download.cookieInvalid`) — `analysisPipeline.js`
surfaces it as a `notes` entry, `downloadPipeline.js` returns it as a `cookieInvalid` field
on the SSE `done` payload.

Authenticated requests also need `--js-runtimes`/`--remote-components ejs:github`
(`JS_RUNTIME_ARGS` in `ytDlpService.js`) so yt-dlp can solve YouTube's "n" challenge —
`describeYtDlpFailure` there detects network-failure patterns in yt-dlp's stderr
(`NETWORK_FAILURE_RE`) and surfaces a diagnostic hint when they show up on an authenticated
request, since that's the likely shape of "cookie upload works, real download fails" when
running in Docker (see `README.md`'s troubleshooting section for the full story — it's a
documented mitigation, not a confirmed fix).

### Playlist handling

Two distinct flows, both listing entries via `yt-dlp --flat-playlist` (no download at listing
time), sharing `fetchPlaylistEntriesAsync` in `ytDlpService.js` (returns
`{ entries, playlistTitle }` — `playlistTitle` is null for a plain video URL, used by the
"Baixar" mode's aggregating-folder option):

- `GET /api/playlist/entries` — lists entries only, so the UI can let the user pick which
  tracks to analyze/download before anything downloads. Used by both the "Analisar" and
  "Baixar" tabs.
- `GET /api/analyze-playlist/stream` — lists *and* analyzes every entry sequentially over
  SSE, with per-track events prefixed `track_`. Exists as a standalone endpoint but isn't
  wired into the current UI flow (neither mode uses it — both do their own list-then-loop
  client-side instead).
