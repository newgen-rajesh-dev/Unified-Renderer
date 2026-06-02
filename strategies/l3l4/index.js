import { promises as fs } from "fs";
import path from "path";
import { probeMediaDuration, reencodeForSeek } from "../../common/media.js";
import { buildOstClipHtml, OST_ANIMATION } from "../../common/ost-style.js";

function camelToKebab(str) {
  return str.replace(/([A-Z])/g, "-$1").toLowerCase();
}

function styleObjectToString(style) {
  return Object.entries(style)
    .map(([key, value]) => `${camelToKebab(key)}: ${value}`)
    .join("; ");
}

function isSpeedrun(payload) {
  return payload?.speedrun === true;
}

function buildClipHtml(clip) {
  const {
    id: clipId,
    type = "text",
    start = 0,
    duration = 5,
    trackIndex = 0,
    content = "",
    style = {},
    mediaDuration = null,
  } = clip;

  const baseAttrsArr = [
    `id="${clipId}"`,
    `class="clip"`,
    `data-start="${start}"`,
    `data-duration="${duration}"`,
    `data-track-index="${trackIndex}"`,
  ];
  if (mediaDuration != null)
    baseAttrsArr.push(`data-media-duration="${mediaDuration}"`);
  const baseAttrs = baseAttrsArr.join(" ");
  const customStyle = styleObjectToString(style);

  if (type === "text") {
    const defaultStyle =
      "position: absolute; top: 0; left: 0; font-size: 64px; color: #fff; padding: 40px;";
    return `<div ${baseAttrs} style="${defaultStyle} ${customStyle}">${content}</div>`;
  }
  if (type === "titleText") {
    const defaultStyle = [
      "position: absolute",
      "inset: 0",
      "display: flex",
      "align-items: center",
      "justify-content: center",
      "padding: 140px",
      "color: #FFFFFF",
      "font-family: 'Inter', 'Geist', sans-serif",
      "font-size: 85px",
      "font-weight: 700",
      "line-height: 1.15",
      "text-align: center",
      "overflow-wrap: break-word",
      "text-wrap: balance",
      "pointer-events: none",
    ].join("; ");
    return `<div ${baseAttrs} style="${defaultStyle} ${customStyle}">${content}</div>`;
  }
  if (type === "image") {
    const defaultStyle =
      "position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; will-change: transform;";
    return `<img ${baseAttrs} src="${content}" style="${defaultStyle} ${customStyle}" alt="" />`;
  }
  if (type === "topRightImage") {
    const defaultStyle =
      "position: absolute; top: 38px; right: 38px; width: 120px; height: 120px; object-fit: contain;";
    return `<img ${baseAttrs} src="${content}" style="${defaultStyle} ${customStyle}" alt="" />`;
  }
  if (type === "video") {
    const defaultStyle =
      "position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover;";
    return `<video ${baseAttrs} src="${content}" style="${defaultStyle} ${customStyle}" playsinline preload="auto" data-has-audio="true" data-volume="1"></video>`;
  }
  if (type === "audio")
    return `<audio ${baseAttrs} src="${content}" preload="auto" data-volume="1"></audio>`;
  if (type === "ost") {
    return buildOstClipHtml({ baseAttrs, clipId, content });
  }
  if (type === "shape") {
    const defaultStyle = "position: absolute; top: 0; left: 0;";
    return `<div ${baseAttrs} style="${defaultStyle} ${customStyle}"></div>`;
  }
  return "";
}

