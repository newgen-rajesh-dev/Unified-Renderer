import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERS_DIR = path.join(__dirname, 'renders');
const JOBS_DIR = path.join(__dirname, '.jobs');

// Job status store (in-memory; replace with DB for multi-process use)
const jobs = new Map();

await fs.mkdir(RENDERS_DIR, { recursive: true });
await fs.mkdir(JOBS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Timeline JSON -> HyperFrames HTML composition
// ---------------------------------------------------------------------------

function camelToKebab(str) {
  return str.replace(/([A-Z])/g, '-$1').toLowerCase();
}

function styleObjectToString(style) {
  return Object.entries(style)
    .map(([key, value]) => `${camelToKebab(key)}: ${value}`)
    .join('; ');
}

function buildClipHtml(clip) {
  const {
    id: clipId,
    type = 'text',
    start = 0,
    duration = 5,
    trackIndex = 0,
    content = '',
    style = {},
    animation = null,
    mediaDuration = null,
  } = clip;

  const baseAttrsArr = [
    `id="${clipId}"`,
    `class="clip"`,
    `data-start="${start}"`,
    `data-duration="${duration}"`,
    `data-track-index="${trackIndex}"`,
  ];
  if (mediaDuration != null) {
    baseAttrsArr.push(`data-media-duration="${mediaDuration}"`);
  }
  const baseAttrs = baseAttrsArr.join(' ');

  const customStyle = styleObjectToString(style);

  if (type === 'text') {
    const defaultStyle = 'position: absolute; top: 0; left: 0; font-size: 64px; color: #fff; padding: 40px;';
    return `<div ${baseAttrs} style="${defaultStyle} ${customStyle}">${content}</div>`;
  }

  if (type === 'image') {
    const defaultStyle = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover;';
    return `<img ${baseAttrs} src="${content}" style="${defaultStyle} ${customStyle}" alt="" />`;
  }

  if (type === 'video') {
    const defaultStyle = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover;';
    // src directly on <video>; HyperFrames extracts audio natively via data-has-audio.
    // Not muted — we want HF to mix the video's own audio track into the render.
    return `<video ${baseAttrs} src="${content}" style="${defaultStyle} ${customStyle}" playsinline preload="auto" data-has-audio="true" data-volume="1"></video>`;
  }

  if (type === 'audio') {
    return `<audio ${baseAttrs} src="${content}" preload="auto" data-volume="1"></audio>`;
  }

  if (type === 'ost') {
    // OST = on-screen text. Flex wrapper fills the frame with 20px safe-area
    // padding; the inner chip is anchored bottom-left via flex alignment.
    // The chip is auto-width and wraps to multiple lines when overflowing —
    // its background only ever hugs the text.
    const wrapperStyle = [
      'position: absolute',
      'inset: 0',
      'display: flex',
      'align-items: flex-end',
      'justify-content: flex-start',
      'padding: 20px',
      'pointer-events: none',
    ].join('; ');
    const chipStyle = [
      'background: #4FC3F7',
      'color: #ffffff',
      "font-family: 'Geist', sans-serif",
      'font-size: 85px',
      'font-weight: 600',
      'line-height: 1.1',
      'padding: 20px 28px',
      'border-radius: 12px',
      'max-width: 100%',
      'word-wrap: break-word',
      'transform: translateY(60px)',
      'opacity: 0',
      'will-change: transform, opacity',
    ].join('; ');
    return `<div ${baseAttrs} style="${wrapperStyle}"><div id="${clipId}-chip" style="${chipStyle}">${content}</div></div>`;
  }

  if (type === 'shape') {
    const defaultStyle = 'position: absolute; top: 0; left: 0;';
    return `<div ${baseAttrs} style="${defaultStyle} ${customStyle}"></div>`;
  }

  return '';
}

function buildAnimationScript(clips, compositionId) {
  const tweens = clips.filter(c => c.type !== 'audio').map(clip => {
    const { id, type, start = 0, duration = 5, animation = null } = clip;
    const fadeIn = animation?.fadeIn ?? 0.3;
    const fadeOut = animation?.fadeOut ?? 0.3;

    // OST: wrapper is fully visible during the window (no fade — the chip
    // itself does the visible transition). Chip slides up from below while
    // fading in; exits with a simple fade-out, no slide.
    if (type === 'ost') {
      const chipSel = `#${id}-chip`;
      return [
        `  tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: 0 }, ${start});`,
        `  tl.to("#${id}", { opacity: 0, duration: 0 }, ${start + duration});`,
        `  tl.fromTo("${chipSel}", { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: ${fadeIn}, ease: "power3.out" }, ${start});`,
        `  tl.to("${chipSel}", { opacity: 0, duration: ${fadeOut}, ease: "power2.in" }, ${start + duration - fadeOut});`,
      ].join('\n');
    }

    const hold = duration - fadeIn - fadeOut;
    return [
      `  tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: ${fadeIn} }, ${start});`,
      hold > 0
        ? `  tl.to("#${id}", { opacity: 0, duration: ${fadeOut} }, ${start + fadeIn + hold});`
        : `  tl.to("#${id}", { opacity: 0, duration: ${fadeOut} }, ${start + fadeIn});`,
    ].join('\n');
  }).join('\n');

  return `
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
${tweens}

    // Deterministic per-frame media seek. Always runs (preview + render) so the
    // headless renderer captures the correct video frame at every timestamp.
    (function attachMediaSync(){
      const medias = Array.from(document.querySelectorAll('video.clip, audio.clip')).map(el => ({
        el,
        start: parseFloat(el.dataset.start) || 0,
        duration: parseFloat(el.dataset.duration) || 0,
        mediaStart: parseFloat(el.dataset.mediaStart) || 0,
        mediaDuration: parseFloat(el.dataset.mediaDuration) || Infinity,
      }));
      // NOTE: videos are NOT muted here — HyperFrames mixes their audio via data-volume.
      medias.forEach(m => { if (m.el.tagName === 'VIDEO') { m.el.playsInline = true; } });

      tl.eventCallback('onUpdate', () => {
        const t = tl.time();
        for (const m of medias) {
          const local = t - m.start;
          if (local >= 0 && local < m.duration) {
            // Clamp to actual media length so the overlap tail freezes on the
            // last frame instead of jumping past the source.
            const target = Math.min(m.mediaStart + local, m.mediaStart + m.mediaDuration - 0.04);
            if (Math.abs(m.el.currentTime - target) > 0.04) {
              try { m.el.currentTime = target; } catch (_) {}
            }
          } else if (local < 0) {
            if (m.el.currentTime !== m.mediaStart) {
              try { m.el.currentTime = m.mediaStart; } catch (_) {}
            }
          }
        }
      });
    })();

    window.__timelines["${compositionId}"] = tl;
  `.trim();
}

// ---------------------------------------------------------------------------
// L1 timeline: sequential IMAGES, each with an OST (on-screen text) overlay.
// Input shape:
//   {
//     "type": "L1",
//     "id": "optional-id",
//     "width": 1920, "height": 1080,
//     "sections": [
//       { "part1": "img1", "link": "https://s3/.../img1.jpg", "ost": "Text",
//         "duration": 4,
//         "imageAnimation": { "fadeIn": 0.5, "fadeOut": 0.5 },
//         "ostAnimation":   { "fadeIn": 0.5, "fadeOut": 0.5 } },
//       ...
//     ]
//   }
// Each image is shown back-to-back, fading in/out. OST overlays it.
// ---------------------------------------------------------------------------
// Phase 1: validate + parse L1 payload (no I/O).
function parseL1(payload) {
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  if (sections.length === 0) {
    throw new Error('L1 timeline requires a non-empty "sections" array');
  }

  const parsed = sections.map((section, idx) => {
    const partName = section.part1 || section.part || `part${idx + 1}`;
    if (!section.link) {
      throw new Error(`L1 section ${idx} ("${partName}") is missing "link"`);
    }
    // Default to 4s if not specified (images have no inherent duration).
    const duration = Number(section.duration) || 4;
    return {
      idx,
      partName,
      link: section.link,
      ost: section.ost || '',
      duration,
    };
  });

  return {
    _kind: 'L1',
    id: payload.id || `l1-${Date.now()}`,
    // Resolution is fixed at 1920x1080 for L1.
    width: 1920,
    height: 1080,
    background: payload.background || '#000000',
    sections: parsed,
  };
}

// Fixed defaults shared by all L1 sections (no per-section overrides).
const L1_IMAGE_ANIMATION = { fadeIn: 0.5, fadeOut: 0.5 };
const L1_OST_ANIMATION = { fadeIn: 0.5, fadeOut: 0.5 };

// Phase 2: download S3 videos locally + extract audio. Returns timeline data
// with local paths suitable for HyperFrames render (no remote seeking).
async function prepareL1Assets(jobDir, l1) {
  const assetsDir = path.join(jobDir, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  const clips = [];
  let cursor = 0;

  for (const s of l1.sections) {
    // Preserve the source file's extension (jpg/png/webp/etc.) so the browser
    // serves it with a sensible MIME type.
    let urlExt = '.jpg';
    try {
      const ext = path.extname(new URL(s.link).pathname).toLowerCase();
      if (ext) urlExt = ext;
    } catch (_) {}
    const imageRel = `assets/section-${s.idx}${urlExt}`;
    const imageAbs = path.join(jobDir, imageRel);

    console.log(`  [L1 section ${s.idx}] downloading via curl: ${s.link}`);
    await downloadToFile(s.link, imageAbs);

    // Each section gets its own track indices.
    const imageTrack = 100 + s.idx * 2;
    const ostTrack = imageTrack + 1;

    clips.push({
      id: `l1-image-${s.idx}`,
      type: 'image',
      content: imageRel,
      start: cursor,
      duration: s.duration,
      trackIndex: imageTrack,
      animation: L1_IMAGE_ANIMATION,
    });

    if (s.ost) {
      clips.push({
        id: `l1-ost-${s.idx}`,
        type: 'ost',
        content: s.ost,
        start: cursor,
        duration: s.duration,
        trackIndex: ostTrack,
        animation: L1_OST_ANIMATION,
      });
    }

    cursor += s.duration;
  }

  return {
    id: l1.id,
    duration: cursor,
    width: l1.width,
    height: l1.height,
    background: l1.background,
    intro: l1.intro || null,
    outro: l1.outro || null,
    clips,
  };
}

// Probe whether a local media file has an audio stream.
function probeHasAudio(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(false));
    proc.on('close', () => resolve(out.trim() === 'audio'));
  });
}

