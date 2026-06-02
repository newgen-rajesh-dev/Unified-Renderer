import { promises as fs } from "fs";
import path from "path";
import { probeMediaDuration, reencodeForSeek } from "../../common/media.js";

const OST_ANIMATION = { fadeIn: 0.5, fadeOut: 0.5 };
const ENABLE_TOP_RIGHT_OVERLAY = true;

function truncateDuration(duration) {
  return Math.floor(duration * 100) / 100;
}

function parseL1L2(payload) {
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  if (sections.length === 0)
    throw new Error('L1L2 timeline requires a non-empty "sections" array');

  const parsed = sections.map((section, idx) => {
    if (!section.link)
      throw new Error(`L1L2 section ${idx} is missing "link" (image)`);
    if (!section.audio)
      throw new Error(`L1L2 section ${idx} is missing "audio"`);
    const ost = typeof section.ost === "string" ? section.ost.trim() : "";
    return { idx, link: section.link, audio: section.audio, ost };
  });

  return {
    _kind: "L1L2",
    id: payload.id || `l1l2-${Date.now()}`,
    width: 1920,
    height: 1080,
    background: payload.background || "#000000",
    overlayImage: payload.overlayImage ? String(payload.overlayImage) : null,
    bgMusic: payload.bgMusic ? String(payload.bgMusic) : null,
    intro: payload.intro ? String(payload.intro) : null,
    outro: payload.outro ? String(payload.outro) : null,
    titleCard: payload.titleCard
      ? {
          vidSrc: payload.titleCard.vidSrc ? String(payload.titleCard.vidSrc) : "",
          titleText: payload.titleCard.titleText ? String(payload.titleCard.titleText) : "",
        }
      : null,
    sections: parsed,
  };
}

export function normalizeTimelineInput(payload) {
  if (payload && typeof payload.type === "string") {
    const type = payload.type.toUpperCase();
    if (type === "L1L2" || type === "L1" || type === "L2") {
      return parseL1L2(payload);
    }
  }
  throw new Error(`Unsupported type for L1L2 strategy: "${payload?.type}"`);
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
  let overlayImageRel = null;

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

  // --- Sections: image + narration audio ---
  // Duration of each scene is driven by its narration audio length.
  const sections = [];
  for (const s of l1l2.sections) {
    // Image (no probing needed — shown for audio duration)
    let imgExt = ".jpg";
    try {
      const ext = path.extname(new URL(s.link).pathname).toLowerCase();
      if (ext) imgExt = ext;
    } catch (_) {}
    const imgRel = `assets/section-${s.idx}-image${imgExt}`;
    const imgAbs = path.join(jobDir, imgRel);
    console.log(
      `[SectionImgDownloadStarted][${jobId}] Resolving section-${s.idx} image`,
    );
    await assetCache.materialize(s.link, imgAbs, {
      fallbackExt: ".jpg",
      jobId,
      label: `section-${s.idx}-image`,
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

    sections.push({ idx: s.idx, imgRel, audioRel, duration, ost: s.ost });
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

  // --- Overlay image ---
  if (ENABLE_TOP_RIGHT_OVERLAY && l1l2.overlayImage) {
    let imageExt = ".png";
    try {
      const ext = path
        .extname(new URL(l1l2.overlayImage).pathname)
        .toLowerCase();
      if (ext) imageExt = ext;
    } catch (_) {}
    overlayImageRel = `assets/top-right-overlay${imageExt}`;
    await assetCache.materialize(
      l1l2.overlayImage,
      path.join(jobDir, overlayImageRel),
      { fallbackExt: ".png", jobId, label: "top-right-overlay" },
    );
  }

  // --- Build clips ---
  // Track layout:
  //   90  — intro video
  //   100 — title card video + section images (main content)
  //   110 — outro video
  //   150 — section narration audio
  //   200 — OST chips
  //   250 — title card text overlay
  //   300 — top-right overlay image (full span)

  const mainDuration = truncateDuration(
    titleCardDuration + sections.reduce((sum, s) => sum + s.duration, 0),
  );
  const totalDuration = truncateDuration(introDuration + mainDuration + outroDuration);

  // Intro
  if (introRelPath) {
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

  // Title card + sections (offset by intro duration)
  let cursor = introDuration;

  if (titleCardRelPath) {
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
    if (l1l2.titleCard?.titleText) {
      clips.push({
        id: "l1l2-title-card-text",
        type: "titleText",
        content: l1l2.titleCard.titleText,
        start: cursor,
        duration: titleCardDuration,
        trackIndex: 250,
        animation: { fadeIn: 0.3, fadeOut: 0.3 },
      });
    }
    cursor = truncateDuration(cursor + titleCardDuration);
  }

  for (const section of sections) {
    // Image — object-fit: cover fills the canvas, no black bars
    clips.push({
      id: `l1l2-section-${section.idx}-image`,
      type: "image",
      content: section.imgRel,
      start: cursor,
      duration: section.duration,
      trackIndex: 100,
      animation: { fadeIn: 0, fadeOut: 0 },
    });
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

  // Outro
  if (outroRelPath) {
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

  // Overlay image spans full composition
  if (ENABLE_TOP_RIGHT_OVERLAY && overlayImageRel) {
    clips.push({
      id: "l1l2-top-right-overlay",
      type: "topRightImage",
      content: overlayImageRel,
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
    // intro/outro embedded in timeline — skip post-render FFmpeg stitching
    intro: null,
    outro: null,
    bgMusic: l1l2.bgMusic || null,
    clips,
  };
}
