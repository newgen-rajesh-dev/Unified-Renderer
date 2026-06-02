# HyperFrames Rendering Server

This project is a Bun-based rendering service that turns JSON payloads into HyperFrames HTML compositions, renders them to MP4, stores render/job state locally, and uploads finished videos through UploadThing.

It is not only a static HyperFrames composition project. The main entrypoint is `server.js`, which accepts render requests, prepares assets into a per-job workspace, generates `index.html`, runs `hyperframes render`, optionally stitches intro/outro/background music with ffmpeg, saves the MP4 in `renders/`, and uploads it.

## Quick Start

Requirements:

- Bun
- Node/npm tooling for the npm scripts
- ffmpeg and ffprobe on `PATH`
- `UPLOADTHING_TOKEN` in the environment for successful uploads

Install dependencies:

```bash
bun install
```

Start the server:

```bash
npm run dev
```

`npm run dev` is long-running. Agents should start it in the background and keep it alive while testing.

The server listens on `http://localhost:3001` by default. Override with `PORT`.

## Commands

```bash
npm run dev      # run server.js with Bun
npm run check    # hyperframes lint + validate + inspect
npm run render   # render the root HyperFrames project
npm run publish  # publish the root HyperFrames project
```

The checked HyperFrames CLI version is pinned in `package.json` as `hyperframes@0.6.69`. Runtime rendering can be overridden with `HYPERFRAMES_VERSION`.

## Server API

### `GET /health`

Returns server status plus job counts.

### `POST /render`

Accepts either an `L3L4` payload or an `L1L2`/`L1`/`L2` payload. The server prepares assets, renders synchronously, uploads the result, and returns the completed or failed job response.

Example:

```bash
curl -X POST http://localhost:3001/render \
  -H "Content-Type: application/json" \
  --data @strategies/l3l4/payload.example.json
```

### `GET /status/:jobId`

Returns persisted public job metadata.

### `GET /jobs`

Lists persisted jobs from `.jobs/jobs.sqlite`, newest first.

### `GET /renders/:file`

Downloads a rendered MP4 from `renders/`.

## Payload Strategies

The server chooses the strategy from `payload.type`.

### L3/L4

Use `type: "L3L4"` or omit/avoid the L1/L2 types. Sections are video clips.

Required:

- `sections`: non-empty array
- each section needs `link`

Optional:

- `id`
- `speedrun`
- `intro`
- `outro`
- `overlayImage`
- `bgMusic`
- `background`
- `titleCard.vidSrc`
- `titleCard.titleText`
- section `part1` or `part`
- section `ost`

See `strategies/l3l4/payload.example.json`.

### L1/L2

Use `type: "L1L2"`, `"L1"`, or `"L2"`. Sections are image plus narration audio; each section duration is driven by its audio duration.

Required:

- `sections`: non-empty array
- each section needs `link` for the image
- each section needs `audio`

Optional fields are the same as L3/L4, including `intro`, `outro`, `overlayImage`, `bgMusic`, `titleCard`, `background`, and section `ost`.

### Speedrun Mode

Add `speedrun: true` at the top level to render only the core section media and OST:

```json
{
  "type": "L3L4",
  "speedrun": true,
  "sections": [
    { "link": "https://example.com/section-1.mp4", "ost": "On-screen text" }
  ]
}
```

When enabled, the server ignores `intro`, `outro`, `titleCard`, `overlayImage`, and `bgMusic` even if they are present in the payload. For L1/L2, section narration audio is still used because it drives image scene duration.

## Output Flow

For every render request:

1. `server.js` normalizes the payload and creates a job id.
2. A per-job workspace is created under `.jobs/<jobId>/`.
3. Assets are downloaded or materialized from `.asset-cache/`.
4. Strategy code generates `.jobs/<jobId>/index.html`.
5. `common/render.js` runs `bunx --bun hyperframes render`.
6. Optional intro/outro stitching and background music are handled by ffmpeg.
7. The final MP4 is copied to `renders/`.
8. UploadThing uploads the MP4.
9. Completed job workspaces are removed.

Render filenames use this pattern:

```text
HH-MM-SSAM_DD-MM-YYYY_STRATEGY.mp4
```

## Project Map

- `server.js` - Bun HTTP server, routing, job lifecycle, payload strategy selection.
- `common/render.js` - invokes HyperFrames render, publishes output, uploads, cleans completed jobs.
- `common/media.js` - ffmpeg/ffprobe helpers for probing, re-encoding, stitching, and background music.
- `common/ost-style.js` - shared OST overlay markup, styling, and animation defaults used by L1/L2 and L3/L4.
- `common/asset-cache.js` - URL hashing and cached asset materialization.
- `common/job-store.js` - SQLite-backed public job metadata store.
- `common/uploadthing.js` - UploadThing client wrapper.
- `strategies/l3l4/index.js` - video-section strategy and generated HyperFrames composition HTML.
- `strategies/l1l2/index.js` - image-plus-audio strategy and generated HyperFrames composition data.
- `strategies/l3l4/payload.example.json` - example L3/L4 request body.
- `ost-box-style-guide.txt` - Figma-derived visual reference for OST chip styling.
- `hyperframes.json` - HyperFrames registry/path config copied into job workspaces.
- `meta.json` - project id/name metadata.
- `oneframe_2.0_demo.html` - large standalone demo/reference artifact.
- `.jobs/` - generated job workspaces and SQLite job store.
- `.asset-cache/` - generated downloaded asset cache.
- `renders/` - generated final MP4 outputs.

Generated folders are ignored by git and should not be treated as source.

## Environment Variables

- `PORT` - server port, default `3001`.
- `CORS_ORIGIN` - CORS origin, default `*`.
- `UPLOADTHING_TOKEN` - required for completed video upload.
- `HYPERFRAMES_VERSION` - render-time CLI version, default `0.6.69`.
- `RENDER_QUALITY` - passed to `hyperframes render --quality`, default `standard`.
- `FFMPEG_PRESET` - ffmpeg preset for re-encoding/stitching, default `veryfast`.

## Agent Workflow

Before editing HyperFrames composition generation, read `AGENTS.md` and use the relevant HyperFrames skills. The project relies on framework-specific rules for timed clips, media sync, and registered timelines.

After editing any HTML composition or code that generates composition HTML:

```bash
npm run check
```

Fix all errors before handing off. For server/API changes, also run the server and exercise at least:

```bash
GET /health
POST /render
GET /status/:jobId
GET /jobs
```

Keep generated workspaces, caches, and render outputs out of source changes unless the user explicitly asks for artifacts.

## Composition Rules To Preserve

- Every timed visible element needs `class="clip"`.
- Every timed element needs `data-start`, `data-duration`, and `data-track-index`.
- GSAP timelines must be paused and registered on `window.__timelines`.
- Rendering logic must be deterministic inside generated compositions.
- Video seek behavior depends on dense keyframes; strategy asset preparation re-encodes video inputs for this reason.
- Duration values are floored to two decimals to avoid seeking past the last decoded frame.