// Stitch [intro, main, outro] in order using a single ffmpeg pass.
// Normalizes each segment to width x height @ fps (cover-style — crops to fill,
// no bars). Pads silent audio for any segment lacking an audio track so concat
// stays in sync.
async function stitchSegments({ inputs, outputPath, width, height, fps = 30 }) {
  const probes = await Promise.all(inputs.map(async (p) => ({
    path: p,
    hasAudio: await probeHasAudio(p),
    duration: await probeMediaDuration(p),
  })));

  const needsSilent = probes.some(p => !p.hasAudio);

  const args = ['-y'];
  probes.forEach(({ path: p }) => args.push('-i', p));
  if (needsSilent) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }
  const silentIdx = probes.length; // only valid if needsSilent

  let filter = '';
  const concatPairs = [];
  probes.forEach((p, i) => {
    const v = `v${i}`;
    const a = `a${i}`;
    // cover-style scale + crop, then normalize SAR + fps
    filter += `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}[${v}];`;
    if (p.hasAudio) {
      filter += `[${i}:a]aresample=44100,aformat=channel_layouts=stereo[${a}];`;
    } else {
      filter += `[${silentIdx}:a]atrim=duration=${p.duration.toFixed(3)},asetpts=PTS-STARTPTS[${a}];`;
    }
    concatPairs.push(`[${v}][${a}]`);
  });
  filter += `${concatPairs.join('')}concat=n=${probes.length}:v=1:a=1[outv][outa]`;

  args.push(
    '-filter_complex', filter,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  );

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`ffmpeg stitch spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg stitch failed (code ${code}): ${stderr.slice(-600)}`));
    });
  });
}

