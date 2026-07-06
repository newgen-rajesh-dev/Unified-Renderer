import { promises as fs } from "fs";
import path from "path";
import {
  concatenateTimelineVideos,
  probeHasAudio,
  probeMediaDuration,
  reencodeForSeek,
} from "../../common/media.js";
import { OST_ANIMATION } from "../../common/ost-style.js";

const DEFAULT_BACKGROUND = "#000000";

function parseL3L4(payload) {
  if (!payload?.id) {
    throw new Error('Missing required field "id"');
  }

  const hasScenesKey = Object.prototype.hasOwnProperty.call(payload, "scenes");
  const scenes = hasScenesKey && Array.isArray(payload.scenes) ? payload.scenes : [];
  const hasTitleCard = Boolean(payload.titleCard);
  const hasKeyLearnings = Boolean(payload.keyLearnings);
  const hasRenderableMedia = Boolean(
    payload.intro || payload.outro || hasTitleCard || hasKeyLearnings || scenes.length > 0,
  );

  if (hasTitleCard && (typeof payload.titleCard !== "object" || Array.isArray(payload.titleCard))) {
    throw new Error('Invalid "titleCard": expected an object with "vidSrc" and "titleText"');
  }
  if (hasTitleCard && (!payload.titleCard.vidSrc || !payload.titleCard.titleText)) {
    throw new Error('Invalid "titleCard": provide both "vidSrc" and "titleText"');
  }
  if (hasKeyLearnings && (typeof payload.keyLearnings !== "object" || Array.isArray(payload.keyLearnings))) {
    throw new Error('Invalid "keyLearnings": expected an object with "vidSrc", "blue", "green", and four "points"');
  }
  if (
    hasKeyLearnings &&
    (!payload.keyLearnings.vidSrc ||
      !payload.keyLearnings.blue ||
      !payload.keyLearnings.green ||
      !Array.isArray(payload.keyLearnings.points) ||
      payload.keyLearnings.points.length !== 4 ||
      payload.keyLearnings.points.some((point) => typeof point !== "string" || !point.trim()))
  ) {
    throw new Error('Invalid "keyLearnings": provide "vidSrc", "blue", "green", and exactly four non-empty string "points"');
  }
  if (hasScenesKey && scenes.length === 0) {
    throw new Error('Invalid "scenes": expected a non-empty array when provided');
  }
  if (!hasRenderableMedia) {
    throw new Error(
      'Missing dependencies: provide at least one of "intro", "outro", "titleCard", "keyLearnings", or a non-empty "scenes" array. "logo" and "bgMusic" require renderable media.',
    );
  }

  const parsed = scenes.map((scene, idx) => {
    const partName = scene.part1 || scene.part || `part${idx + 1}`;
    if (!scene.link)
      throw new Error(`L3L4 scene ${idx} ("${partName}") is missing "link"`);
    const ost = typeof scene.ost === "string" ? scene.ost.trim() : "";
    return { idx, partName, link: scene.link, ost };
  });

  return {
    _kind: "L3L4",
    id: String(payload.id),
    width: 1920,
    height: 1080,
    background: DEFAULT_BACKGROUND,
    logo: payload.logo ? String(payload.logo) : null,
    bgMusic: payload.bgMusic ? String(payload.bgMusic) : null,
    intro: payload.intro ? String(payload.intro) : null,
    outro: payload.outro ? String(payload.outro) : null,
    titleCard: payload.titleCard
      ? {
          vidSrc: payload.titleCard.vidSrc
            ? String(payload.titleCard.vidSrc)
            : "",
          titleText: payload.titleCard.titleText
            ? String(payload.titleCard.titleText)
            : "",
        }
      : null,
    keyLearnings: payload.keyLearnings
      ? {
          vidSrc: String(payload.keyLearnings.vidSrc),
          blue: String(payload.keyLearnings.blue),
          green: String(payload.keyLearnings.green),
          points: payload.keyLearnings.points.map((point) => String(point).trim()),
        }
      : null,
    scenes: parsed,
  };
}

// Floor to 2 decimal places to prevent HyperFrames seeking past the last decoded
// frame (e.g. 5.789898 → 5.78), which causes a black screen at clip boundaries.
function truncateDuration(duration) {
  return Math.floor(duration * 100) / 100;
}

