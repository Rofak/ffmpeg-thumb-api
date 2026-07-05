# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small NestJS API that generates video thumbnails using `ffmpeg` and uploads them to Contabo Object Storage (S3-compatible). Runs on port 3002. It also has a `RenderModule` that merges/dubs video+audio and extracts audio via `ffmpeg`, queuing the work through BullMQ/Redis.

## Commands

```bash
yarn start:dev      # run with hot reload
yarn build           # compile to dist/ (nest build)
yarn start:prod       # run compiled dist/main.js
yarn lint             # eslint --fix over src/apps/libs/test
yarn format            # prettier --write src/ and test/
yarn test              # jest unit tests (rootDir: src, matches *.spec.ts)
yarn test:e2e            # jest using test/jest-e2e.json
yarn test:cov              # jest with coverage
```

There are currently no `*.spec.ts` files under `src/`, so `yarn test` has nothing to run — the jest config is preconfigured for when tests are added. `test/app.e2e-spec.ts` is the only existing test.

`ffmpeg` must be installed and on `PATH` — the service shells out to the `ffmpeg` binary directly (`child_process.exec`/`spawn`), there is no bundled binary.

A local Redis instance must be reachable (`REDIS_HOST`/`REDIS_PORT`) for `RenderModule` to boot — BullMQ connects to it eagerly via `BullModule.forRootAsync`, so the app won't start without Redis available.

## Architecture

- `AppModule` wires together `ThumbnailModule`, `RenderModule`, `ScheduleTaskModule`, `ConfigModule` (reads `.env` via `@nestjs/config`), and `ScheduleModule` (nestjs cron support, currently unused — see below).
- `ThumbnailController` (`src/thumbnail/thumbnail.controller.ts`) exposes:
  - `GET /thumbnail/:userId?url=<videoUrl>` — pulls 3 frames (at t=0,1,2s) from a remote video URL via `ffmpeg -ss ... -i <url>`, uploads each to S3, returns their public URIs.
  - `POST /thumbnail/upload/:userId` (multipart `file` field) — writes the uploaded buffer to a temp `.mp4`, extracts 3 frames via `ffmpeg`, uploads to S3, cleans up temp files.
  - `DELETE /thumbnail/cleanup` — sweeps the whole `thumbnails/` prefix in the bucket and deletes any object older than 1 hour (hardcoded in `clearOldThumbnails`).
  - `DELETE /thumbnail/:userId` — deletes all objects under `thumbnails/<userId>/`.
