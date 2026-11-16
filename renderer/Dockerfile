# Renderer image (SPEC §2, §6.4, §13). Build from the repo root:
#   docker buildx build --platform linux/amd64 -f renderer/Dockerfile .
# Nothing is installed at boot: Chromium, fonts, ffmpeg (NVENC + x264), styles and the Kokoro TTS weights
# are all baked in. Runs as a non-root user.

# -base (not -runtime): nothing here links CUDA libraries. ffmpeg's NVENC dlopens libcuda/libnvidia-encode, which
# the NVIDIA container toolkit mounts from the host driver; onnxruntime runs on CPU. -runtime added ~3 GB of
# cuBLAS/cuFFT/NPP. The base image still sets NVIDIA_VISIBLE_DEVICES/NVIDIA_REQUIRE_CUDA like -runtime did.
ARG CUDA_IMAGE=nvidia/cuda:12.6.3-base-ubuntu22.04
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
    NVIDIA_VISIBLE_DEVICES=all \
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
# CUDA EP skipped (TTS is device:'cpu'); the onnxruntime binaries for other OSes/arches are dropped.
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v3/darwin node_modules/onnxruntime-node/bin/napi-v3/win32 \
      node_modules/onnxruntime-node/bin/napi-v3/linux/arm64 \
 && npm cache clean --force

# ---- stage marker: Chromium (+ its system libraries), version pinned by the playwright package
# --only-shell: chromium.launch() is headless, which uses chromium-headless-shell; the full browser was unused.
RUN npx playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /root/.npm /usr/share/doc/*

# ---- stage marker: code, styles, bench plan
COPY packages/contract /app/packages/contract
COPY bench /app/bench
COPY renderer/agent ./agent
COPY renderer/engine ./engine
COPY renderer/styles ./styles

# ---- stage marker: blockworld score (kit audio.py: python3 + numpy/scipy, bundled instrument samples)
# Samples (CC BY 3.0 Salamander/FluidR3, CC0 VSCO2; see renderer/audio/blockworld/CREDITS.txt) come from a pinned,
# sha256-checked tarball. Left empty, the image has no samples and blockworld jobs fail at the score step.
ARG BLOCKWORLD_SAMPLES_URL=
ARG BLOCKWORLD_SAMPLES_SHA256=f23f285f4187b56f2d17dcdb6160277747242664c8e755e00e51a245f2cd7e2a
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
 && pip3 install --no-cache-dir numpy==2.2.6 scipy==1.15.3 \
 && apt-get purge -y python3-pip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* /root/.cache
COPY renderer/audio ./audio
RUN if [ -n "$BLOCKWORLD_SAMPLES_URL" ]; then \
      curl -fsSL "$BLOCKWORLD_SAMPLES_URL" -o /tmp/s.tgz && echo "$BLOCKWORLD_SAMPLES_SHA256  /tmp/s.tgz" | sha256sum -c - \
      && rm -rf audio/blockworld/assets && mkdir -p audio/blockworld/assets && tar -xzf /tmp/s.tgz -C audio/blockworld/assets && rm /tmp/s.tgz \
      && python3 -c "import numpy, scipy" ; \
    else echo "WARNING: no BLOCKWORLD_SAMPLES_URL: blockworld scoring unavailable in this image"; fi

# ---- stage marker: TTS model (Kokoro-82M, downloaded once at build, offline at run time)
# --input-type=module: plain `node -e` defines a global __dirname (".") that makes kokoro-js look for its
# bundled voices relative to the cwd instead of its own package.
RUN TTS_ALLOW_DOWNLOAD=1 node --input-type=module -e "const m = await import('./engine/voice.ts'); await m.tts('Video Factory is ready.', '/tmp/tts-warmup.wav')" \
 && rm -f /tmp/tts-warmup*.wav

RUN useradd --create-home --uid 10001 vf && chown -R vf /app /opt/tts
USER vf
ENTRYPOINT ["node", "/app/renderer/agent/main.ts"]
