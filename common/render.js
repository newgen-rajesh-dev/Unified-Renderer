import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import {
  applyBackgroundMusic,
  downloadToFile,
  stitchSegments,
} from "./media.js";
import { uploadVideoToUploadThing } from "./uploadthing.js";

export function runRender(
  jobId,
  compositionPath,
  mainArtifactPath,
  jobs,
  jobStore,
  publishConfig,
) {
  const job = jobs.get(jobId);

  return new Promise((resolve) => {
    const proc = spawn(
      "bunx",
      [
        "hyperframes",
        "render",
        "--output",
        mainArtifactPath,
        "--quality",
        process.env.RENDER_QUALITY || "standard",
      ],
      { cwd: path.dirname(compositionPath) },
    );

    proc.stdout?.on("data", (chunk) => {
      job.log += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      job.log += chunk.toString();
    });

    proc.on("close", async (code) => {
      if (code !== 0) {
        job.status = "failed";
        job.error = `Render process exited with code ${code}`;
        job.failedAt = new Date().toISOString();
        jobStore?.save(job);
        console.log(`[RenderFailed][${jobId}] Render process failed`);
        resolve(job);
        return;
      }

      if (!job.intro && !job.outro) {
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
        resolve(job);
        return;
      }

      job.status = "stitching";
      jobStore?.save(job);
      console.log(
        `[StitchingIntroOutro][${jobId}] Stitching intro/outro started`,
      );
      try {
        await stitchPhase(
          jobId,
          mainArtifactPath,
          jobs,
          publishConfig.assetCache,
        );
        const { outputPath: publishPath, fileName } =
          await publishConfig.buildUniqueOutputPath(
            job.strategyName,
            publishConfig.rendersDir,
          );
        const finalSourcePath = await applyBgMusicIfNeeded(
          jobId,
          job.finalArtifactPath,
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
        job.error = `Stitch failed: ${err.message}`;
        job.failedAt = new Date().toISOString();
        jobStore?.save(job);
        console.error(`[StitchFailed][${jobId}] Stitch failed: ${err.message}`);
      }
      resolve(job);
    });
  });
}

async function stitchPhase(jobId, hyperframesOutputPath, jobs, assetCache) {
  const job = jobs.get(jobId);
  const stitchDir = path.join(job.compositionDir, "stitch");
  await fs.mkdir(stitchDir, { recursive: true });

  const segments = [];
  if (job.intro) {
    const introPath = path.join(stitchDir, "intro.mp4");
    await materializeStitchAsset(
      assetCache,
      job.intro,
      introPath,
      jobId,
      "intro",
    );
    segments.push(introPath);
  }
  segments.push(hyperframesOutputPath);
  if (job.outro) {
    const outroPath = path.join(stitchDir, "outro.mp4");
    await materializeStitchAsset(
      assetCache,
      job.outro,
      outroPath,
      jobId,
      "outro",
    );
    segments.push(outroPath);
  }

  const tmpOut = path.join(stitchDir, "final.mp4");
  await stitchSegments({
    inputs: segments,
    outputPath: tmpOut,
    width: job.width || 1920,
    height: job.height || 1080,
    fps: 30,
  });
  await fs.copyFile(tmpOut, job.finalArtifactPath);
}

async function materializeStitchAsset(
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
  await materializeStitchAsset(
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
    volume: 0.5,
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

  const uploaded = await uploadVideoToUploadThing(publishPath, {
    fileName,
    jobId,
  });
  job.uploadedUrl = uploaded.ufsUrl || uploaded.url;
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
