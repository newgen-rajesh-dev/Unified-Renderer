import { promises as fs } from "fs";
import path from "path";
import {
  concatenateTimelineVideos,
  probeHasAudio,
  probeMediaDuration,
  reencodeForSeek,
  stretchVideoToDuration,
} from "../../common/media.js";
import { OST_ANIMATION } from "../../common/ost-style.js";

const IMAGE_PAN_ENTER_RATIO = 0.28;
const IMAGE_PAN_MIN_HOLD_RATIO = 0.2;
const DEFAULT_BACKGROUND = "#000000";

function truncateDuration(duration) {
  return Math.floor(duration * 100) / 100;
}

function clampDuration(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function calculateImagePanTiming(sceneDuration) {
  if (sceneDuration <= 0) {
    return { panEnterDuration: 0, panExitDuration: 0 };
  }

  const minHold = Math.min(0.4, sceneDuration * IMAGE_PAN_MIN_HOLD_RATIO);
  const maxSingleMoveDuration = Math.max(0, (sceneDuration - minHold) / 2);
  const panDuration = Math.min(
    maxSingleMoveDuration,
    clampDuration(sceneDuration * IMAGE_PAN_ENTER_RATIO, 0.45, 2.4),
  );

  return {
    panEnterDuration: truncateDuration(panDuration),
    panExitDuration: truncateDuration(panDuration),
  };
}

function parseL1L2(payload) {
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
    if (!scene.link)
      throw new Error(`L1L2 scene ${idx} is missing "link"`);
    if (!scene.audio)
      throw new Error(`L1L2 scene ${idx} is missing "audio"`);
    const type = scene.type === "clip" ? "clip" : "image";
    const ost = typeof scene.ost === "string" ? scene.ost.trim() : "";
    return { idx, type, link: scene.link, audio: scene.audio, ost };
  });

  return {
    _kind: "L1L2",
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
          vidSrc: payload.titleCard.vidSrc ? String(payload.titleCard.vidSrc) : "",
          titleText: payload.titleCard.titleText ? String(payload.titleCard.titleText) : "",
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

export function normalizeTimelineInput(payload) {
  if (payload && typeof payload.type === "string" && payload.type.toUpperCase() === "L1L2") {
    return parseL1L2(payload);
  }
  throw new Error(`Unsupported type for L1L2 strategy: "${payload?.type}". Supported value: "L1L2"`);
}

export async function prepareAssets(
  jobDir,
  l1l2,
  jobId = "unknown",
  assetCache = null,
) {
  if (!assetCache)
    throw new Error("Asset cache is required for L1L2 asset preparation");

  const assetsDir = path.join(jobDir, "assets");
  await fs.mkdir(assetsDir, { recursive: true });

  const clips = [];
  let logoRel = null;

  // --- Intro ---
  let introRelPath = null;
  let introDuration = 0;
  if (l1l2.intro) {
    const introRel = "assets/intro.mp4";
    const introAbs = path.join(jobDir, introRel);
    console.log(`[IntroDownloadStarted][${jobId}] Resolving intro video`);
    await assetCache.materialize(l1l2.intro, introAbs, {
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
  if (l1l2.titleCard?.vidSrc) {
    const titleVideoRel = "assets/title-card.mp4";
    const titleVideoAbs = path.join(jobDir, titleVideoRel);
    console.log(
      `[TitleCardDownloadStarted][${jobId}] Resolving title card source video`,
    );
    await assetCache.materialize(l1l2.titleCard.vidSrc, titleVideoAbs, {
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
  if (l1l2.keyLearnings?.vidSrc) {
    const keyLearningsRel = "assets/key-learnings.mp4";
    const keyLearningsAbs = path.join(jobDir, keyLearningsRel);
    console.log(
      `[KeyLearningsDownloadStarted][${jobId}] Resolving key learnings source video`,
    );
    await assetCache.materialize(l1l2.keyLearnings.vidSrc, keyLearningsAbs, {
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

  // --- Scenes: image + narration audio ---
  // Duration of each scene is driven by its narration audio length.
  const scenes = [];
  for (const s of l1l2.scenes) {
    // Image (no probing needed — shown for audio duration)
    let imgExt = s.type === "clip" ? ".mp4" : ".jpg";
    try {
      const ext = path.extname(new URL(s.link).pathname).toLowerCase();
      if (ext) imgExt = ext;
    } catch (_) {}
    const imgRel =
      s.type === "clip"
        ? `assets/section-${s.idx}-clip-source${imgExt}`
        : `assets/section-${s.idx}-image${imgExt}`;
    const imgAbs = path.join(jobDir, imgRel);
    console.log(
      s.type === "clip"
        ? `[SectionClipDownloadStarted][${jobId}] Resolving section-${s.idx} clip video`
        : `[SectionImgDownloadStarted][${jobId}] Resolving section-${s.idx} image`,
    );
    await assetCache.materialize(s.link, imgAbs, {
      fallbackExt: s.type === "clip" ? ".mp4" : ".jpg",
      jobId,
      label: s.type === "clip" ? `section-${s.idx}-clip` : `section-${s.idx}-image`,
    });

    // Narration audio — probe determines scene duration (no reencode for audio)
    let audioExt = ".mp3";
    try {
      const ext = path.extname(new URL(s.audio).pathname).toLowerCase();
      if (ext) audioExt = ext;
    } catch (_) {}
    const audioRel = `assets/section-${s.idx}-audio${audioExt}`;
    const audioAbs = path.join(jobDir, audioRel);
    console.log(
      `[SectionAudioDownloadStarted][${jobId}] Resolving section-${s.idx} narration audio`,
    );
    await assetCache.materialize(s.audio, audioAbs, {
      fallbackExt: ".mp3",
      jobId,
      label: `section-${s.idx}-audio`,
    });
    const rawDuration = await probeMediaDuration(audioAbs);
    const duration = truncateDuration(rawDuration);
    console.log(
      `[SectionAudioProbeCompleted][${jobId}] Probed section-${s.idx} audio=${rawDuration.toFixed(3)}s → truncated=${duration}s`,
    );

    if (s.type === "clip") {
      const rawClipDuration = await probeMediaDuration(imgAbs);
      const clipDuration = truncateDuration(rawClipDuration);
      const clipRel = `assets/section-${s.idx}-clip.mp4`;
      const clipAbs = path.join(jobDir, clipRel);
      console.log(
        `[SectionClipProbeCompleted][${jobId}] Probed section-${s.idx} clip=${rawClipDuration.toFixed(3)}s -> truncated=${clipDuration}s`,
      );

      if (clipDuration < duration) {
        await stretchVideoToDuration(imgAbs, clipAbs, {
          sourceDuration: clipDuration,
          targetDuration: duration,
          jobId,
          label: `section-${s.idx}-clip`,
        });
      } else {
        await fs.copyFile(imgAbs, clipAbs);
        await reencodeForSeek(clipAbs, { jobId, label: `section-${s.idx}-clip` });
      }

      scenes.push({ idx: s.idx, type: "clip", clipRel, audioRel, duration, ost: s.ost });
      continue;
    }

    scenes.push({ idx: s.idx, type: "image", imgRel, audioRel, duration, ost: s.ost });
  }

  // --- Outro ---
  let outroRelPath = null;
  let outroDuration = 0;
  if (l1l2.outro) {
    const outroRel = "assets/outro.mp4";
    const outroAbs = path.join(jobDir, outroRel);
    console.log(`[OutroDownloadStarted][${jobId}] Resolving outro video`);
    await assetCache.materialize(l1l2.outro, outroAbs, {
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
  if (l1l2.logo) {
    let imageExt = ".png";
    try {
      const ext = path
        .extname(new URL(l1l2.logo).pathname)
        .toLowerCase();
      if (ext) imageExt = ext;
    } catch (_) {}
    logoRel = `assets/logo${imageExt}`;
    await assetCache.materialize(
      l1l2.logo,
      path.join(jobDir, logoRel),
      { fallbackExt: ".png", jobId, label: "logo" },
    );
  }

  // --- Build clips ---
  // Track layout:
  //   90  — intro video
  //   100 — title card video + section images (main content)
  //   110 — outro video
  //   150 — section narration audio
  //   160 — stitched-base embedded audio (intro/title/keyLearnings/outro)
  //   200 — OST chips
  //   250 — title card text overlay
  //   300 - logo image (full span)
  const EMBEDDED_AUDIO_TRACK = 160;

  // When every scene is a "clip", the main track is a run of adjacent <video>
  // segments. HyperFrames extracts still frames per <video> and hands off at
  // each boundary, producing black frames. Pre-concatenate all visual videos
  // into one base track spanning the whole composition to avoid the handoffs
  // (mirrors the L3/L4 strategy). Section narration stays on its own audio
  // track; intro/title/keyLearnings/outro embedded audio is re-added separately.
  const stitchVisualBase = scenes.length > 0 && scenes.every((s) => s.type === "clip");

  const visualSegments = [];
  const addVisualSegment = ({ id, relPath, duration, start, embedAudio = false }) => {
    if (!relPath || !duration) return;
    visualSegments.push({
      id,
      relPath,
      inputPath: path.join(jobDir, relPath),
      start,
      duration,
      embedAudio,
    });
  };

  const mainDuration = truncateDuration(
    titleCardDuration +
      scenes.reduce((sum, s) => sum + s.duration, 0) +
      keyLearningsDuration,
  );
  const totalDuration = truncateDuration(introDuration + mainDuration + outroDuration);

  // Intro
  if (introRelPath) {
    if (stitchVisualBase) {
      addVisualSegment({ id: "intro", relPath: introRelPath, start: 0, duration: introDuration, embedAudio: true });
    } else {
      clips.push({
        id: "l1l2-intro-video",
        type: "video",
        content: introRelPath,
        start: 0,
        duration: introDuration,
        mediaDuration: introDuration,
        trackIndex: 90,
        animation: { fadeIn: 0, fadeOut: 0 },
      });
    }
  }

  // Title card + scenes (offset by intro duration)
  let cursor = introDuration;

  if (titleCardRelPath) {
    if (stitchVisualBase) {
      addVisualSegment({ id: "title-card", relPath: titleCardRelPath, start: cursor, duration: titleCardDuration, embedAudio: true });
    } else {
      clips.push({
        id: "l1l2-title-card-video",
        type: "video",
        content: titleCardRelPath,
        start: cursor,
        duration: titleCardDuration,
        mediaDuration: titleCardDuration,
        trackIndex: 100,
        animation: { fadeIn: 0, fadeOut: 0 },
      });
    }
    clips.push({
      id: "l1l2-title-card-text",
      type: "titleText",
      content: l1l2.titleCard.titleText,
      start: cursor,
      duration: titleCardDuration,
      trackIndex: 250,
      animation: { fadeIn: 0.3, fadeOut: 0.3 },
    });
    cursor = truncateDuration(cursor + titleCardDuration);
  }

  for (const section of scenes) {
    if (section.type === "clip") {
      if (stitchVisualBase) {
        // Section clip audio is the separate narration below, not embedded.
        addVisualSegment({
          id: `section-${section.idx}`,
          relPath: section.clipRel,
          start: cursor,
          duration: section.duration,
          embedAudio: false,
        });
      } else {
        clips.push({
          id: `l1l2-section-${section.idx}-clip`,
          type: "video",
          content: section.clipRel,
          start: cursor,
          duration: section.duration,
          mediaDuration: section.duration,
          trackIndex: 100,
          animation: { fadeIn: 0, fadeOut: 0 },
          hasAudio: false,
        });
      }
    } else {
      const panTiming = calculateImagePanTiming(section.duration);
      clips.push({
        id: `l1l2-section-${section.idx}-image`,
        type: "image",
        content: section.imgRel,
        start: cursor,
        duration: section.duration,
        trackIndex: 100,
        animation: { fadeIn: 0, fadeOut: 0 },
        pan: true,
        ...panTiming,
      });
    }
    // Narration audio
    clips.push({
      id: `l1l2-section-${section.idx}-audio`,
      type: "audio",
      content: section.audioRel,
      start: cursor,
      duration: section.duration,
      mediaDuration: section.duration,
      trackIndex: 150,
    });
    // OST
    if (section.ost) {
      clips.push({
        id: `l1l2-ost-${section.idx}`,
        type: "ost",
        content: section.ost,
        start: cursor,
        duration: section.duration,
        trackIndex: 200,
        animation: OST_ANIMATION,
      });
    }
    cursor = truncateDuration(cursor + section.duration);
  }

  if (keyLearningsRelPath) {
    if (stitchVisualBase) {
      addVisualSegment({ id: "key-learnings", relPath: keyLearningsRelPath, start: cursor, duration: keyLearningsDuration, embedAudio: true });
    } else {
      clips.push({
        id: "l1l2-key-learnings-video",
        type: "video",
        content: keyLearningsRelPath,
        start: cursor,
        duration: keyLearningsDuration,
        mediaDuration: keyLearningsDuration,
        trackIndex: 100,
        animation: { fadeIn: 0, fadeOut: 0 },
      });
    }
    clips.push({
      id: "l1l2-key-learnings-overlay",
      type: "keyLearnings",
      content: l1l2.keyLearnings,
      start: cursor,
      duration: keyLearningsDuration,
      trackIndex: 250,
      animation: { fadeIn: 0.3, fadeOut: 0.3 },
    });
    cursor = truncateDuration(cursor + keyLearningsDuration);
  }

  // Outro
  if (outroRelPath) {
    if (stitchVisualBase) {
      addVisualSegment({
        id: "outro",
        relPath: outroRelPath,
        start: introDuration + mainDuration,
        duration: outroDuration,
        embedAudio: true,
      });
    } else {
      clips.push({
        id: "l1l2-outro-video",
        type: "video",
        content: outroRelPath,
        start: introDuration + mainDuration,
        duration: outroDuration,
        mediaDuration: outroDuration,
        trackIndex: 110,
        animation: { fadeIn: 0, fadeOut: 0 },
      });
    }
  }

  // All scenes are clips → concatenate the visual timeline into one base track
  // spanning the whole composition, then re-add embedded audio for the
  // non-scene segments (section narration is already on track 150).
  if (stitchVisualBase && visualSegments.length > 0) {
    const visualBaseRel = "assets/l1l2-visual-base.mp4";
    const visualBaseAbs = path.join(jobDir, visualBaseRel);
    await concatenateTimelineVideos(visualSegments, visualBaseAbs, {
      width: l1l2.width,
      height: l1l2.height,
      jobId,
      label: "l1l2-visual-base",
    });
    clips.unshift({
      id: "l1l2-visual-base-video",
      type: "video",
      content: visualBaseRel,
      start: 0,
      duration: totalDuration,
      mediaDuration: totalDuration,
      trackIndex: 100,
      animation: { fadeIn: 0, fadeOut: 0 },
      hasAudio: false,
    });

    for (const segment of visualSegments) {
      if (segment.embedAudio && (await probeHasAudio(segment.inputPath))) {
        clips.push({
          id: `l1l2-${segment.id}-audio`,
          type: "audio",
          content: segment.relPath,
          start: segment.start,
          duration: segment.duration,
          mediaDuration: segment.duration,
          trackIndex: EMBEDDED_AUDIO_TRACK,
        });
      }
    }
  }

  // Logo spans full composition
  if (logoRel) {
    clips.push({
      id: "l1l2-logo",
      type: "topRightImage",
      content: logoRel,
      start: 0,
      duration: totalDuration,
      trackIndex: 300,
      animation: { fadeIn: 0, fadeOut: 0 },
    });
  }

  return {
    id: l1l2.id,
    duration: totalDuration,
    width: l1l2.width,
    height: l1l2.height,
    background: l1l2.background,
    bgMusic: l1l2.bgMusic || null,
    clips,
  };
}