function buildAnimationScript(clips, compositionId) {
  const tweens = clips
    .filter((c) => c.type !== "audio")
    .map((clip) => {
      const {
        id,
        type,
        start = 0,
        duration = 5,
        animation = null,
        pan = false,
        panDuration = null,
        panEnterDuration = null,
        panExitDuration = null,
      } = clip;
      const fadeIn = animation?.fadeIn ?? 0.3;
      const fadeOut = animation?.fadeOut ?? 0.3;

      if (type === "image" && pan) {
        if (panEnterDuration != null || panExitDuration != null) {
          // L1/L2 still-image scenes enter from the left, hold, then reverse that same move.
          // Scale 1.25 gives enough overflow for a clear -10% entrance without black bars.
          const enterDur = Math.min(duration, truncateDuration(Math.max(0, panEnterDuration ?? 0)));
          const exitDur = Math.min(
            Math.max(0, duration - enterDur),
            truncateDuration(Math.max(0, panExitDuration ?? 0)),
          );
          const exitStart = truncateDuration(start + duration - exitDur);
          return [
            `  tl.set("#${id}", { opacity: 1 }, ${start});`,
            `  tl.fromTo("#${id}", { x: "-10%", scale: 1.25 }, { x: "0%", scale: 1.25, duration: ${enterDur}, ease: "power2.out" }, ${start});`,
            `  tl.to("#${id}", { x: "-10%", scale: 1.25, duration: ${exitDur}, ease: "power2.in" }, ${exitStart});`,
            `  tl.set("#${id}", { opacity: 0 }, ${start + duration});`,
          ].join("\n");
        }

        if (panDuration != null) {
          // Continuous still-image pan across a bounded duration.
          // Scale 1.1 gives 5% overflow on each side, so ±4% avoids black bars.
          const moveDur = Math.min(duration, truncateDuration(Math.max(0, panDuration)));
          const panStart = truncateDuration(start + (duration - moveDur) / 2);
          return [
            `  tl.set("#${id}", { opacity: 1 }, ${start});`,
            `  tl.fromTo("#${id}", { x: "4%", scale: 1.1 }, { x: "-4%", scale: 1.1, duration: ${moveDur}, ease: "none" }, ${panStart});`,
            `  tl.set("#${id}", { opacity: 0 }, ${start + duration});`,
          ].join("\n");
        }

        // Default image pan: quick enter from right, hold, exit left.
        const moveDur = Math.min(0.6, truncateDuration(duration * 0.25));
        return [
          `  tl.set("#${id}", { opacity: 1 }, ${start});`,
          `  tl.fromTo("#${id}", { x: "-4%", scale: 1.1 }, { x: "0%", scale: 1.1, duration: ${moveDur}, ease: "power2.out" }, ${start});`,
          `  tl.fromTo("#${id}", { x: "0%", scale: 1.1 }, { x: "-4%", scale: 1.1, duration: ${moveDur}, ease: "power2.in" }, ${truncateDuration(start + duration - moveDur)});`,
          `  tl.set("#${id}", { opacity: 0 }, ${start + duration});`,
        ].join("\n");
      }

      if (type === "ost") {
        const chipSel = `#${id}-chip`;
        return [
          `  tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: 0 }, ${start});`,
          `  tl.to("#${id}", { opacity: 0, duration: 0 }, ${start + duration});`,
          `  tl.fromTo("${chipSel}", { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: ${fadeIn}, ease: "power3.out" }, ${start});`,
          `  tl.to("${chipSel}", { opacity: 0, duration: ${fadeOut}, ease: "power2.in" }, ${start + duration - fadeOut});`,
        ].join("\n");
      }

      const hold = duration - fadeIn - fadeOut;
      return [
        `  tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: ${fadeIn} }, ${start});`,
        hold > 0
          ? `  tl.to("#${id}", { opacity: 0, duration: ${fadeOut} }, ${start + fadeIn + hold});`
          : `  tl.to("#${id}", { opacity: 0, duration: ${fadeOut} }, ${start + fadeIn});`,
      ].join("\n");
    })
    .join("\n");

  return `
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
${tweens}
    (function attachMediaSync(){
      const medias = Array.from(document.querySelectorAll('video.clip, audio.clip')).map(el => ({
        el,
        start: parseFloat(el.dataset.start) || 0,
        duration: parseFloat(el.dataset.duration) || 0,
        mediaStart: parseFloat(el.dataset.mediaStart) || 0,
        mediaDuration: parseFloat(el.dataset.mediaDuration) || Infinity,
      }));
      medias.forEach(m => { if (m.el.tagName === 'VIDEO') { m.el.playsInline = true; } });
      tl.eventCallback('onUpdate', () => {
        const t = tl.time();
        for (const m of medias) {
          const local = t - m.start;
          if (local >= 0 && local < m.duration) {
            const target = Math.min(m.mediaStart + local, m.mediaStart + m.mediaDuration - 0.04);
            if (Math.abs(m.el.currentTime - target) > 0.04) {
              try { m.el.currentTime = target; } catch (_) {}
            }
          } else if (local < 0) {
            if (m.el.currentTime !== m.mediaStart) {
              try { m.el.currentTime = m.mediaStart; } catch (_) {}
            }
          }
        }
      });
    })();
    window.__timelines["${compositionId}"] = tl;
  `.trim();
}

