import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, timingSafeEqual } from 'crypto';
import { runRender } from './common/render.js';
import { createJobStore } from './common/job-store.js';
import { createAssetCache } from './common/asset-cache.js';
import { generateCompositionHtml } from './common/composition-html.js';
import {
  normalizeTimelineInput as normalizeL3L4Input,
  prepareAssets as prepareL3L4Assets,
} from './strategies/l3l4/index.js';
import {
  normalizeTimelineInput as normalizeL1L2Input,
  prepareAssets as prepareL1L2Assets,
} from './strategies/l1l2/index.js';

function normalizeTimelineInput(payload) {
  if (!payload || Array.isArray(payload) || typeof payload.type !== 'string') {
    throw new Error('Missing required field "type". Supported values: "L1L2", "L3L4"');
  }

  const type = payload.type.toUpperCase();
  if (type === 'L1L2') {
    return normalizeL1L2Input(payload);
  }
  if (type === 'L3L4') {
    return normalizeL3L4Input(payload);
  }
  throw new Error(`Unsupported timeline type "${payload.type}". Supported values: "L1L2", "L3L4"`);
}

const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERS_DIR = path.join(__dirname, 'renders');
const JOBS_DIR = path.join(__dirname, '.jobs');
const ASSET_CACHE_DIR = path.join(__dirname, '.asset-cache');
const JOBS_DB_PATH = path.join(JOBS_DIR, 'jobs.sqlite');
const HYPERFRAMES_CONFIG = {
  $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
  registry: 'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry',
  paths: {
    blocks: 'compositions',
    components: 'compositions/components',
    assets: 'assets',
  },
};
const jobs = new Map();
const reservedRenderFileNames = new Set();

// Render concurrency pool. Renders are CPU/Chrome heavy; firing too many at once
// oversubscribes the box and Chrome calibration times out, leaving jobs hung
// with no callback. Cap concurrent renders and FIFO-queue the rest — a job that
// completes, fails, or times out frees its slot and the next queued job starts.
const MAX_CONCURRENT_RENDERS = Number(process.env.MAX_CONCURRENT_RENDERS) || 3;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS) || 20 * 60 * 1000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const RENDER_API_KEY = (process.env.RENDER_API_KEY || '').trim();
const renderQueue = [];
let activeRenders = 0;

await fs.mkdir(RENDERS_DIR, { recursive: true });
await fs.mkdir(JOBS_DIR, { recursive: true });
await fs.mkdir(ASSET_CACHE_DIR, { recursive: true });
const jobStore = createJobStore(JOBS_DB_PATH);
const assetCache = createAssetCache(ASSET_CACHE_DIR);

function jsonResponse(data, status = 200, req = null) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: jsonHeaders(req),
  });
}

function notFound(message = 'Not found') {
  return jsonResponse({ error: message }, 404);
}

function configuredCorsOrigins() {
  return CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
}

function isOriginAllowed(origin) {
  const allowedOrigins = configuredCorsOrigins();
  return allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin));
}

function corsHeaders(req = null) {
  const allowedOrigins = configuredCorsOrigins();
  const requestOrigin = req?.headers?.get('Origin') || '';
  const allowOrigin = allowedOrigins.includes('*')
    ? '*'
    : isOriginAllowed(requestOrigin) && requestOrigin
      ? requestOrigin
      : allowedOrigins[0] || '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Render-Api-Key',
    'Vary': 'Origin',
  };
}

function jsonHeaders(req = null) {
  return {
    'Content-Type': 'application/json',
    ...corsHeaders(req),
  };
}

function optionsResponse(req) {
  if (!isOriginAllowed(req.headers.get('Origin'))) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, req);
  }

  return new Response(null, {
    status: 204,
    headers: corsHeaders(req),
  });
}

function safeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function getRenderApiKey(req) {
  const authHeader = req.headers.get('Authorization') || '';
  const bearerToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearerToken || req.headers.get('X-Render-Api-Key')?.trim() || '';
}

