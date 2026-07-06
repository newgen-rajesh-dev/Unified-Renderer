# Architecture

This project is a Bun-based rendering service. It receives JSON payloads, prepares assets, generates a HyperFrames composition, renders an MP4, optionally applies background music, uploads the result, and stores public job metadata.

## Runtime Flow

`POST /render` is asynchronous: the server accepts the job, responds immediately
with `202`, renders in the background, and POSTs the result to the payload's
`callbackUrl`. It does not hold the request connection open for the render.

1. `server.js` starts the Bun HTTP server.
2. `POST /render` first checks `RENDER_API_KEY` before reading the JSON body.
3. `POST /render` receives a JSON payload.
4. `server.js` validates the top-level `type` and routes to a strategy:
   - `L1L2` -> `strategies/l1l2/index.js`
   - `L3L4` -> `strategies/l3l4/index.js`
5. The strategy normalizes and validates the payload. `server.js` also requires a
   `callbackUrl` and reads an optional `callbackId` (both from the raw payload,
   not the normalized timeline); a missing `callbackUrl` is rejected with `422`.
6. A job record (including `callbackUrl` and `callbackId`) is created in memory and persisted through `common/job-store.js`.
7. `server.js` responds immediately with `202` and `{ jobId, status: "rendering", accepted: true, statusUrl }`, then runs the pipeline in the background.
8. A workspace is created at `.jobs/<jobId>/`.
9. Strategy asset preparation downloads/materializes media into `.jobs/<jobId>/assets/`.
10. The strategy returns a neutral timeline model with `clips`.
11. `common/composition-html.js` converts the timeline model into `index.html`.
12. `server.js` writes a generated `hyperframes.json` into the job workspace.
13. `common/render.js` runs HyperFrames render.
14. If `bgMusic` exists, `common/media.js` applies it with ffmpeg.
15. The final MP4 is copied into `renders/`.
16. `common/s3-upload.js` uploads the MP4 to AWS S3 with Bun's native S3 client.
17. Completed job workspaces are removed.
18. `deliverCallback` (in `server.js`) makes one `POST` to the job's `callbackUrl` with the terminal result (`status`, `uploadedKey`, `uploadedUrl`, `error`, ...) plus the payload's `type` and `callbackId` echoed back for the caller to route on. Fire-and-forget, no retries; failures are logged. The result remains pollable at `GET /status/:jobId`.

## Entrypoint

`server.js` is the only server entrypoint.

It owns:

- HTTP route handling
- CORS / JSON response helpers
- `POST /render` API-key authorization through `RENDER_API_KEY`
- top-level type routing
- job object creation
- workspace path creation
- dynamic job `hyperframes.json` generation
- handoff to render/publish flow

Valid payload types are only:

- `L1L2`
- `L3L4`

`L1`, `L2`, `L3`, and `L4` are not accepted.

## Request Authorization

`POST /render` requires `RENDER_API_KEY` to be configured on the renderer. The
request must send the same value as `Authorization: Bearer <key>` or
`X-Render-Api-Key: <key>`. Missing renderer configuration returns `503`; missing
or wrong request credentials return `401`. The authorization check runs before
JSON body parsing or payload validation.

API keys are generated manually with `bun run generate-api-key`. The generator
prints a random key and does not persist it. The renderer does not have an API-key
database; `server.js` reads `process.env.RENDER_API_KEY` at startup and keeps it
in memory for request-header comparison.

CORS is still emitted for browser clients, but it is not used as authorization
because non-browser clients can spoof or omit `Origin`.

## Payload Validation

All payloads require:

- `type`
- `id`
- `callbackUrl` (the result is delivered here when the render finishes)
- at least one renderable input:
  - `intro`
  - `outro`
  - `titleCard`
  - `keyLearnings`
  - `scenes`

`logo` and `bgMusic` are optional additions. They cannot be sent alone because they do not create a visual timeline.

`sections` is not accepted. Use `scenes`.

When `titleCard` is present, both fields are required:

- `titleCard.vidSrc`
- `titleCard.titleText`

When `keyLearnings` is present, all fields are required:

- `keyLearnings.vidSrc`
- `keyLearnings.blue`
- `keyLearnings.green`
- `keyLearnings.points`, exactly four non-empty strings

## Strategies

### L1/L2

File: `strategies/l1l2/index.js`

Purpose: image or clip scenes with narration audio.

Scene rules:

- `link` is required.
- `audio` is required.
- `type` is optional.
- `type: "clip"` means the scene visual is a video clip.
- Any other value, including missing `type`, is treated as an image scene.

Timing:

- Scene duration is driven by narration audio duration.
- Image scenes pan for the duration of the narration.
- Clip scenes are stretched when shorter than narration.
- Clip scenes are copied and re-encoded when long enough.

Audio:

