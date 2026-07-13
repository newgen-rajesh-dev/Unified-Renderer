import { promises as fs } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { downloadToFile } from './media.js';

const inFlightDownloads = new Map();

function hashUrl(url) {
  return createHash('sha256').update(url).digest('hex');
}

function extensionFromUrl(url, fallback = '.bin') {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ext || fallback;
  } catch {
    return fallback;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createAssetCache(cacheDir) {
  async function ensureCached(url, { fallbackExt = '.bin', jobId = 'unknown', label = 'asset' } = {}) {
    await fs.mkdir(cacheDir, { recursive: true });

    const key = hashUrl(url);
    const ext = extensionFromUrl(url, fallbackExt);
    const cachedPath = path.join(cacheDir, `${key}${ext}`);

    if (await exists(cachedPath)) {
      console.log(`[AssetCacheHit][${jobId}] Reusing cached ${label}`);
      return { cachedPath, cacheKey: key, cacheHit: true };
    }

    if (!inFlightDownloads.has(key)) {
      inFlightDownloads.set(key, (async () => {
        const tmpPath = path.join(cacheDir, `${key}.${randomUUID()}.tmp`);
        console.log(`[AssetCacheMiss][${jobId}] Downloading ${label} into cache`);
        try {
          await downloadToFile(url, tmpPath, { jobId, label });
          await fs.rename(tmpPath, cachedPath);
        } catch (err) {
          try {
            await fs.unlink(tmpPath);
          } catch {}
          throw err;
        }
      })().finally(() => {
        inFlightDownloads.delete(key);
      }));
    } else {
      console.log(`[AssetCacheWait][${jobId}] Waiting for cached ${label}`);
    }

    await inFlightDownloads.get(key);
    return { cachedPath, cacheKey: key, cacheHit: false };
  }

  async function materialize(url, destPath, options = {}) {
    const { cache = true, ...rest } = options;
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    // Per-video unique assets (scene media, narration) bypass the cache: they
    // are never reused across jobs, so caching only bloats .asset-cache/.
    if (!cache) {
      const { fallbackExt: _ignored, ...downloadOpts } = rest;
      await downloadToFile(url, destPath, downloadOpts);
      return { cachedPath: destPath, cacheKey: null, cacheHit: false, cached: false, destPath };
    }

    const cachedResult = await ensureCached(url, rest);
    await fs.copyFile(cachedResult.cachedPath, destPath);
    return { ...cachedResult, cached: true, destPath };
  }

  return { ensureCached, materialize };
}
