import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { runRender } from './common/render.js';
import { createJobStore } from './common/job-store.js';
import { createAssetCache } from './common/asset-cache.js';
import {
  normalizeTimelineInput,
  generateCompositionHtml,
  prepareAssets as prepareL3L4Assets,
} from './strategies/l3l4/index.js';

const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERS_DIR = path.join(__dirname, 'renders');
const JOBS_DIR = path.join(__dirname, '.jobs');
const ASSET_CACHE_DIR = path.join(__dirname, '.asset-cache');
const JOBS_DB_PATH = path.join(JOBS_DIR, 'jobs.sqlite');
const jobs = new Map();
const reservedRenderFileNames = new Set();

await fs.mkdir(RENDERS_DIR, { recursive: true });
await fs.mkdir(JOBS_DIR, { recursive: true });
await fs.mkdir(ASSET_CACHE_DIR, { recursive: true });
const jobStore = createJobStore(JOBS_DB_PATH);
const assetCache = createAssetCache(ASSET_CACHE_DIR);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: jsonHeaders(),
  });
}

function notFound(message = 'Not found') {
  return jsonResponse({ error: message }, 404);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
    ...corsHeaders(),
  };
}

function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function buildUniqueOutputPath(strategyName, rendersDir) {
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
  const baseName = `${hours12}-${minutes}-${seconds}${ampm}_${day}-${month}-${year}_${strategy}.mp4`;
  let suffix = 1;
  while (true) {
    const fileName = suffix === 1 ? baseName : baseName.replace(/\.mp4$/, `_${suffix}.mp4`);
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
  console.log('[PayloadReceived][pending] JSON payload received on POST /render');
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
      error: 'Field "id" is required, or send a strategy payload with "sections":[...].',
      received: receivedShape,
    }, 422);
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
    uploadedUrl: null,
    uploadedKey: null,
    mainArtifactPath,
    finalArtifactPath,
    strategyName,
    intro: timelineData.intro || null,
    outro: timelineData.outro || null,
    bgMusic: timelineData.bgMusic || null,
    width: timelineData.width || 1920,
    height: timelineData.height || 1080,
    error: null,
    log: '',
    statusUrl: `${new URL(req.url).origin}/status/${jobId}`,
  };
  jobs.set(jobId, job);
  jobStore.save(job);
  const completedJob = await startJobPipeline({
    jobId,
    timelineData,
    compositionDir,
    artifactsDir,
    compositionPath,
    mainArtifactPath,
  });

  if (completedJob.status === "failed") {
    return jsonResponse({
      jobId,
      status: completedJob.status,
      compositionId: completedJob.compositionId,
      createdAt: completedJob.createdAt,
      failedAt: completedJob.failedAt,
      error: completedJob.error,
      statusUrl: completedJob.statusUrl,
    }, 500);
  }

  return jsonResponse({
    jobId,
    status: completedJob.status,
    compositionId: completedJob.compositionId,
    createdAt: completedJob.createdAt,
    completedAt: completedJob.completedAt,
    uploadedUrl: completedJob.uploadedUrl,
    uploadedKey: completedJob.uploadedKey,
    statusUrl: completedJob.statusUrl,
  }, 200);
}

async function startJobPipeline({ jobId, timelineData, compositionDir, artifactsDir, compositionPath, mainArtifactPath }) {
  const job = jobs.get(jobId);
  try {
    await fs.mkdir(compositionDir, { recursive: true });
    await fs.mkdir(artifactsDir, { recursive: true });

    if (timelineData._kind === 'L3L4') {
      timelineData = await prepareL3L4Assets(compositionDir, timelineData, jobId, assetCache);
    }

    await fs.writeFile(compositionPath, generateCompositionHtml(timelineData));
    await fs.copyFile(path.join(__dirname, 'hyperframes.json'), path.join(compositionDir, 'hyperframes.json'));

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

async function handleRenderDownload(fileName) {
  const safe = path.basename(fileName);
  const absPath = path.join(RENDERS_DIR, safe);
  try {
    const file = Bun.file(absPath);
    if (!(await file.exists())) return notFound(`File not found: ${safe}`);
    return new Response(file, { headers: { 'Content-Type': 'video/mp4', ...corsHeaders() } });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
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

    if (method === 'OPTIONS') return optionsResponse();

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
