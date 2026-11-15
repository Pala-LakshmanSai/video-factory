# Renderer image (SPEC §2, §6.4, §13). Build from the repo root:
#   docker buildx build --platform linux/amd64 -f renderer/Dockerfile .
# Nothing is installed at boot: Chromium, fonts, ffmpeg (NVENC + x264), styles and the Kokoro TTS weights
# are all baked in. Runs as a non-root user.

ARG CUDA_IMAGE=nvidia/cuda:12.6.3-runtime-ubuntu22.04
ARG NODE_VERSION=22.20.0
# BtbN static GPL build: has both h264_nvenc and libx264. Pinned to a month-end autobuild (BtbN keeps those;
# daily ones get pruned). To bump: gh release list -R BtbN/FFmpeg-Builds, pick an autobuild-YYYY-MM-last-day tag.
ARG FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/ffmpeg-n8.1.3-27-g8dca1586f4-linux64-gpl-8.1.tar.xz

# ---- stage: ffmpeg
FROM ubuntu:22.04 AS ffmpeg
ARG FFMPEG_URL
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "$FFMPEG_URL" -o /tmp/ff.tar.xz && mkdir /ff && tar -xJf /tmp/ff.tar.xz -C /ff --strip-components=1 \
 && /ff/bin/ffmpeg -hide_banner -encoders > /tmp/enc.txt \
 && grep -q ' h264_nvenc ' /tmp/enc.txt && grep -q ' libx264 ' /tmp/enc.txt \
 || (echo "ffmpeg build lacks h264_nvenc or libx264" && exit 1)

# ---- stage: node
FROM ubuntu:22.04 AS node
ARG NODE_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /opt \
 && mv /opt/node-v${NODE_VERSION}-linux-x64 /opt/node

# ---- final
FROM ${CUDA_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/node/bin:$PATH \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,video \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    TTS_CACHE=/opt/tts \
    WORK_DIR=/tmp \
    NODE_ENV=production
COPY --from=node /opt/node /opt/node
COPY --from=ffmpeg /ff/bin/ffmpeg /ff/bin/ffprobe /usr/local/bin/

# ---- stage marker: fonts (Inter, Noto Serif, Noto Sans CJK, Noto Color Emoji, Bebas Neue)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl fontconfig \
      fonts-inter fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
 && mkdir -p /usr/share/fonts/truetype/bebas \
 && curl -fsSL https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf -o /usr/share/fonts/truetype/bebas/BebasNeue-Regular.ttf \
 && fc-cache -f && rm -rf /var/lib/apt/lists/*

WORKDIR /app/renderer
COPY renderer/package.json renderer/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- stage marker: Chromium (+ its system libraries), version pinned by the playwright package
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*

# ---- stage marker: code, styles, bench plan
COPY packages/contract /app/packages/contract
COPY bench /app/bench
COPY renderer/agent ./agent
COPY renderer/engine ./engine
COPY renderer/styles ./styles

# ---- stage marker: TTS model (Kokoro-82M, downloaded once at build, offline at run time)
# --input-type=module: plain `node -e` defines a global __dirname (".") that makes kokoro-js look for its
# bundled voices relative to the cwd instead of its own package.
RUN TTS_ALLOW_DOWNLOAD=1 node --input-type=module -e "const m = await import('./engine/voice.ts'); await m.tts('Video Factory is ready.', '/tmp/tts-warmup.wav')" \
 && rm -f /tmp/tts-warmup*.wav

RUN useradd --create-home --uid 10001 vf && chown -R vf /app /opt/tts
USER vf
ENTRYPOINT ["node", "/app/renderer/agent/main.ts"]