- `ThumbnailService` (`src/thumbnail/thumbnail.service.ts`) does all the ffmpeg + S3 work. It always writes intermediate frames to the local `tmp/` directory (created on demand) before uploading, then deletes the local file — `tmp/` should stay empty between requests but check it if disk usage grows.
- S3 objects are keyed as `thumbnails/<userId>/<uuid>.jpg`, uploaded with `ACL: public-read`, and returned to callers as `${CONTABO_BASE_URL}/<key>`.
- `ScheduleTaskService` (`src/schedule-task/schedule-task.service.ts`) is meant to run `ThumbnailService.clearOldThumbnails()` on a cron schedule via `@nestjs/schedule`, but the `@Cron` handler is currently commented out — cleanup is only triggered manually via the `DELETE /thumbnail/cleanup` endpoint.
- `RenderModule` merges a video + audio track into one `.mp4` via `ffmpeg -c:v copy -c:a aac` (video stream is never re-encoded) and uploads the result to the `_V2` Contabo bucket. Work is queued through BullMQ instead of running inline on the request:
  - `POST /render/url/:userId` (`{ videoUrl, audioUrl }` body) and `POST /render/:userId` (multipart `video`/`audio` fields) both enqueue a job on the `render` queue and return `{ jobId }` immediately — they do not wait for the render to finish.
  - For the URL flow, `RenderService.renderFromUrls` downloads both inputs to `tmp/` **in parallel via axios** before invoking ffmpeg — ffmpeg never receives a remote URL directly (that would serialize/slow the fetch inside the ffmpeg process itself).
  - `GET /render/status/:jobId` returns `{ jobId, state, progress, result, failedReason }`. `state` is a BullMQ job state (`waiting`/`active`/`completed`/`failed`/...). `progress` is 0-100, derived from real ffmpeg `time=`/`Duration` parsing in `RenderService.runFFmpeg` (mapped into the 10-95 range) plus coarse markers for download (5) and upload-complete (100) — see `render.service.ts`. `result` is the `{ uri }` payload once `state` is `completed`.
  - `GET /render/concurrency` reports capacity and live load: `{ cpuCount, renderConcurrencyEnv, effectiveConcurrency, active, waiting, delayed, remainingConcurrency }`, using `renderQueue.getJobCounts()`.
  - `DELETE /render/:userId` still runs synchronously (it's just an S3 list+delete, no ffmpeg work).
  - `RenderProcessor` (`src/render/render.processor.ts`) is the BullMQ worker that actually calls `RenderService`; its concurrency comes from `src/render/render-concurrency.ts` (`RENDER_CONCURRENCY` env var, else `os.cpus().length`) — this is the main throughput knob for making renders "faster" under load, since ffmpeg itself already avoids re-encoding video. The processor also forwards a `job.updateProgress` callback into `RenderService` so status polling reflects live progress.
  - Every job on the `render` queue defaults to `removeOnComplete: 100, removeOnFail: 50` (`render.module.ts`), so Redis only keeps the most recent 100 completed / 50 failed job records instead of growing unbounded.
  - `@bull-board/nestjs` mounts a queue dashboard at `GET /queues` (wired in `render.module.ts` via `BullBoardModule.forRoot`/`forFeature`) — shows live job counts/state/data and lets you retry or remove jobs by hand.
  - For the upload flow, `RenderController` writes the multipart buffers to `tmp/` synchronously via `RenderService.persistUploadedFiles` before enqueueing (job payloads go through Redis as JSON, so raw buffers can't be queued directly) — the worker consumes those paths and deletes them when done.
  - `POST /render/dub/:userId` (`{ originVideoUrl, segments: [{ audio (base64), start, end }] }`) queues a dubbing render via `RenderService.renderDubbedVideo`: each segment's base64 audio is decoded to `tmp/` synchronously in the controller (`persistDubSegments`), then the worker downloads `originVideoUrl`, probes each segment's real duration with `ffprobe` (`getDuration`), time-stretches it to fit its `end - start` window via `buildAtempoChain` (matches the reference Python behavior: tempo <= 0 or < 1.0 both force `atempo=1.0` — no slow-down, speed-up only — and speed-up is capped at `1.80`), positions it with `adelay`, and mixes all segments over a silence bed (`anullsrc`+`apad`) with `amix`. This runs as **two sequential ffmpeg calls**, not one: first the mix is encoded to the standalone dubbed-audio file alone (bounded to the video's duration via `-t`, since the silence bed pads indefinitely), then a second, filter-free call remuxes the original video with that audio (`-c:v copy -c:a copy`). Deliberately not a single command fanning the mix to two outputs via `asplit` — some ffmpeg builds (confirmed: Debian bookworm's packaged 5.1.9) hang indefinitely finalizing two simultaneous muxers fed from one filtergraph; splitting into two invocations sidesteps that class of bug entirely regardless of ffmpeg version. A third ffmpeg call then grabs a single frame from the dubbed video as a thumbnail (`-frames:v 1`). Returns `{ videoUri, audioUri, thumbnailUri }` (all three uploaded to the `_V2` bucket) as the job's `result`. Job payloads only ever carry the decoded segment file *paths*, never the raw base64 — the audio bytes never touch Redis.
  - `RenderService.uploadFileToS3` sets `Content-Disposition` on every upload: `attachment` by default (forces a download instead of inline playback for video/audio), overridden to `inline` for the dub thumbnail image specifically (so it displays directly, e.g. in an `<img>` tag).
  - `POST /render/audio/:userId` (`{ videoUrl, bitrateKbps? }`) queues an audio-extraction job via `RenderService.extractAudioFromUrl`: downloads the video, strips the video stream (`-vn`) and re-encodes the audio to MP3 (`libmp3lame`, default 128kbps, 44.1kHz stereo) — this both drops the video payload and re-compresses the audio at a controlled bitrate, so output is reliably much smaller than the source. Returns `{ uri }` as the job's `result`.
  - CORS in `src/main.ts` only allows `GET, DELETE`, so like the thumbnail upload endpoint, all `POST /render/...` endpoints are not reachable cross-origin from a browser under the current config; only the `GET /render/...` endpoints are.
  - Swagger docs are served at `GET /docs` (`src/main.ts`), covering both `ThumbnailController` and `RenderController`.
  - `GET /docs` and `GET /queues` are both gated behind the same HTTP basic-auth credentials (`src/main.ts`, via `express-basic-auth`), applied as `app.use(['/docs', '/queues'], basicAuth(...))` **before** `SwaggerModule.setup()`/module init — this ordering matters, since it's what lets our middleware run before Swagger's/Bull Board's own request handling rather than being bypassed by it. `express-basic-auth` is CJS (`module.exports = fn`, no `.default`) — it's imported via `import basicAuth = require('express-basic-auth')`, not `import basicAuth from`, since this tsconfig has no `esModuleInterop` and a default import would compile to a `.default` access that doesn't exist on this module (same class of bug to watch for with any other no-esModuleInterop CJS import).
  - `src/main.ts` disables Nest's default body parser and re-registers `express.json`/`express.urlencoded` with a 100mb limit (the default 100kb is too small for the base64 audio segments in the dub endpoint) — multipart file uploads go through multer/`FileInterceptor` separately and are unaffected by this limit.

## Configuration

Env vars (loaded via `ConfigModule.forRoot()` from `.env`):
- `CONTABO_ACCESS_KEY`, `CONTABO_SECRET_KEY`
- `CONTABO_ENDPOIN` — note the missing trailing "T", this is the actual key name used in `thumbnail.service.ts`, not a typo to "fix" in isolation.
- `CONTABO_BASE_URL` — prefix used to build public thumbnail URLs
- `CONTABO_BUCKET_NAME`
- `CONTABO_ACCESS_KEY_V2`, `CONTABO_SECRET_KEY_V2`, `CONTABO_ENDPOIN_V2`, `CONTABO_BASE_URL_V2`, `CONTABO_BUCKET_NAME_V2` — used by `RenderService` for the render output bucket (separate from the thumbnail bucket above)
- `REDIS_HOST` (default `localhost`), `REDIS_PORT` (default `6379`), `REDIS_PASSWORD` (optional) — BullMQ connection for the `render` queue
- `RENDER_CONCURRENCY` — number of renders `RenderProcessor` will run in parallel; defaults to `os.cpus().length` if unset
- `ADMIN_USER` / `ADMIN_PASSWORD` — HTTP basic-auth credentials gating `GET /docs` and `GET /queues` (`src/main.ts`); default to `admin`/`changeme` if unset, so set real values in production `.env`.

CORS (`src/main.ts`) only allows `https://similartoolz.net` and `http://localhost:3000`, and only `GET, DELETE` methods — the `POST /thumbnail/upload/:userId` endpoint is therefore not reachable cross-origin from a browser under the current CORS config.

## Deployment

`ecosystem.config.js` runs the built app under PM2 as `thumbnail-api` in cluster mode against `dist/main.js`. CI (`.github/workflows/ci.yml`) only runs `yarn install && yarn build` on PRs targeting `master`; there is no test or deploy step in CI.

`Dockerfile` / `docker-compose.yml` provide a Docker-based deployment alternative (app + Redis). Notably, the production stage does **not** install ffmpeg via `apt-get` — it downloads a pinned static build (currently ffmpeg 8.0.1) from BtbN/FFmpeg-Builds instead. This is deliberate: Debian bookworm's apt package is version 5.1.9, which has a real, confirmed bug (see the `/render/dub` note above) that the pinned 8.0.1 build doesn't have. If bumping the pinned version, re-verify the dub endpoint specifically, since that's the code path that surfaced the original bug.

`docker-compose.yml` does **not** run its own nginx container — the app's `ports: ["3002:3002"]` publishes it directly to the host. This is deliberate: the Ubuntu server hosts other apps that already run their own nginx inside their own docker-compose projects, each trying to bind host port 80. `nginx/nginx.conf` is kept as a reference vhost, meant to be installed as a **host-level** nginx site (`apt install nginx`, not Dockerized) that becomes the single shared front door for all apps on the box, proxying to `127.0.0.1:3002` for this one. If you ever see "port is already allocated" for port 80 running `docker compose up`, it's because an old version of this repo's compose file (or someone re-adding an `nginx` service here) is trying to claim a port another app's nginx already owns — don't re-add a per-project nginx container here.

The `Dockerfile`'s production stage runs as **root**, not a dedicated non-root user — this is deliberate, not an oversight to "harden." `docker-compose.yml` bind-mounts `./tmp:/app/tmp` (so downloaded/rendered files are visible on the host for debugging), and on a real Linux host that bind mount enforces actual uid/gid ownership from the host side (unlike Docker Desktop on Windows, which doesn't). A non-root container user hit `EACCES` writing into that mount on the Ubuntu server because the host-side `tmp/` wasn't owned by the container's uid. Running as root sidesteps needing the host directory's ownership to match a specific container uid.