// Probe a local media file with ffprobe and return its exact duration (seconds).
function probeMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`ffprobe failed to spawn: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${stderr.slice(-200)}`));
      const seconds = parseFloat(stdout.trim());
      if (!isFinite(seconds) || seconds <= 0) {
        return reject(new Error(`ffprobe returned invalid duration "${stdout.trim()}" for ${filePath}`));
      }
      resolve(seconds);
    });
  });
}

// Download a URL to a local file path using curl. Preserves the source video
// exactly — no re-encoding, no audio extraction, no quality loss.
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('curl', [
      '-fsSL',          // fail on HTTP error, silent, follow redirects
      '-o', destPath,
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`curl failed to spawn: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`curl exited ${code} for ${url}: ${stderr.slice(-300)}`));
    });
  });
}

function normalizeTimelineInput(payload) {
  let timelineData;
  // Bare array of sections -> treat as L1
  if (Array.isArray(payload)) {
    timelineData = parseL1({ type: 'L1', sections: payload });
  } else if (payload && typeof payload.type === 'string') {
    const type = payload.type.toUpperCase();
    if (type === 'L1') timelineData = parseL1(payload);
    else throw new Error(`Unsupported timeline type "${payload.type}". Supported: L1`);
  } else if (payload && Array.isArray(payload.sections)) {
    timelineData = parseL1({ ...payload, type: 'L1' });
  } else {
    timelineData = payload;
  }

  // Optional intro/outro stitch URLs applied to any timeline type.
  if (payload && !Array.isArray(payload)) {
    if (payload.intro) timelineData.intro = String(payload.intro);
    if (payload.outro) timelineData.outro = String(payload.outro);
  }
  return timelineData;
}

function generateCompositionHtml(timelineData) {
  const {
    id = 'main',
    duration = 10,
    width = 1920,
    height = 1080,
    background = '#000',
    clips = [],
    audio = null,
  } = timelineData;

  const clipsHtml = clips.map(buildClipHtml).join('\n      ');
  const audioHtml = audio
    ? `<audio id="track-audio" data-start="0" src="${audio}"></audio>`
    : '';
  const animScript = buildAnimationScript(clips, id);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: ${background};
        font-family: 'Geist', sans-serif;
      }
      .clip { opacity: 0; }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="${id}"
      data-start="0"
      data-duration="${duration}"
      data-width="${width}"
      data-height="${height}"
    >
      ${clipsHtml}
      ${audioHtml}
    </div>
    <script>
      ${animScript}
    </script>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Render job runner
// ---------------------------------------------------------------------------

function runRender(jobId, compositionPath, outputPath) {
  const job = jobs.get(jobId);

  const proc = spawn('bunx', [
    'hyperframes', 'render',
    '--output', outputPath,
    '--quality', process.env.RENDER_QUALITY || 'standard',
  ], { cwd: path.dirname(compositionPath) });

  proc.stdout?.on('data', (chunk) => {
    job.log += chunk.toString();
  });

  proc.stderr?.on('data', (chunk) => {
    job.log += chunk.toString();
  });

  proc.on('close', async (code) => {
    if (code !== 0) {
      job.status = 'failed';
      job.error = `Render process exited with code ${code}`;
      job.failedAt = new Date().toISOString();
      console.log(`[${jobId}] render failed`);
      return;
    }

    // Render OK. Decide whether we need to stitch intro/outro.
    if (!job.intro && !job.outro) {
      job.status = 'complete';
      job.outputPath = outputPath;
      job.completedAt = new Date().toISOString();
      console.log(`[${jobId}] render complete (no stitch)`);
      return;
    }

    job.status = 'stitching';
    console.log(`[${jobId}] stitching intro/outro...`);
    try {
      await stitchPhase(jobId, outputPath);
      job.status = 'complete';
      job.completedAt = new Date().toISOString();
      console.log(`[${jobId}] stitch complete`);
    } catch (err) {
      job.status = 'failed';
      job.error = `Stitch failed: ${err.message}`;
      job.failedAt = new Date().toISOString();
      console.error(`[${jobId}] stitch failed:`, err.message);
    }
  });
}

async function stitchPhase(jobId, hyperframesOutputPath) {
  const job = jobs.get(jobId);
  const stitchDir = path.join(job.compositionDir, 'stitch');
  await fs.mkdir(stitchDir, { recursive: true });

  const segments = [];
  if (job.intro) {
    const introPath = path.join(stitchDir, 'intro.mp4');
    console.log(`  [${jobId}] downloading intro: ${job.intro}`);
    await downloadToFile(job.intro, introPath);
    segments.push(introPath);
  }
  segments.push(hyperframesOutputPath);
  if (job.outro) {
    const outroPath = path.join(stitchDir, 'outro.mp4');
    console.log(`  [${jobId}] downloading outro: ${job.outro}`);
    await downloadToFile(job.outro, outroPath);
    segments.push(outroPath);
  }

  // The final stitched file replaces the hyperframes output at the same path
  // so downloadUrl keeps working. Write to a temp file first, then rename.
  const tmpOut = path.join(stitchDir, 'final.mp4');
  await stitchSegments({
    inputs: segments,
    outputPath: tmpOut,
    width: job.width || 1920,
    height: job.height || 1080,
    fps: 30,
  });
  await fs.rename(tmpOut, hyperframesOutputPath);
  job.outputPath = hyperframesOutputPath;
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notFound(message = 'Not found') {
  return jsonResponse({ error: message }, 404);
}

async function handleRender(req) {
  let rawPayload;
  try {
    rawPayload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  let timelineData;
  try {
    timelineData = normalizeTimelineInput(rawPayload);
  } catch (err) {
    return jsonResponse({ error: err.message }, 422);
  }

  if (!timelineData.id) {
    const receivedShape = Array.isArray(rawPayload)
      ? `array(len=${rawPayload.length})`
      : `object(keys=[${Object.keys(rawPayload || {}).join(', ')}])`;
    return jsonResponse({
      error: 'Field "id" is required, or send an L1 timeline (bare array of sections, or object with "sections":[...] or "type":"L1").',
      received: receivedShape,
    }, 422);
  }

  const timestamp = Date.now();
  const jobId = `${timelineData.id}-${timestamp}`;
  const compositionDir = path.join(JOBS_DIR, jobId);
  const compositionPath = path.join(compositionDir, 'index.html');
  const outputPath = path.join(RENDERS_DIR, `${jobId}.mp4`);

  await fs.mkdir(compositionDir, { recursive: true });

  // If this is an L1 timeline, download S3 videos locally + extract audio
  // BEFORE generating the composition HTML, so the HTML references local files
  // (no remote seeking during render = no stutter; audio mixed via <audio> tags).
  if (timelineData._kind === 'L1') {
    try {
      console.log(`[${jobId}] preparing L1 assets (downloads + audio extract)...`);
      timelineData = await prepareL1Assets(compositionDir, timelineData);
      console.log(`[${jobId}] L1 assets ready`);
    } catch (err) {
      console.error(`[${jobId}] asset prep failed:`, err.message);
      return jsonResponse({ error: `Asset preparation failed: ${err.message}` }, 502);
    }
  }

  await fs.writeFile(compositionPath, generateCompositionHtml(timelineData));

  // Copy hyperframes.json so the CLI can locate the project
  await fs.copyFile(
    path.join(__dirname, 'hyperframes.json'),
    path.join(compositionDir, 'hyperframes.json')
  );

  const origin = new URL(req.url).origin;
  const job = {
    jobId,
    status: 'rendering',
    compositionId: timelineData.id,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    failedAt: null,
    compositionDir,
    compositionPath,
    outputPath: null,
    plannedOutputPath: outputPath,
    intro: timelineData.intro || null,
    outro: timelineData.outro || null,
    width: timelineData.width || 1920,
    height: timelineData.height || 1080,
    error: null,
    log: '',
    downloadUrl: `${origin}/renders/${jobId}.mp4`,
    statusUrl: `${origin}/status/${jobId}`,
  };
  jobs.set(jobId, job);

  console.log(`[${jobId}] render started`);
  runRender(jobId, compositionPath, outputPath);

  return jsonResponse({
    jobId,
    status: job.status,
    compositionId: timelineData.id,
    createdAt: job.createdAt,
    statusUrl: job.statusUrl,
    downloadUrl: job.downloadUrl,
  }, 202);
}

// ---------------------------------------------------------------------------
// Static file serving (rendered MP4 download)
// ---------------------------------------------------------------------------
async function handleRenderDownload(fileName) {
  const safe = path.basename(fileName);
  const absPath = path.join(RENDERS_DIR, safe);
  try {
    const file = Bun.file(absPath);
    if (!(await file.exists())) return notFound(`File not found: ${safe}`);
    return new Response(file, { headers: { 'Content-Type': 'video/mp4' } });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function handleStatus(jobId) {
  const job = jobs.get(jobId);
  if (!job) return notFound(`Job "${jobId}" not found`);

  const { log, ...publicJob } = job;
  return jsonResponse(publicJob);
}

function handleHealth() {
  return jsonResponse({
    status: 'ok',
    activeJobs: [...jobs.values()].filter(j => j.status === 'rendering').length,
    totalJobs: jobs.size,
  });
}

function handleJobList() {
  const list = [...jobs.values()].map(({ log, ...j }) => j);
  return jsonResponse({ jobs: list });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname, method } = { pathname: url.pathname, method: req.method };

    if (pathname === '/health' && method === 'GET') return handleHealth();
    if (pathname === '/render' && method === 'POST') return handleRender(req);
    if (pathname === '/jobs' && method === 'GET') return handleJobList();

    const statusMatch = pathname.match(/^\/status\/(.+)$/);
    if (statusMatch && method === 'GET') return handleStatus(statusMatch[1]);

    const renderMatch = pathname.match(/^\/renders\/(.+)$/);
    if (renderMatch && method === 'GET') return handleRenderDownload(renderMatch[1]);

    return notFound('Unknown route. Available: POST /render, GET /status/:jobId, GET /renders/:file, GET /jobs, GET /health');
  },
});

console.log(`HyperFrames Rendering Server listening on http://localhost:${PORT}`);
console.log(`  POST /render               Submit timeline JSON; render starts immediately`);
console.log(`  GET  /renders/:file        Download rendered MP4`);
console.log(`  GET  /status/:jobId        Check render job status`);
console.log(`  GET  /jobs                 List all jobs`);
console.log(`  GET  /health               Server health`);
