FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

FROM node:20-bookworm-slim AS production

# Debian bookworm's apt package (5.1.9) has a real bug where ffmpeg hangs
# indefinitely finalizing a command that fans (asplit) into two output
# muxers (used by the /render/dub endpoint) - fixed upstream. Pull a pinned
# static build matching the ffmpeg 8.0 line instead of the distro package.
ARG FFMPEG_RELEASE_TAG=autobuild-2026-02-28-12-59
ARG FFMPEG_ASSET=ffmpeg-n8.0.1-66-g27b8d1a017-linux64-gpl-8.0.tar.xz
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl xz-utils ca-certificates \
    && curl -fL -o /tmp/ffmpeg.tar.xz \
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE_TAG}/${FFMPEG_ASSET}" \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /usr/local/bin --strip-components=2 --wildcards '*/bin/*' \
    && rm /tmp/ffmpeg.tar.xz \
    && apt-get purge -y --auto-remove curl xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -version && ffprobe -version

WORKDIR /app
ENV NODE_ENV=production

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY --from=build /app/dist ./dist

RUN mkdir -p tmp \
    && useradd --create-home --uid 1001 nodeapp \
    && chown -R nodeapp:nodeapp /app
USER nodeapp

EXPOSE 3002
CMD ["node", "dist/main.js"]
