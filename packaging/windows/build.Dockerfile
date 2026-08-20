# Cross-builds the Windows CrateScan.exe (+ downloads its bundled yt-dlp/
# ffmpeg/ffprobe binaries) without needing an actual Windows machine — pkg
# just injects a prebuilt Windows Node binary into a pure-JS app snapshot,
# no native compilation involved. Does NOT produce the Inno Setup installer
# (iscc has no official Linux build) — that step still needs Windows, see
# .github/workflows/build-windows.yml or packaging/windows/README.md.
#
# Usage (from the repo root):
#   docker build -f packaging/windows/build.Dockerfile -t cratescan-winbuild .
#   docker run --rm -v "$(pwd)/dist:/app/dist" cratescan-winbuild
#
# Produces dist/CrateScan.exe + dist/bin/*.exe on the host — a working
# "portable" build (zip the two together) even without the installer step.
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY public ./public
COPY packaging ./packaging

CMD ["npm", "run", "package:win"]
