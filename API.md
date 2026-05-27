# HyperFrames Rendering Server API

A JSON-based video rendering server that accepts timeline data and generates MP4 videos using HyperFrames.

## Running the Server

```bash
# Using Bun
bun run server.js

# Using Node.js
node server.js
```

Server runs on `http://localhost:3001` by default. Set `PORT` env var to change.

## API Endpoints

### Health Check
```
GET /health
```

Returns server status.

**Response:**
```json
{
  "status": "ok"
}
```

---

### Submit Render Job
```
POST /render
Content-Type: application/json
```

Submit a timeline configuration to render a video.

**Request Body:**

```json
{
  "id": "composition-name",
  "duration": 10,
  "width": 1920,
  "height": 1080,
  "background": "#000000",
  "audio": "path/to/audio.mp3",
  "clips": [
    {
      "id": "clip-1",
      "type": "text|image|video",
      "content": "Text content or file path",
      "start": 0,
      "duration": 5,
      "trackIndex": 0,
      "style": {
        "fontSize": "64px",
        "color": "#ffffff",
        "padding": "40px",
        "textAlign": "center"
      }
    }
  ]
}
```

**Parameters:**

| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `id` | string | Composition identifier | "main" |
| `duration` | number | Total video duration in seconds | 10 |
| `width` | number | Video width in pixels | 1920 |
| `height` | number | Video height in pixels | 1080 |
| `background` | string | Background color (hex or color name) | "#000" |
| `audio` | string | Path to audio file (optional) | null |
| `clips` | array | Array of clip objects | [] |

**Clip Object:**

| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `id` | string | Unique clip identifier | required |
| `type` | string | "text", "image", or "video" | "text" |
| `content` | string | Text content or file path | "" |
| `start` | number | Start time in seconds | 0 |
| `duration` | number | Duration in seconds | 5 |
| `trackIndex` | number | Layer/track index (higher = on top) | 0 |
| `style` | object | CSS style properties (camelCase) | {} |

**Style Properties (Common CSS):**
- `fontSize`, `fontWeight`, `color`
- `padding`, `margin`
- `textAlign`, `textDecoration`
- `backgroundColor`, `border`
- `transform`, `opacity`
- Any valid CSS property in camelCase

**Response:**
```json
{
  "jobId": "composition-name-1234567890",
  "status": "rendering",
  "estimatedOutputPath": "renders/composition-name-1234567890.mp4"
}
```

---

### Check Render Status
```
GET /status/{jobId}
```

Check if a render job is complete.

**Response (Rendering):**
```json
{
  "jobId": "composition-name-1234567890",
  "status": "rendering"
}
```

**Response (Complete):**
```json
{
  "jobId": "composition-name-1234567890",
  "status": "complete",
  "path": "renders/composition-name-1234567890.mp4"
}
```

---

## Examples

### Simple Text Video

```bash
curl -X POST http://localhost:3001/render \
  -H "Content-Type: application/json" \
  -d '{
    "id": "hello-world",
    "duration": 5,
    "clips": [
      {
        "id": "title",
        "type": "text",
        "content": "Hello World",
        "start": 0,
        "duration": 5,
        "trackIndex": 0,
        "style": {
          "fontSize": "96px",
          "color": "#ffffff",
          "padding": "200px"
        }
      }
    ]
  }'
```

### Multi-Scene Timeline

```bash
curl -X POST http://localhost:3001/render \
  -H "Content-Type: application/json" \
  -d '{
    "id": "multi-scene",
    "duration": 10,
    "background": "#1a1a1a",
    "clips": [
      {
        "id": "scene-1",
        "type": "text",
        "content": "Scene 1",
        "start": 0,
        "duration": 3,
        "style": { "fontSize": "72px", "color": "#00ff00" }
      },
      {
        "id": "scene-2",
        "type": "text",
        "content": "Scene 2",
        "start": 3,
        "duration": 4,
        "style": { "fontSize": "72px", "color": "#00aaff" }
      },
      {
        "id": "scene-3",
        "type": "text",
        "content": "Scene 3",
        "start": 7,
        "duration": 3,
        "style": { "fontSize": "72px", "color": "#ffaa00" }
      }
    ]
  }'
```

### With Media Files

```bash
curl -X POST http://localhost:3001/render \
  -H "Content-Type: application/json" \
  -d '{
    "id": "media-video",
    "duration": 10,
    "clips": [
      {
        "id": "bg-video",
        "type": "video",
        "content": "path/to/background.mp4",
        "start": 0,
        "duration": 10,
        "trackIndex": 0
      },
      {
        "id": "title-text",
        "type": "text",
        "content": "My Video",
        "start": 2,
        "duration": 6,
        "trackIndex": 1,
        "style": {
          "fontSize": "80px",
          "color": "#ffffff",
          "textShadow": "0 0 10px rgba(0,0,0,0.8)"
        }
      }
    ]
  }'
```

## Workflow

1. **Submit Job** → POST to `/render` with timeline JSON
2. **Get Job ID** → Receive `jobId` in response
3. **Check Status** → Poll `/status/{jobId}` until `status` is "complete"
4. **Retrieve Video** → Access MP4 from the `path` in status response

## Notes

- Render jobs execute asynchronously in the background
- The `/render` endpoint returns immediately with a job ID
- Check `/status/{jobId}` to monitor progress
- Rendered videos are saved to `./renders/` directory
- All timings are in seconds
- Use `trackIndex` to layer clips (higher numbers appear on top)
- Clips automatically fade in/out for smooth transitions
- HyperFrames skills can be used for advanced animations (see `/hyperframes` skill)