- Scene narration audio is added as a separate audio clip.
- Clip video audio is disabled with `hasAudio: false`.

### L3/L4

File: `strategies/l3l4/index.js`

Purpose: video scenes.

Scene rules:

- `link` is required.
- `ost` is optional.

Timing:

- Scene duration is driven by each video duration.
- All videos are re-encoded for seek.
- Visual video segments are assigned unique track indexes as they are added to the L3/L4 timeline, including intro, title card, each scene, key learnings background, and outro.

## Shared Composition Model

Both strategies return a neutral timeline object:

```js
{
  id,
  duration,
  width,
  height,
  background,
  bgMusic,
  clips
}
```

`clips` are consumed by `common/composition-html.js`.

## Composition HTML

File: `common/composition-html.js`

Responsibilities:

- render clip HTML
- render title text overlays
- render key learnings overlays
- render image/video/audio clips
- render OST chips
- build the GSAP timeline
- register `window.__timelines[compositionId]`
- attach deterministic media sync for video/audio clips

Generated fade-out tweens are followed by explicit `tl.set(..., { opacity: 0 })`
hard kills at the clip end so HyperFrames nonlinear seeks cannot leave stale
overlay visibility after an exit animation.

Key learnings overlays are shared by both strategies. The strategies add a normal video clip for the background and a `keyLearnings` overlay clip on top of it. The background video duration controls the overlay duration, and the clip is placed after all scenes and before outro.

Generated composition HTML uses UTF-8 and `lang="und"` because caller-provided
text may be in multiple languages. Title text, key learning text, and OST text
use `dir="auto"` plus `unicode-bidi: plaintext` so mixed LTR/RTL strings resolve
direction per text run. Text overlays load and prefer Noto Sans families for
Latin, Arabic, Bengali, Devanagari/Hindi/Nepali, and Japanese script coverage,
with Inter, Geist, and system fonts retained as later fallbacks.

Key learning point animation wraps Latin/simple-script characters in
`.key-learning-char` spans for the existing reveal effect. For Arabic, Bengali,
and Devanagari text, the renderer preserves the full escaped text run instead
of splitting every character, because per-character spans can break shaping and
combining marks.

This file is shared by all strategies. Strategy files should not generate full HTML directly.

## Media Helpers

File: `common/media.js`

Responsibilities:

- `probeHasAudio`
- `probeMediaDuration`
- `downloadToFile`
- `reencodeForSeek`
- `stretchVideoToDuration`
- `applyBackgroundMusic`

`FFMPEG_PRESET` applies to video re-encoding paths:

- `reencodeForSeek`
- `stretchVideoToDuration`

Both video paths emit 30fps H.264 with GOP/keyframe settings of `-g 30 -keyint_min 30` so HyperFrames can seek reliably during frame capture.

It does not apply to background music, because background music copies the video stream and only processes audio.

## Render Flow

File: `common/render.js`

Responsibilities:

- run the locally installed HyperFrames CLI through Bun's package binary resolution
- stream render logs into job state
- apply optional background music
- copy final output into `renders/`
- upload the MP4
- mark job complete or failed
- delete completed job workspaces

The render path uses `bun run hyperframes render <jobDir>` instead of `bunx`, so dependency resolution is stable on Windows and does not depend on Bun's temporary `bunx-*` cache.

HyperFrames `0.7.6` is patched through Bun's `patchedDependencies` mechanism
(`patches/hyperframes@0.7.6.patch`). The patch makes the renderer hold the last
extracted frame for a still-active non-looping video when frame lookup runs past
the extracted frame count, preventing a black injected frame at exact adjacent
video clip boundaries.

There is no post-render intro/outro stitching. Intro and outro are timeline clips generated by the strategies.

## Asset Cache

File: `common/asset-cache.js`

Responsibilities:

- hash URL inputs
- cache downloaded assets under `.asset-cache/`
- avoid duplicate concurrent downloads
- materialize cached assets into each job workspace

Strategies should use the asset cache instead of downloading directly.

## Job Store

File: `common/job-store.js`

Responsibilities:

- create the SQLite jobs table
- persist public job metadata
- return job status
- list jobs
- return health stats

Private render logs stay in memory and are not returned by public job responses.

## Uploads

File: `common/s3-upload.js`

Responsibilities:

- create the Bun `S3Client`
- require `AWS_ACCESS_KEY`, `AWS_SECRET_KEY`, and `AWS_S3_BUCKET`
- require `AWS_S3_REGION`
- upload completed MP4 files to `renders/<jobId>/<fileName>`
- return AWS S3 URL/key metadata

## Generated Files

Generated runtime folders:

- `.jobs/`
- `.asset-cache/`
- `renders/`

These are not source folders.

Generated job workspaces receive their own `hyperframes.json` from `server.js`. There is no root `hyperframes.json` source file.