function parseL3L4(payload) {
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  if (sections.length === 0)
    throw new Error('L3L4 timeline requires a non-empty "sections" array');

  const parsed = sections.map((section, idx) => {
    const partName = section.part1 || section.part || `part${idx + 1}`;
    if (!section.link)
      throw new Error(`L3L4 section ${idx} ("${partName}") is missing "link"`);
    const ost = typeof section.ost === "string" ? section.ost.trim() : "";
    return { idx, partName, link: section.link, ost };
  });
  const speedrun = isSpeedrun(payload);

  return {
    _kind: "L3L4",
    id: payload.id || `l3l4-${Date.now()}`,
    speedrun,
    width: 1920,
    height: 1080,
    background: payload.background || "#000000",
    overlayImage: !speedrun && payload.overlayImage ? String(payload.overlayImage) : null,
    bgMusic: !speedrun && payload.bgMusic ? String(payload.bgMusic) : null,
    titleCard: !speedrun && payload.titleCard
      ? {
          vidSrc: payload.titleCard.vidSrc
            ? String(payload.titleCard.vidSrc)
            : "",
          titleText: payload.titleCard.titleText
            ? String(payload.titleCard.titleText)
            : "",
        }
      : null,
    sections: parsed,
  };
}

const ENABLE_TOP_RIGHT_OVERLAY = true;

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
  let overlayImageRel = null;

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

  // --- Section videos ---
  const sectionVideos = [];
  for (const s of l3l4.sections) {
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

  // --- Overlay image ---
  if (ENABLE_TOP_RIGHT_OVERLAY && l3l4.overlayImage) {
    let imageExt = ".png";
    try {
      const ext = path
        .extname(new URL(l3l4.overlayImage).pathname)
        .toLowerCase();
      if (ext) imageExt = ext;
    } catch (_) {}
    overlayImageRel = `assets/top-right-overlay${imageExt}`;
    await assetCache.materialize(
      l3l4.overlayImage,
      path.join(jobDir, overlayImageRel),
      {
        fallbackExt: ".png",
        jobId,
        label: "top-right-overlay",
      },
    );
  }

  // --- Build clips ---
  // Track layout:
  //   90  — intro video
  //   100 — title card + section videos (main content)
  //   110 — outro video
  //   200 — OST chips
  //   250 — title card text overlay
  //   300 — top-right overlay image (full span)

  const mainDuration = truncateDuration(
    titleCardDuration + sectionVideos.reduce((sum, v) => sum + v.duration, 0),
  );
  const totalDuration = truncateDuration(introDuration + mainDuration + outroDuration);

  // Intro
  if (introRelPath) {
    clips.push({
      id: "l3l4-intro-video",
      type: "video",
      content: introRelPath,
      start: 0,
      duration: introDuration,
      mediaDuration: introDuration,
      trackIndex: 90,
      animation: { fadeIn: 0, fadeOut: 0 },
    });
  }

  // Title card + sections (all offset by intro duration)
  let cursor = introDuration;

  if (titleCardRelPath) {
    clips.push({
      id: "l3l4-title-card-video",
      type: "video",
      content: titleCardRelPath,
      start: cursor,
      duration: titleCardDuration,
      mediaDuration: titleCardDuration,
      trackIndex: 100,
      animation: { fadeIn: 0, fadeOut: 0 },
    });
    if (l3l4.titleCard?.titleText) {
      clips.push({
        id: "l3l4-title-card-text",
        type: "titleText",
        content: l3l4.titleCard.titleText,
        start: cursor,
        duration: titleCardDuration,
        trackIndex: 250,
        animation: { fadeIn: 0.3, fadeOut: 0.3 },
      });
    }
    cursor = truncateDuration(cursor + titleCardDuration);
  }

  for (const section of sectionVideos) {
    clips.push({
      id: `l3l4-section-${section.idx}-video`,
      type: "video",
      content: section.relPath,
      start: cursor,
      duration: section.duration,
      mediaDuration: section.duration,
      trackIndex: 100,
      animation: { fadeIn: 0, fadeOut: 0 },
    });
    if (section.ost) {
      clips.push({
        id: `l3l4-ost-${section.idx}`,
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
      id: "l3l4-outro-video",
      type: "video",
      content: outroRelPath,
      start: introDuration + mainDuration,
      duration: outroDuration,
      mediaDuration: outroDuration,
      trackIndex: 110,
      animation: { fadeIn: 0, fadeOut: 0 },
    });
  }

  // Overlay image spans the full composition
  if (ENABLE_TOP_RIGHT_OVERLAY && overlayImageRel) {
    clips.push({
      id: "l3l4-top-right-overlay",
      type: "topRightImage",
      content: overlayImageRel,
      start: 0,
      duration: totalDuration,
      trackIndex: 300,
      animation: { fadeIn: 0, fadeOut: 0 },
    });
  }

  return {
    id: l3l4.id,
    duration: totalDuration,
    width: l3l4.width,
    height: l3l4.height,
    background: l3l4.background,
    // intro/outro are now embedded in the timeline — signal caller to skip stitching
    intro: null,
    outro: null,
    bgMusic: l3l4.bgMusic || null,
    clips,
  };
}

export function normalizeTimelineInput(payload) {
  let timelineData;
  if (Array.isArray(payload)) {
    timelineData = parseL3L4({ type: "L3L4", sections: payload });
  } else if (payload && typeof payload.type === "string") {
    const type = payload.type.toUpperCase();
    if (type === "L3L4" || type === "L3" || type === "L4" || type === "L1") {
      timelineData = parseL3L4(payload);
    } else {
      throw new Error(
        `Unsupported timeline type "${payload.type}". Supported: L3L4`,
      );
    }
  } else if (payload && Array.isArray(payload.sections)) {
    timelineData = parseL3L4({ ...payload, type: "L3L4" });
  } else {
    timelineData = payload;
  }

  if (payload && !Array.isArray(payload)) {
    timelineData.speedrun = isSpeedrun(payload);
    if (timelineData.speedrun) {
      timelineData.intro = null;
      timelineData.outro = null;
      timelineData.overlayImage = null;
      timelineData.bgMusic = null;
      timelineData.titleCard = null;
    } else {
      if (payload.intro) timelineData.intro = String(payload.intro);
      if (payload.outro) timelineData.outro = String(payload.outro);
      if (payload.overlayImage)
        timelineData.overlayImage = String(payload.overlayImage);
      if (payload.bgMusic) timelineData.bgMusic = String(payload.bgMusic);
      if (payload.titleCard) {
        timelineData.titleCard = {
          vidSrc: payload.titleCard.vidSrc
            ? String(payload.titleCard.vidSrc)
            : "",
          titleText: payload.titleCard.titleText
            ? String(payload.titleCard.titleText)
            : "",
        };
      }
    }
  }
  return timelineData;
}

export function generateCompositionHtml(timelineData) {
  const {
    id = "main",
    duration = 10,
    width = 1920,
    height = 1080,
    background = "#000",
    clips = [],
    audio = null,
  } = timelineData;

  const clipsHtml = clips.map(buildClipHtml).join("\n      ");
  const audioHtml = audio
    ? `<audio id="track-audio" data-start="0" src="${audio}"></audio>`
    : "";
  const animScript = buildAnimationScript(clips, id);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: ${background};
        font-family: 'Geist', sans-serif;
      }
      .clip { opacity: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="${id}" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
      ${clipsHtml}
      ${audioHtml}
    </div>
    <script>
      ${animScript}
    </script>
  </body>
</html>`;
}
