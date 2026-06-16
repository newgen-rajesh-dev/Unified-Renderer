import { spawn } from 'child_process';

export function probeHasAudio(filePath) {
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

export function probeMediaDuration(filePath) {
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A single download attempt. Aborts if the connection/headers don't arrive
// within connectTimeoutMs, OR if the body stalls (no bytes for idleTimeoutMs).
// Streaming chunk-by-chunk is what makes the idle timeout actually fire — handing
// the whole response to Bun.write leaves a stalled body un-timed and hangs forever.
async function downloadOnce(url, destPath, { connectTimeoutMs, idleTimeoutMs }) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), connectTimeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const err = new Error(`download failed (${response.status}) for ${url}`);
      err.status = response.status;
      throw err;
    }
    if (!response.body) {
      throw new Error(`download returned no body for ${url}`);
    }

    const writer = Bun.file(destPath).writer();
    try {
      for await (const chunk of response.body) {
        clearTimeout(timer); // reset the idle clock on every chunk
        timer = setTimeout(() => controller.abort(), idleTimeoutMs);
        writer.write(chunk);
      }
      await writer.end();
    } catch (err) {
      try { await writer.end(); } catch {}
      throw err;
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      const stall = new Error(`download stalled (no data for ${Math.round(idleTimeoutMs / 1000)}s) for ${url}`);
      stall.retryable = true;
      throw stall;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(err) {
  if (err.retryable) return true;            // stalls
  if (err.status === undefined) return true; // network/connection errors (no HTTP status)
  // Transient server-side statuses are worth retrying; permanent 4xx (404/403/...) are not.
  return err.status === 429 || (err.status >= 500 && err.status <= 599);
}

export async function downloadToFile(
  url,
  destPath,
  {
    connectTimeoutMs = 30000,
    idleTimeoutMs = 30000,
    retries = 3,
    backoffMs = 1000,
    jobId = 'unknown',
    label = 'asset',
  } = {},
) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await downloadOnce(url, destPath, { connectTimeoutMs, idleTimeoutMs });
      if (attempt > 1) {
        console.log(`[DownloadRecovered][${jobId}] ${label} downloaded on attempt ${attempt}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isRetryable(err)) break;
      const wait = backoffMs * 2 ** (attempt - 1); // 1s, 2s, 4s, ...
      console.warn(
        `[DownloadRetry][${jobId}] ${label} attempt ${attempt}/${retries} failed (${err.message}); retrying in ${wait}ms`,
      );
      await sleep(wait);
    }
  }
  throw new Error(`download failed after ${retries} attempt(s) for ${url}: ${lastErr?.message || lastErr}`);
}

export async function reencodeForSeek(inputPath, { jobId = 'unknown', label = 'video' } = {}) {
  const tmpPath = inputPath + '.reenc.mp4';
  const args = [
    '-y',
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', process.env.FFMPEG_PRESET || 'veryfast',
    '-r', '30',
    '-g', '30',
    '-keyint_min', '30',
    '-movflags', '+faststart',
    '-c:a', 'copy',
    tmpPath,
  ];

  await new Promise((resolve, reject) => {
    console.log(`[ReencodeStarted][${jobId}] Re-encoding ${label} for dense keyframes`);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`ffmpeg reencode spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg reencode failed (code ${code}): ${stderr.slice(-600)}`));
    });
  });

  const { rename } = await import('fs/promises');
  await rename(tmpPath, inputPath);
  console.log(`[ReencodeCompleted][${jobId}] Re-encoded ${label} → dense keyframes applied`);
}

export async function stretchVideoToDuration(
  inputPath,
  outputPath,
  { sourceDuration, targetDuration, jobId = 'unknown', label = 'clip' } = {},
) {
  if (!sourceDuration || !targetDuration || sourceDuration <= 0 || targetDuration <= 0) {
    throw new Error(`Invalid stretch durations for ${label}`);
  }

  const factor = targetDuration / sourceDuration;
  const args = [
    '-y',
    '-i', inputPath,
    '-filter:v', `setpts=${factor.toFixed(6)}*PTS`,
    '-an',
    '-r', '30',
    '-g', '30',
    '-keyint_min', '30',
    '-c:v', 'libx264',
    '-preset', process.env.FFMPEG_PRESET || 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ];

  await new Promise((resolve, reject) => {
    console.log(`[ClipStretchStarted][${jobId}] Slowing ${label} from ${sourceDuration.toFixed(3)}s to ${targetDuration.toFixed(3)}s`);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`ffmpeg clip stretch spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg clip stretch failed (code ${code}): ${stderr.slice(-600)}`));
    });
  });

  console.log(`[ClipStretchCompleted][${jobId}] Slowed ${label} to match narration audio`);
}

export async function applyBackgroundMusic({
  inputVideoPath,
  musicPath,
  outputPath,
  fadeDuration = 2,
}) {
  const videoDuration = await probeMediaDuration(inputVideoPath);
  const hasAudio = await probeHasAudio(inputVideoPath);
  const fadeOutStart = Math.max(0, videoDuration - fadeDuration);
  const musicFilter = `[1:a]afade=t=in:st=0:d=${fadeDuration},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDuration}[bgm]`;
  const filter = hasAudio
    ? `${musicFilter};[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[aout]`
    : `${musicFilter};[bgm]atrim=duration=${videoDuration.toFixed(3)},asetpts=PTS-STARTPTS[aout]`;

  const args = [
    '-y',
    '-i', inputVideoPath,
    '-stream_loop', '-1',
    '-i', musicPath,
    '-filter_complex', filter,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`ffmpeg background music spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg background music failed (code ${code}): ${stderr.slice(-600)}`));
    });
  });
}
