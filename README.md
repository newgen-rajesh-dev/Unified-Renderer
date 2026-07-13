# HyperFrames Rendering Server

A Bun service that accepts JSON payloads, generates HyperFrames compositions, renders MP4 videos, and uploads completed outputs.

## Requirements

| Requirement | Notes |
| --- | --- |
| Bun | Runs the HTTP server and project scripts |
| Node/npm | Used only for npm script compatibility |
| ffmpeg / ffprobe | Required for probing, re-encoding, and background music |
| Local dependencies | Run `bun install` before rendering; HyperFrames is installed as a local package |
| AWS S3 credentials | Required for completed video uploads |

The service listens on port `3001` by default.

## Quickstart

```bash
bun install
bun run dev
```

Run on another port:

```bash
PORT=3002 bun run dev
```

Additional commands:

```bash
bun run generate-api-key
bun run check
bun run render
bun run publish
```
Stop service already running in 3001 (windows)? :
```bash
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3001).OwningProcess -Force

```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP server port |
| `CORS_ORIGIN` | `*` | Browser CORS origin returned in `Access-Control-Allow-Origin`; set this to your app origin (for example `https://app.example.com`) instead of `*` in production |
| `RENDER_API_KEY` | none | Required shared secret for `POST /render`; requests must send it as `Authorization: Bearer <key>` or `X-Render-Api-Key: <key>` |
| `MAX_CONCURRENT_RENDERS` | `3` | Maximum number of render jobs processed concurrently |
| `JOB_TIMEOUT_MS` | `1200000` | Queue/job timeout in milliseconds before a pending or running job is failed |
| `RENDER_TIMEOUT_MS` | `900000` | HyperFrames render process timeout in milliseconds |
| `RENDER_QUALITY` | `standard` | Render quality passed to HyperFrames |
| `FFMPEG_PRESET` | `veryfast` | ffmpeg preset for video re-encoding |
| `AWS_ACCESS_KEY` | none | AWS access key used by Bun's S3 client |
| `AWS_SECRET_KEY` | none | AWS secret key used by Bun's S3 client |
| `AWS_S3_BUCKET` | none | S3 bucket for completed MP4 uploads |
| `AWS_S3_REGION` | none | AWS region for the S3 bucket, for example `us-east-1` |

The service also passes HyperFrames producer environment variables through to
the local `hyperframes render` process. Common production tuning variables are:

| Variable | Example | Purpose |
| --- | --- | --- |
| `PRODUCER_MAX_WORKERS` | `6` | Maximum HyperFrames frame capture workers |
| `PRODUCER_ENABLE_BROWSER_POOL` | `true` | Enables HyperFrames browser pooling |
| `PRODUCER_PUPPETEER_LAUNCH_TIMEOUT_MS` | `180000` | Puppeteer browser launch timeout |
| `PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS` | `300000` | Chrome DevTools protocol timeout |
| `PRODUCER_PLAYER_READY_TIMEOUT_MS` | `90000` | Timeout for the HyperFrames player to become ready |
| `PRODUCER_RENDER_READY_TIMEOUT_MS` | `60000` | Timeout for render readiness checks |

Completed videos are copied to local `renders/<fileName>` and uploaded to S3 under `renders/<jobId>/<fileName>`. If the payload includes `filename`, that value names the MP4; otherwise the service generates a timestamped name. Job metadata stores the S3 object key in `uploadedKey`, the final file name in `reservedOutputFileName`, and an AWS virtual-hosted object URL in `uploadedUrl`.

## Security

`POST /render` requires `RENDER_API_KEY`.

### Generate an API key

Run this command manually when you need a new key:

```bash
bun run generate-api-key
```

The command prints one random 32-byte hex key immediately, for example:

```text
1c2295f7ebcb5d9251adb880357491b12823afb5e16c1343bf8e6e869eac0a9c
```

The generator does not save the key anywhere. Copy the printed value into your
secret store, deployment environment variables, `.env` file, or process manager
configuration.

### Configure the renderer

Set the same key on the renderer process:

```bash
RENDER_API_KEY=<generated-key>
CORS_ORIGIN=https://your-app.example.com
```

At startup, `server.js` reads `process.env.RENDER_API_KEY` and keeps that value
in memory. For every `POST /render`, it compares the request header value against
that configured environment value.

Send the key with each render request using either header:

```http
Authorization: Bearer <generated-key>
X-Render-Api-Key: <generated-key>
```

If `RENDER_API_KEY` is missing on the renderer, `POST /render` returns `503`. If
the request header is missing or wrong, it returns `401`.

Do not put this key in browser/frontend code. The caller should be a trusted
backend service that can keep the key secret. CORS remains a browser access
control, but the API key is the actual authorization check.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Returns server status and job counts |
| `POST` | `/render` | Accepts a render job and returns immediately (`202`); renders in the background and POSTs the result to `callbackUrl` |
| `GET` | `/status/:jobId` | Returns public metadata for one job |
| `GET` | `/jobs` | Lists persisted jobs, newest first |
| `GET` | `/renders/:file` | Downloads a rendered MP4 from `renders/`; URL-encode custom file names when needed |

## Render Lifecycle (async + callback)

`POST /render` is **asynchronous**. It does not hold the connection open for the
render. The flow is:

1. The caller POSTs a payload that includes a `callbackUrl` (and usually a
   `callbackId` to correlate the result) plus the `RENDER_API_KEY` header.
2. The server authorizes the request, validates the payload, creates the job,
   and responds **immediately** with `202` and `{ jobId, status: "rendering", accepted: true, statusUrl, requestedFileName }`.