export async function prepareAssets(
  jobDir,
  l3l4,
  jobId = "unknown",
  assetCache = null,
) {
  if (!assetCache) {
    throw new Error("Asset cache is required for L3L4 asset preparation");
  }

  const assetsDir = path.join(jobDir, "assets");
  await fs.mkdir(assetsDir, { recursive: true });

  const clips = [];
  let logoRel = null;

  // --- Intro ---
  let introRelPath = null;
  let introDuration = 0;
  if (l3l4.intro) {
    const introRel = "assets/intro.mp4";
    const introAbs = path.join(jobDir, introRel);
    console.log(`[IntroDownloadStarted][${jobId}] Resolving intro video`);
    await assetCache.materialize(l3l4.intro, introAbs, {
      fallbackExt: ".mp4",
      jobId,
      label: "intro",
    });
    await reencodeForSeek(introAbs, { jobId, label: "intro" });
    const rawDuration = await probeMediaDuration(introAbs);
    introDuration = truncateDuration(rawDuration);
    introRelPath = introRel;
    console.log(
      `[IntroProbeCompleted][${jobId}] Probed intro duration=${rawDuration.toFixed(3)}s → truncated=${introDuration}s`,
    );
  }

  // --- Title card ---
  let titleCardRelPath = null;
  let titleCardDuration = 0;
  if (l3l4.titleCard?.vidSrc) {
    const titleVideoRel = "assets/title-card.mp4";
    const titleVideoAbs = path.join(jobDir, titleVideoRel);
    console.log(
      `[TitleCardDownloadStarted][${jobId}] Resolving title card source video`,
    );
    await assetCache.materialize(l3l4.titleCard.vidSrc, titleVideoAbs, {
      fallbackExt: ".mp4",
      jobId,
      label: "title-card",
    });
    await reencodeForSeek(titleVideoAbs, { jobId, label: "title-card" });
    const rawDuration = await probeMediaDuration(titleVideoAbs);
    titleCardDuration = truncateDuration(rawDuration);
    titleCardRelPath = titleVideoRel;
    console.log(
      `[TitleCardProbeCompleted][${jobId}] Probed title card duration=${rawDuration.toFixed(3)}s → truncated=${titleCardDuration}s`,
    );
  }

  // --- Key learnings ---
  let keyLearningsRelPath = null;
  let keyLearningsDuration = 0;
  if (l3l4.keyLearnings?.vidSrc) {
    const keyLearningsRel = "assets/key-learnings.mp4";
    const keyLearningsAbs = path.join(jobDir, keyLearningsRel);
    console.log(
      `[KeyLearningsDownloadStarted][${jobId}] Resolving key learnings source video`,
    );
    await assetCache.materialize(l3l4.keyLearnings.vidSrc, keyLearningsAbs, {
      fallbackExt: ".mp4",
      jobId,
      label: "key-learnings",
    });
    await reencodeForSeek(keyLearningsAbs, { jobId, label: "key-learnings" });
    const rawDuration = await probeMediaDuration(keyLearningsAbs);
    keyLearningsDuration = truncateDuration(rawDuration);
    keyLearningsRelPath = keyLearningsRel;
    console.log(
      `[KeyLearningsProbeCompleted][${jobId}] Probed key learnings duration=${rawDuration.toFixed(3)}s -> truncated=${keyLearningsDuration}s`,
    );
  }

  // --- Section videos ---
  const sectionVideos = [];
  for (const s of l3l4.scenes) {
    let urlExt = ".mp4";
    try {
      const ext = path.extname(new URL(s.link).pathname).toLowerCase();
      if (ext) urlExt = ext;
    } catch (_) {}
    const videoRel = `assets/section-${s.idx}${urlExt}`;
    const videoAbs = path.join(jobDir, videoRel);
    console.log(
      `[SectionDownloadStarted][${jobId}] Resolving section-${s.idx} source video`,
    );
    await assetCache.materialize(s.link, videoAbs, {
      fallbackExt: ".mp4",
      jobId,
      label: `section-${s.idx}`,
    });
    await reencodeForSeek(videoAbs, { jobId, label: `section-${s.idx}` });
    const rawDuration = await probeMediaDuration(videoAbs);
    const duration = truncateDuration(rawDuration);
    console.log(
      `[SectionProbeCompleted][${jobId}] Probed section-${s.idx} duration=${rawDuration.toFixed(3)}s → truncated=${duration}s`,
    );
    sectionVideos.push({ idx: s.idx, relPath: videoRel, duration, ost: s.ost });
  }

  // --- Outro ---
  let outroRelPath = null;
  let outroDuration = 0;
  if (l3l4.outro) {
    const outroRel = "assets/outro.mp4";
    const outroAbs = path.join(jobDir, outroRel);
    console.log(`[OutroDownloadStarted][${jobId}] Resolving outro video`);
    await assetCache.materialize(l3l4.outro, outroAbs, {
      fallbackExt: ".mp4",
      jobId,
      label: "outro",
    });
    await reencodeForSeek(outroAbs, { jobId, label: "outro" });
    const rawDuration = await probeMediaDuration(outroAbs);
    outroDuration = truncateDuration(rawDuration);
    outroRelPath = outroRel;
    console.log(
      `[OutroProbeCompleted][${jobId}] Probed outro duration=${rawDuration.toFixed(3)}s → truncated=${outroDuration}s`,
    );
  }

  // --- Logo ---
  if (l3l4.logo) {
    let imageExt = ".png";
    try {
      const ext = path
        .extname(new URL(l3l4.logo).pathname)
        .toLowerCase();
      if (ext) imageExt = ext;
    } catch (_) {}
    logoRel = `assets/logo${imageExt}`;
    await assetCache.materialize(
      l3l4.logo,
      path.join(jobDir, logoRel),
      {
        fallbackExt: ".png",
        jobId,
        label: "logo",
      },
    );
  }

  // --- Build clips ---
  // L3/L4 renders many adjacent video segments. HyperFrames injects extracted
  // still frames for each <video>; using one pre-concatenated visual base avoids
  // renderer-side video handoffs at segment boundaries. Original segment audio
  // is preserved as separate audio clips on the timeline.
  const VISUAL_TRACK_INDEX = 100;
  const AUDIO_TRACK_INDEX = 9000;
  const OST_TRACK_INDEX = 10000;
  const OVERLAY_TRACK_INDEX = 11000;
  const LOGO_TRACK_INDEX = 12000;

  const mainDuration = truncateDuration(
    titleCardDuration +
      sectionVideos.reduce((sum, v) => sum + v.duration, 0) +
      keyLearningsDuration,
  );
  const totalDuration = truncateDuration(introDuration + mainDuration + outroDuration);

  const visualSegments = [];
  const addVisualSegment = ({ id, relPath, duration, start }) => {
    if (!relPath || !duration) return;
    visualSegments.push({
      id,
      relPath,
      inputPath: path.join(jobDir, relPath),
      start,
      duration,
    });
  };

  addVisualSegment({ id: "intro", relPath: introRelPath, start: 0, duration: introDuration });

  // Title card + scenes (all offset by intro duration)
  let cursor = introDuration;

  if (titleCardRelPath) {
    addVisualSegment({ id: "title-card", relPath: titleCardRelPath, start: cursor, duration: titleCardDuration });
    clips.push({
      id: "l3l4-title-card-text",
      type: "titleText",
      content: l3l4.titleCard.titleText,
      start: cursor,
      duration: titleCardDuration,
      trackIndex: OVERLAY_TRACK_INDEX,
      animation: { fadeIn: 0.3, fadeOut: 0.3 },
    });
    cursor = truncateDuration(cursor + titleCardDuration);
  }

  for (let sectionIndex = 0; sectionIndex < sectionVideos.length; sectionIndex += 1) {
    const section = sectionVideos[sectionIndex];
    addVisualSegment({
      id: `section-${section.idx}`,
      relPath: section.relPath,
      start: cursor,
      duration: section.duration,
    });
    if (section.ost) {
      clips.push({
        id: `l3l4-ost-${section.idx}`,
        type: "ost",
        content: section.ost,
        start: cursor,
        duration: section.duration,
        trackIndex: OST_TRACK_INDEX,
        animation: OST_ANIMATION,
      });
    }
    cursor = truncateDuration(cursor + section.duration);
  }

  if (keyLearningsRelPath) {
    addVisualSegment({ id: "key-learnings", relPath: keyLearningsRelPath, start: cursor, duration: keyLearningsDuration });
    clips.push({
      id: "l3l4-key-learnings-overlay",
      type: "keyLearnings",
      content: l3l4.keyLearnings,
      start: cursor,
      duration: keyLearningsDuration,
      trackIndex: OVERLAY_TRACK_INDEX,
      animation: { fadeIn: 0.3, fadeOut: 0.3 },
    });
    cursor = truncateDuration(cursor + keyLearningsDuration);
  }

  addVisualSegment({
    id: "outro",
    relPath: outroRelPath,
    start: introDuration + mainDuration,
    duration: outroDuration,
  });

  if (visualSegments.length > 0) {
    const visualBaseRel = "assets/l3l4-visual-base.mp4";
    const visualBaseAbs = path.join(jobDir, visualBaseRel);
    await concatenateTimelineVideos(visualSegments, visualBaseAbs, {
      width: l3l4.width,
      height: l3l4.height,
      jobId,
      label: "l3l4-visual-base",
    });
    clips.unshift({
      id: "l3l4-visual-base-video",
      type: "video",
      content: visualBaseRel,
      start: 0,
      duration: totalDuration,
      mediaDuration: totalDuration,
      trackIndex: VISUAL_TRACK_INDEX,
      animation: { fadeIn: 0, fadeOut: 0 },
      hasAudio: false,
    });

    for (const segment of visualSegments) {
      if (await probeHasAudio(segment.inputPath)) {
        clips.push({
          id: `l3l4-${segment.id}-audio`,
          type: "audio",
          content: segment.relPath,
          start: segment.start,
          duration: segment.duration,
          mediaDuration: segment.duration,
          trackIndex: AUDIO_TRACK_INDEX,
        });
      }
    }
  }

  // Logo spans the full composition
  if (logoRel) {
    clips.push({
      id: "l3l4-logo",
      type: "topRightImage",
      content: logoRel,
      start: 0,
      duration: totalDuration,
      trackIndex: LOGO_TRACK_INDEX,
      animation: { fadeIn: 0, fadeOut: 0 },
    });
  }

  return {
    id: l3l4.id,
    duration: totalDuration,
    width: l3l4.width,
    height: l3l4.height,
    background: l3l4.background,
    bgMusic: l3l4.bgMusic || null,
    clips,
  };
}

export function normalizeTimelineInput(payload) {
  if (payload && typeof payload.type === "string" && payload.type.toUpperCase() === "L3L4") {
    return parseL3L4(payload);
  }

  throw new Error(
    `Unsupported timeline type "${payload?.type}". Supported value: "L3L4"`,
  );
}