function requireRenderApiKey(req) {
  if (!RENDER_API_KEY) {
    return jsonResponse({ error: 'RENDER_API_KEY is not configured on the renderer.' }, 503, req);
  }

  if (!safeStringEqual(getRenderApiKey(req), RENDER_API_KEY)) {
    return jsonResponse({ error: 'Unauthorized render request' }, 401, req);
  }

  return null;
}

function defaultOutputFileName(strategyName) {
  const date = new Date();
  const strategy = String(strategyName || 'render').toUpperCase();
  const hours24 = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const hours12 = String((hours24 % 12) || 12).padStart(2, '0');
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${hours12}-${minutes}-${seconds}${ampm}_${day}-${month}-${year}_${strategy}.mp4`;
}

function normalizeRequestedFileName(payload) {
  if (!Object.prototype.hasOwnProperty.call(payload || {}, 'filename')) return null;
  if (typeof payload.filename !== 'string' || !payload.filename.trim()) {
    throw new Error('Field "filename" must be a non-empty string when provided');
  }

  const requested = payload.filename.trim();
  if (/[<>:"/\\|?*\0-\x1F\x7F]/.test(requested)) {
    throw new Error('Field "filename" cannot contain path separators, control characters, or these characters: < > : " / \\ | ? *');
  }

  const fileName = /\.mp4$/i.test(requested)
    ? requested.replace(/\.mp4$/i, '.mp4')
    : `${requested}.mp4`;
  const stem = fileName.replace(/\.mp4$/i, '').trim();
  if (!stem || stem === '.' || stem === '..') {
    throw new Error('Field "filename" must include a usable file name before the .mp4 extension');
  }
  if (Buffer.byteLength(fileName, 'utf8') > 240) {
    throw new Error('Field "filename" is too long; use 240 bytes or fewer including the .mp4 extension');
  }

  return fileName;
}

export async function buildUniqueOutputPath(strategyName, rendersDir, requestedFileName = null) {
  const baseName = requestedFileName || defaultOutputFileName(strategyName);
  let suffix = 1;
  while (true) {
    const fileName = suffix === 1 ? baseName : baseName.replace(/\.mp4$/i, `_${suffix}.mp4`);
    const candidate = path.join(rendersDir, fileName);
    if (reservedRenderFileNames.has(fileName)) {
      suffix += 1;
      continue;
    }

    try {
      await fs.access(candidate);
      suffix += 1;
    } catch {
      reservedRenderFileNames.add(fileName);
      return { outputPath: candidate, fileName };
    }
  }
}

async function handleRender(req) {
  const authError = requireRenderApiKey(req);
  if (authError) return authError;

  console.log('[PayloadReceived][pending] JSON payload received on POST /render');
  let rawPayload;
  try {
    rawPayload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, req);
  }

  let timelineData;
  try {
    timelineData = normalizeTimelineInput(rawPayload);
  } catch (err) {
    return jsonResponse({ error: err.message }, 422, req);
  }

  if (!timelineData.id) {
    const receivedShape = Array.isArray(rawPayload)
      ? `array(len=${rawPayload.length})`
      : `object(keys=[${Object.keys(rawPayload || {}).join(', ')}])`;
    return jsonResponse({
      error: 'Field "id" is required, or send a strategy payload with "scenes":[...].',
      received: receivedShape,
    }, 422, req);
  }

  const callbackUrl =
    typeof rawPayload?.callbackUrl === 'string' && rawPayload.callbackUrl.trim()
      ? rawPayload.callbackUrl.trim()
      : null;
  if (!callbackUrl) {
    return jsonResponse({
      error: 'Field "callbackUrl" is required. The renderer accepts the job and POSTs the result to this URL when done.',
    }, 422, req);
  }

  // Opaque correlation id supplied by the caller. The renderer does not
  // interpret it — it is echoed back in the callback (alongside `type`) so the
  // caller can route the result to the right record (project id / script id).
  const callbackId =
    typeof rawPayload?.callbackId === 'string' && rawPayload.callbackId.trim()
      ? rawPayload.callbackId.trim()
      : null;

  let requestedFileName;
  try {
    requestedFileName = normalizeRequestedFileName(rawPayload);
  } catch (err) {
    return jsonResponse({ error: err.message }, 422, req);
  }

  const jobId = `${timelineData.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  console.log(`[PayloadReceived][${jobId}] JSON payload parsed and accepted`);
  const compositionDir = path.join(JOBS_DIR, jobId);
  const compositionPath = path.join(compositionDir, 'index.html');
  const artifactsDir = path.join(compositionDir, 'artifacts');
  const mainArtifactPath = path.join(artifactsDir, 'main.mp4');
  const finalArtifactPath = path.join(artifactsDir, 'final.mp4');
  const strategyName = timelineData._kind || 'render';

  const job = {
    jobId,
    status: 'preparing_assets',
    compositionId: timelineData.id,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    compositionDir,
    artifactsDir,
    compositionPath,
    outputPath: null,
    plannedOutputPath: null,
    reservedOutputFileName: null,
    requestedFileName,
    uploadedUrl: null,
    uploadedKey: null,
    mainArtifactPath,
    finalArtifactPath,
    strategyName,
    bgMusic: timelineData.bgMusic || null,
    width: timelineData.width || 1920,
    height: timelineData.height || 1080,
    error: null,
    log: '',
    statusUrl: `${new URL(req.url).origin}/status/${jobId}`,
    callbackUrl,
    callbackId,
  };
  jobs.set(jobId, job);
  jobStore.save(job);

  // Accept the job and return immediately with the job id. The render runs in
  // the background (subject to the concurrency pool) and the final result is
  // POSTed to the callbackUrl. This decouples the long render from the caller's
  // HTTP connection — a dropped connection no longer loses the result.
  scheduleRender({
    jobId,
    timelineData,
    compositionDir,
    artifactsDir,
    compositionPath,
    mainArtifactPath,
  });

  return jsonResponse({
    jobId,
    status: 'rendering',
    accepted: true,
    compositionId: job.compositionId,
    createdAt: job.createdAt,
    statusUrl: job.statusUrl,
    requestedFileName: job.requestedFileName,
  }, 202, req);
}

async function startJobPipeline({ jobId, timelineData, compositionDir, artifactsDir, compositionPath, mainArtifactPath }) {
  const job = jobs.get(jobId);
  try {
    await fs.mkdir(compositionDir, { recursive: true });
    await fs.mkdir(artifactsDir, { recursive: true });

    if (timelineData._kind === 'L3L4') {
      timelineData = await prepareL3L4Assets(compositionDir, timelineData, jobId, assetCache);
    } else if (timelineData._kind === 'L1L2') {
      timelineData = await prepareL1L2Assets(compositionDir, timelineData, jobId, assetCache);
    }

    await fs.writeFile(compositionPath, generateCompositionHtml(timelineData));
    await fs.writeFile(
      path.join(compositionDir, 'hyperframes.json'),
      JSON.stringify(HYPERFRAMES_CONFIG, null, 2),
    );

    job.status = 'rendering';
    job.startedAt = new Date().toISOString();
    jobStore.save(job);
    return await runRender(jobId, compositionPath, mainArtifactPath, jobs, jobStore, {
      rendersDir: RENDERS_DIR,
      buildUniqueOutputPath,
      assetCache,
    });
  } catch (err) {
    job.status = 'failed';
    job.error = `Job preparation failed: ${err.message}`;
    job.failedAt = new Date().toISOString();
    jobStore.save(job);
    console.error(`[JobPreparationFailed][${jobId}] Job preparation failed: ${err.message}`);
    return job;
  }
}

// Enqueue a job and try to start it. Returns nothing — the result is delivered
// asynchronously via the callbackUrl once a slot frees and the job finishes.
function scheduleRender(pipelineArgs) {
  renderQueue.push(pipelineArgs);
  pumpRenderQueue();
}

// Start queued jobs until the concurrency cap is reached. Each job's slot is
// released in `finally`, so a crash/throw can never leak a slot, and the next
// queued job is pumped immediately.
function pumpRenderQueue() {
  while (activeRenders < MAX_CONCURRENT_RENDERS && renderQueue.length > 0) {
    const pipelineArgs = renderQueue.shift();
    activeRenders += 1;
    runJobWithTimeout(pipelineArgs)
      .catch((err) => {
        console.error(`[JobPipelineCrashed][${pipelineArgs.jobId}] ${err?.message || err}`);
      })
      .finally(() => {
        activeRenders -= 1;
        pumpRenderQueue();
      });
  }
}

// Run one job's pipeline with a hard backstop timeout so a hang anywhere (asset
// prep, render, or publish) can never hold a pool slot forever. On timeout the
// job is marked failed; the terminal result (complete or failed) is always
// delivered to the caller's callback.
async function runJobWithTimeout(pipelineArgs) {
  const { jobId } = pipelineArgs;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      const job = jobs.get(jobId);
      if (job && job.status !== 'complete' && job.status !== 'failed') {
        job.status = 'failed';
        job.error = `Job timed out after ${JOB_TIMEOUT_MS}ms`;
        job.failedAt = new Date().toISOString();
        jobStore.save(job);
        console.error(`[JobTimeout][${jobId}] Job exceeded ${JOB_TIMEOUT_MS}ms — marked failed`);
      }
      resolve(job);
    }, JOB_TIMEOUT_MS);
  });
  const completedJob = await Promise.race([startJobPipeline(pipelineArgs), timeout]);
  clearTimeout(timer);
  await deliverCallback(completedJob);
}