3. The render runs in the background (prepare assets → render → bg music → copy to `renders/<fileName>` → upload to S3).
4. When the job reaches a terminal state, the server makes **one** `POST` to the
   caller's `callbackUrl` with the result (no retries). The payload's `type` and
   the `callbackId` are echoed back so the caller can route the result without
   parsing the URL.
5. Job status is always also pollable at `GET /status/:jobId` as a backstop.

`callbackUrl` is **required** — a payload without it is rejected with `422`. The
URL is treated as a constant by the renderer; correlation lives entirely in the
echoed `type` + `callbackId`, so one constant callback endpoint can serve every job.

### Callback request body

The server POSTs this JSON to `callbackUrl` (`Content-Type: application/json`):

| Field | Description |
| --- | --- |
| `type` | The payload `type` (`L1L2` or `L3L4`), echoed so the caller knows the flow |
| `callbackId` | The payload's `callbackId`, echoed (or `null`) |
| `jobId` | The server-assigned job id |
| `compositionId` | The payload `id` |
| `status` | `complete` or `failed` |
| `uploadedKey` | S3 object key of the final MP4 (use this to build fresh URLs) |
| `uploadedUrl` | AWS virtual-hosted object URL (only valid if the bucket is public) |
| `fileName` | Final MP4 file name used locally and in the S3 key; may include a numeric suffix if the requested name already existed |
| `statusUrl` | The `GET /status/:jobId` URL |
| `error` | Failure reason when `status` is `failed`, otherwise `null` |
| `completedAt` / `failedAt` | Terminal timestamp |

The callback is fire-and-forget with no retries: the caller is assumed to be
reachable. The result is also durably stored (S3 + `GET /status/:jobId`).

## Payloads

The server accepts one JSON payload per `POST /render` request.

### Base Fields

| Field | Required | Description |
| --- | --- | --- |
| `type` | Yes | Must be `L1L2` or `L3L4` |
| `id` | Yes | Stable render/composition id |
| `callbackUrl` | Yes | URL the server POSTs the render result to when the job finishes (see Render Lifecycle) |
| `callbackId` | No | Opaque correlation id echoed back in the callback so the caller can route the result (e.g. a project id or script id) |
| `filename` | No | Requested final MP4 file name for both local `renders/` storage and the S3 key |
| `intro` | Conditional | Optional intro video link |
| `outro` | Conditional | Optional outro video link |
| `titleCard` | Conditional | Optional title card object |
| `keyLearnings` | Conditional | Optional key learnings screen object |
| `scenes` | Conditional | Optional scene array |
| `logo` | No | Optional logo image link |
| `bgMusic` | No | Optional background music audio link |

`type` and `id` alone do not produce a video. At least one conditional render input must also be present:

- `intro`
- `outro`
- `titleCard`
- `keyLearnings`
- `scenes`

`logo` and `bgMusic` can be added only when the payload has at least one conditional render input. They do not create a video by themselves.

`filename` is optional for both `L1L2` and `L3L4`. When provided, it must be a non-empty string without path separators, control characters, or these characters: `< > : " / \\ | ? *`. The renderer appends `.mp4` when it is missing and normalizes `.MP4` to `.mp4`. If the requested file already exists or is reserved by another running job, the final name receives a numeric suffix such as `_2`; the actual final name is returned as `fileName` in the callback and as `reservedOutputFileName` in job status.

### Types

| Type | Scene media | Scene audio |
| --- | --- | --- |
| `L1L2` | Image or video clip | Required per scene |
| `L3L4` | Video | Not required |

### Title Card

When `titleCard` is present, both fields are required:

| Field | Required | Description |
| --- | --- | --- |
| `titleCard.vidSrc` | Yes | Title card video link |
| `titleCard.titleText` | Yes | Text rendered over the title card |

### Key Learnings

`keyLearnings` is available for both `L1L2` and `L3L4`. It renders after all `scenes` and before `outro`. When present, its background video duration drives the key learnings screen duration.

All fields are required:

| Field | Required | Description |
| --- | --- | --- |
| `keyLearnings.vidSrc` | Yes | Key learnings background video link |
| `keyLearnings.blue` | Yes | Blue title word, localized by the caller |
| `keyLearnings.green` | Yes | Green title word, localized by the caller |
| `keyLearnings.points` | Yes | Exactly four non-empty point strings |

### Localized Text

Text fields are UTF-8 and may contain localized copy, including Latin-script text, Arabic, Bengali, Devanagari/Hindi/Nepali, and Japanese. The renderer applies automatic text direction on rendered text overlays and uses Noto Sans families for multilingual script coverage.

The renderer does not translate copy or synthesize narration. Send already-localized `titleCard.titleText`, `keyLearnings.blue`, `keyLearnings.green`, `keyLearnings.points`, and scene `ost` text. For `L1L2` narration, send localized audio in each scene's `audio` field.

### Scenes

Use `scenes` for scene arrays. `sections` is not accepted.

For `L1L2`, every scene requires:

| Field | Required | Description |
| --- | --- | --- |
| `type` | No | `img` by default, or `clip` for a video clip scene |
| `link` | Yes | Image or video clip URL |
| `audio` | Yes | Narration audio URL |
| `ost` | No | On-screen text |

For `L3L4`, every scene requires:

| Field | Required | Description |
| --- | --- | --- |
| `link` | Yes | Video URL |
| `ost` | No | On-screen text |

## Examples

- [L1L2 payload example](strategies/l1l2/payload.example.json)
- [L3L4 payload example](strategies/l3l4/payload.example.json)
