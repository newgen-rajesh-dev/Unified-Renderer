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
| `CORS_ORIGIN` | `*` | CORS origin |
| `AWS_ACCESS_KEY` | none | AWS access key used by Bun's S3 client |
| `AWS_SECRET_KEY` | none | AWS secret key used by Bun's S3 client |
| `AWS_S3_BUCKET` | none | S3 bucket for completed MP4 uploads |
| `AWS_S3_REGION` | none | AWS region for the S3 bucket, for example `us-east-1` |
| `RENDER_QUALITY` | `standard` | Render quality passed to HyperFrames |
| `FFMPEG_PRESET` | `veryfast` | ffmpeg preset for video re-encoding |

Completed videos are uploaded to S3 under `renders/<jobId>/<fileName>`. Job metadata stores that object key in `uploadedKey` and an AWS virtual-hosted object URL in `uploadedUrl`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Returns server status and job counts |
| `POST` | `/render` | Creates and runs a render job synchronously |
| `GET` | `/status/:jobId` | Returns public metadata for one job |
| `GET` | `/jobs` | Lists persisted jobs, newest first |
| `GET` | `/renders/:file` | Downloads a rendered MP4 from `renders/` |

## Payloads

The server accepts one JSON payload per `POST /render` request.

### Base Fields

| Field | Required | Description |
| --- | --- | --- |
| `type` | Yes | Must be `L1L2` or `L3L4` |
| `id` | Yes | Stable render/composition id |
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
