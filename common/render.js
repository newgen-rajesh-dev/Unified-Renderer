import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import { applyBackgroundMusic, downloadToFile } from "./media.js";
import { uploadVideoToS3 } from "./s3-upload.js";

export function runRender(
  jobId,
  compositionPath,
  mainArtifactPath,
  jobs,
  jobStore,
  publishConfig,
) {
  const job = jobs.get(jobId);
  const RENDER_TIMEOUT_MS =
    Number(process.env.RENDER_TIMEOUT_MS) || 15 * 60 * 1000;

  return new Promise((resolve) => {
    let settled = false;
    // `detached: true` makes the child a process-group leader so a hang can be
    // killed as a group (HyperFrames spawns its own Chrome/ffmpeg children).
    const proc = spawn(
      "bun",
      [
        "run",
        "hyperframes",
        "render",
        path.dirname(compositionPath),
        "--output",
        mainArtifactPath,
        "--quality",
        process.env.RENDER_QUALITY || "standard",
      ],
      { cwd: process.cwd(), detached: true },
    );

    const finish = (resolvedJob) => {
      if (settled) return;
      settled = true;
      clearTimeout(renderTimer);
      resolve(resolvedJob);
    };

    // Kill a render that hangs (e.g. Chrome calibration wedged under load) so it
    // can't hold a pool slot forever or leave an orphaned process eating CPU.
    const renderTimer = setTimeout(() => {
      console.error(
        `[RenderTimeout][${jobId}] Render exceeded ${RENDER_TIMEOUT_MS}ms — killing process group`,
      );
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
      job.status = "failed";
      job.error = `Render timed out after ${RENDER_TIMEOUT_MS}ms`;
      job.failedAt = new Date().toISOString();
      jobStore?.save(job);
      finish(job);
    }, RENDER_TIMEOUT_MS);

    proc.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      job.log += text;
      logProcessOutput("HyperFramesStdout", jobId, text);
    });
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      job.log += text;
      logProcessOutput("HyperFramesStderr", jobId, text);
    });

    proc.on("error", (err) => {
      job.status = "failed";
      job.error = `Render process error: ${err.message}`;
      job.failedAt = new Date().toISOString();
      jobStore?.save(job);
      console.error(`[RenderProcessError][${jobId}] ${err.message}`);
      finish(job);
    });

    proc.on("close", async (code) => {
      if (settled) return;
      if (code !== 0) {
        job.status = "failed";
        job.error = `Render process exited with code ${code}`;
        job.failedAt = new Date().toISOString();
        jobStore?.save(job);
        console.log(`[RenderFailed][${jobId}] Render process failed`);
        finish(job);
        return;
      }

      try {
        const { outputPath: publishPath, fileName } =
          await publishConfig.buildUniqueOutputPath(
            job.strategyName,
            publishConfig.rendersDir,
          );
        const finalSourcePath = await applyBgMusicIfNeeded(
          jobId,
          mainArtifactPath,
          jobs,
          jobStore,
          publishConfig.assetCache,
        );
        await publishFinal(jobId, finalSourcePath, publishPath, jobs);
        job.plannedOutputPath = publishPath;
        job.reservedOutputFileName = fileName;
        await uploadCompletedVideo(
          jobId,
          publishPath,
          fileName,
          jobs,
          jobStore,
        );
        job.status = "complete";
        job.completedAt = new Date().toISOString();
        jobStore?.save(job);
        await cleanupCompletedJobWorkspace(jobId, jobs);
        console.log(
          `[VideoProductionCompleted][${jobId}] Video production completed`,
        );
      } catch (err) {
        job.status = "failed";
        job.error = `Publish failed: ${err.message}`;
        job.failedAt = new Date().toISOString();
        jobStore?.save(job);
        console.error(
          `[PublishFailed][${jobId}] Publish failed: ${err.message}`,
        );
      }
      finish(job);
    });
  });
}

function logProcessOutput(taskName, jobId, text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) console.log(`[${taskName}][${jobId}] ${trimmed}`);
  }
}

async function materializeAsset(
  assetCache,
  url,
  destPath,
  jobId,
  label,
  fallbackExt = ".mp4",
) {
  if (assetCache) {
    await assetCache.materialize(url, destPath, {
      fallbackExt,
      jobId,
      label,
    });
    return;
  }
  await downloadToFile(url, destPath);
}

async function applyBgMusicIfNeeded(
  jobId,
  inputVideoPath,
  jobs,
  jobStore,
  assetCache,
) {
  const job = jobs.get(jobId);
  if (!job?.bgMusic) return inputVideoPath;

  job.status = "applying_bg_music";
  jobStore?.save(job);
  console.log(`[BackgroundMusicStarted][${jobId}] Applying background music`);

  const bgMusicPath = path.join(job.artifactsDir, "background-music");
  await materializeAsset(
    assetCache,
    job.bgMusic,
    bgMusicPath,
    jobId,
    "background-music",
    ".mp3",
  );

  const bgOutputPath = path.join(job.artifactsDir, "final-with-bg-music.mp4");
  await applyBackgroundMusic({
    inputVideoPath,
    musicPath: bgMusicPath,
    outputPath: bgOutputPath,
    fadeDuration: 2,
  });

  console.log(`[BackgroundMusicCompleted][${jobId}] Background music applied`);
  return bgOutputPath;
}

async function publishFinal(jobId, sourcePath, publishPath, jobs) {
  const job = jobs.get(jobId);
  await fs.copyFile(sourcePath, publishPath);
  job.outputPath = publishPath;
}

async function uploadCompletedVideo(
  jobId,
  publishPath,
  fileName,
  jobs,
  jobStore,
) {
  const job = jobs.get(jobId);
  job.status = "uploading";
  jobStore?.save(job);
  console.log(`[UploadStarted][${jobId}] Uploading completed video`);

  const uploaded = await uploadVideoToS3(publishPath, {
    fileName,
    jobId,
  });
  job.uploadedUrl = uploaded.url;
  job.uploadedKey = uploaded.key;
  jobStore?.save(job);
  console.log(`[UploadCompleted][${jobId}] Completed video uploaded`);
}

async function cleanupCompletedJobWorkspace(jobId, jobs) {
  const job = jobs.get(jobId);
  if (!job?.compositionDir) return;

  try {
    await fs.rm(job.compositionDir, { recursive: true, force: true });
    console.log(
      `[JobWorkspaceDeleted][${jobId}] Completed job workspace deleted`,
    );
  } catch (err) {
    console.error(
      `[JobWorkspaceDeleteFailed][${jobId}] Failed to delete completed job workspace: ${err.message}`,
    );
  }
}