// Deliver the terminal job result (complete or failed) to the caller-supplied
// callbackUrl. Fire-and-forget, single attempt, no retries — the caller asked
// for a no-retry contract and the result is also durably available via S3 and
// GET /status/:jobId as a backstop. Never throws.
async function deliverCallback(job) {
  if (!job?.callbackUrl) return;
  const body = {
    type: job.strategyName, // 'L1L2' | 'L3L4' — which flow, for the caller to route on
    callbackId: job.callbackId || null, // echoed correlation id (project id / script id)
    jobId: job.jobId,
    compositionId: job.compositionId,
    status: job.status, // 'complete' | 'failed'
    uploadedUrl: job.uploadedUrl || null,
    uploadedKey: job.uploadedKey || null,
    fileName: job.reservedOutputFileName || null,
    statusUrl: job.statusUrl || null,
    error: job.error || null,
    completedAt: job.completedAt || null,
    failedAt: job.failedAt || null,
  };
  try {
    const res = await fetch(job.callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    console.log(
      `[CallbackDelivered][${job.jobId}] POST ${job.callbackUrl} -> ${res.status} (status=${job.status})`,
    );
  } catch (err) {
    console.error(
      `[CallbackFailed][${job.jobId}] POST ${job.callbackUrl} failed: ${err?.message || err}`,
    );
  }
}

function handleStatus(jobId) {
  const job = jobs.get(jobId) || jobStore.getJob(jobId);
  if (!job) return notFound(`Job "${jobId}" not found`);
  const { log, ...publicJob } = job;
  return jsonResponse(publicJob);
}

function handleHealth() {
  const { activeJobs, totalJobs } = jobStore.stats();
  return jsonResponse({
    status: 'ok',
    activeJobs,
    totalJobs,
    activeRenders,
    queuedRenders: renderQueue.length,
    maxConcurrentRenders: MAX_CONCURRENT_RENDERS,
  });
}

function handleJobList() {
  return jsonResponse({ jobs: jobStore.listJobs() });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname, method } = { pathname: url.pathname, method: req.method };

    if (method === 'OPTIONS') return optionsResponse(req);

    if (pathname === '/health' && method === 'GET') return handleHealth();
    if (pathname === '/render' && method === 'POST') return handleRender(req);
    if (pathname === '/jobs' && method === 'GET') return handleJobList();

    const statusMatch = pathname.match(/^\/status\/(.+)$/);
    if (statusMatch && method === 'GET') return handleStatus(statusMatch[1]);

    return notFound('Unknown route. Available: POST /render, GET /status/:jobId, GET /jobs, GET /health');
  },
});

console.log(`HyperFrames Rendering Server listening on http://localhost:${PORT}`);
