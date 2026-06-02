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

export function downloadToFile(url, destPath, { timeoutMs = 120000 } = {}) {
  return (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`download failed (${response.status}) for ${url}`);
      }
      await Bun.write(destPath, response);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`download timed out after ${Math.round(timeoutMs / 1000)}s for ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  })();
}

export async function stitchSegments({
  inputs,
  outputPath,
  width,
  height,
  fps = 30,
  jobId = 'unknown',
  taskName = 'FfmpegStitch',
}) {
  const probes = await Promise.all(inputs.map(async (p) => ({
    path: p,
    hasAudio: await probeHasAudio(p),
    duration: await probeMediaDuration(p),
  })));

  const needsSilent = probes.some(p => !p.hasAudio);
  const args = ['-y'];
  probes.forEach(({ path: p }) => args.push('-i', p));
  if (needsSilent) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  const silentIdx = probes.length;

  let filter = '';
  const concatPairs = [];
  probes.forEach((p, i) => {
    const v = `v${i}`;
    const a = `a${i}`;
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
    '-c:v', 'libx264', '-preset', process.env.FFMPEG_PRESET || 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  );

  return new Promise((resolve, reject) => {
    console.log(`[${taskName}Started][${jobId}] Stitching ${inputs.length} segment(s) with ffmpeg`);
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let lastProgressLogAt = 0;
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      const match = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      const now = Date.now();
      if (match && now - lastProgressLogAt > 10000) {
        lastProgressLogAt = now;
        console.log(`[${taskName}Progress][${jobId}] ffmpeg time=${match[1]}`);
      }
    });
    proc.on('error', (err) => reject(new Error(`ffmpeg stitch spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`[${taskName}Completed][${jobId}] ffmpeg stitch completed`);
        return resolve();
      }
      reject(new Error(`ffmpeg stitch failed (code ${code}): ${stderr.slice(-600)}`));
    });
  });
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
