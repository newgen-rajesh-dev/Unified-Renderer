import { readFileSync } from "fs";
import { buildOstClipHtml } from "./ost-style.js";

const KEY_LEARNING_POINT_SVG_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(
  readFileSync(new URL("../assets/key-learning-point.svg", import.meta.url)),
).toString("base64")}`;
const KEY_LEARNING_REVEAL_MASK =
  "linear-gradient(90deg, #000 0%, #000 48%, rgba(0, 0, 0, 0.8) 53%, transparent 65%, transparent 100%)";
const TEXT_FONT_STACK =
  "'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Bengali', 'Noto Sans Devanagari', 'Noto Sans JP', 'Inter', 'Geist', 'Nirmala UI', 'Yu Gothic', 'Meiryo', 'Segoe UI', Arial, sans-serif";

function camelToKebab(str) {
  return str.replace(/([A-Z])/g, "-$1").toLowerCase();
}

function styleObjectToString(style) {
  return Object.entries(style)
    .map(([key, value]) => `${camelToKebab(key)}: ${value}`)
    .join("; ");
}

function truncateDuration(duration) {
  return Math.floor(duration * 100) / 100;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function estimateKeyLearningPointFontSize(points) {
  const maxChars = points.reduce((max, point) => Math.max(max, Array.from(String(point)).length), 0);
  const availableTextWidth = 1337;
  const estimatedTextWidth = Math.max(1, maxChars * 25.5);
  if (estimatedTextWidth <= availableTextWidth) return 51;
  return Math.max(38, Math.floor(51 * (availableTextWidth / estimatedTextWidth)));
}

function buildKeyLearningsHtml({ baseAttrs, content }) {
  const attrs = baseAttrs.replace('class="clip"', 'class="clip key-learning-screen"');
  const points = Array.isArray(content?.points) ? content.points.slice(0, 5) : [];
  const pointFontSize = estimateKeyLearningPointFontSize(points);
  const pointRows = points
    .map(
      (point, index) => `
        <div class="key-learning-point" data-point-index="${index}">
          <span class="key-learning-bullet" aria-hidden="true"></span>
          <span class="key-learning-copy" dir="auto"><span class="key-learning-reveal-text">${escapeHtml(point)}</span></span>
        </div>`,
    )
    .join("");

  return `<div ${attrs}>
        <div class="key-learning-frame" style="--key-learning-point-font-size: ${pointFontSize}px">
          <div class="key-learning-head">
            <div class="key-learning-lead-in" dir="auto"><span class="key-learning-reveal-text">${escapeHtml(content?.leadIn ?? "")}</span></div>
          </div>
          <div class="key-learning-points">
            ${pointRows}
          </div>
        </div>
      </div>`;
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
    hasAudio = true,
  } = clip;

  const baseAttrsArr = [
    `id="${clipId}"`,
    `class="clip"`,
    `data-start="${start}"`,
    `data-duration="${duration}"`,
    `data-track-index="${trackIndex}"`,
  ];
  if (mediaDuration != null) {
    baseAttrsArr.push(`data-media-duration="${mediaDuration}"`);
  }
  const baseAttrs = baseAttrsArr.join(" ");
  const customStyle = styleObjectToString(style);

  if (type === "text") {
    const defaultStyle =
      "position: absolute; top: 0; left: 0; font-size: 64px; color: #fff; padding: 40px;";
    return `<div ${baseAttrs} dir="auto" style="${defaultStyle} ${customStyle}">${escapeHtml(content)}</div>`;
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
      `font-family: ${TEXT_FONT_STACK}`,
      "font-size: 85px",
      "font-weight: 700",
      "line-height: 1.15",
      "text-align: center",
      "unicode-bidi: plaintext",
      "overflow-wrap: break-word",
      "text-wrap: balance",
      "pointer-events: none",
    ].join("; ");
    return `<div ${baseAttrs} dir="auto" style="${defaultStyle} ${customStyle}">${escapeHtml(content)}</div>`;
  }
  if (type === "keyLearnings") {
    return buildKeyLearningsHtml({ baseAttrs, content });
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
    const audioAttrs = hasAudio
      ? `data-has-audio="true" data-volume="1"`
      : "muted";
    return `<video ${baseAttrs} src="${content}" style="${defaultStyle} ${customStyle}" playsinline preload="auto" ${audioAttrs}></video>`;
  }
  if (type === "audio") {
    return `<audio ${baseAttrs} src="${content}" preload="auto" data-volume="1"></audio>`;
  }
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
        content,
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
          const enterDur = Math.min(
            duration,
            truncateDuration(Math.max(0, panEnterDuration ?? 0)),
          );
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
          const moveDur = Math.min(
            duration,
            truncateDuration(Math.max(0, panDuration)),
          );
          const panStart = truncateDuration(start + (duration - moveDur) / 2);
          return [
            `  tl.set("#${id}", { opacity: 1 }, ${start});`,
            `  tl.fromTo("#${id}", { x: "4%", scale: 1.1 }, { x: "-4%", scale: 1.1, duration: ${moveDur}, ease: "none" }, ${panStart});`,
            `  tl.set("#${id}", { opacity: 0 }, ${start + duration});`,
          ].join("\n");
        }

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
        const end = truncateDuration(start + duration);
        return [
          `  tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: 0 }, ${start});`,
          `  tl.to("#${id}", { opacity: 0, duration: 0 }, ${end});`,
          `  tl.fromTo("${chipSel}", { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: ${fadeIn}, ease: "power3.out" }, ${start});`,
          `  tl.to("${chipSel}", { opacity: 0, duration: ${fadeOut}, ease: "power2.in" }, ${truncateDuration(end - fadeOut)});`,
          `  tl.set("${chipSel}", { opacity: 0 }, ${end});`,
        ].join("\n");
      }

      if (type === "keyLearnings") {
        const pointCount = Array.isArray(content?.points) ? Math.min(content.points.length, 5) : 0;
        const revealStart = truncateDuration(start + 0.15);
        const availableRevealDuration = Math.max(1.35, duration - fadeOut - 0.35);
        const timingScale = Math.min(1, Math.max(0.45, availableRevealDuration / 4.62));
        const headingDuration = truncateDuration(0.72 * timingScale);
        const pointSlotDuration = truncateDuration(0.78 * timingScale);
        const bulletGrowDuration = truncateDuration(0.34 * timingScale);
        const bulletSettleDuration = truncateDuration(0.2 * timingScale);
        const copyDelay = truncateDuration(0.1 * timingScale);
        const copyDuration = truncateDuration(0.62 * timingScale);
        const firstPointStart = truncateDuration(revealStart + headingDuration + 0.12 * timingScale);
        const pointInitialStates = Array.from({ length: pointCount }, (_, pointIndex) => [
          `  tl.set("#${id} .key-learning-point[data-point-index='${pointIndex}'] .key-learning-bullet", { scale: 0, opacity: 0, transformOrigin: "50% 50%" }, ${start});`,
          `  tl.set("#${id} .key-learning-point[data-point-index='${pointIndex}'] .key-learning-reveal-text", { opacity: 0, maskImage: "${KEY_LEARNING_REVEAL_MASK}", webkitMaskImage: "${KEY_LEARNING_REVEAL_MASK}", maskPosition: "100% 0%", webkitMaskPosition: "100% 0%" }, ${start});`,
        ].join("\n")).join("\n");
        const pointTweens = Array.from({ length: pointCount }, (_, pointIndex) => {
          const pointStart = truncateDuration(firstPointStart + pointIndex * pointSlotDuration);
          const settleStart = truncateDuration(pointStart + bulletGrowDuration);
          const copyStart = truncateDuration(pointStart + copyDelay);
          return [
            `  tl.to("#${id} .key-learning-point[data-point-index='${pointIndex}'] .key-learning-bullet", { scale: 1.3, opacity: 1, duration: ${bulletGrowDuration}, ease: "back.out(2.2)" }, ${pointStart});`,
            `  tl.to("#${id} .key-learning-point[data-point-index='${pointIndex}'] .key-learning-bullet", { scale: 1, duration: ${bulletSettleDuration}, ease: "power2.inOut" }, ${settleStart});`,
            `  tl.to("#${id} .key-learning-point[data-point-index='${pointIndex}'] .key-learning-reveal-text", { opacity: 1, maskPosition: "0% 0%", webkitMaskPosition: "0% 0%", duration: ${copyDuration}, ease: "power2.out" }, ${copyStart});`,
          ].join("\n");
        }).join("\n");
        const fadeOutStart = truncateDuration(start + duration - fadeOut);
        return [
          `  tl.set("#${id}", { opacity: 1 }, ${start});`,
          `  tl.set("#${id} .key-learning-lead-in .key-learning-reveal-text", { opacity: 0, maskImage: "${KEY_LEARNING_REVEAL_MASK}", webkitMaskImage: "${KEY_LEARNING_REVEAL_MASK}", maskPosition: "100% 0%", webkitMaskPosition: "100% 0%" }, ${start});`,
          pointInitialStates,
          `  tl.to("#${id} .key-learning-lead-in .key-learning-reveal-text", { opacity: 1, maskPosition: "0% 0%", webkitMaskPosition: "0% 0%", duration: ${headingDuration}, ease: "power2.out" }, ${revealStart});`,
          pointTweens,
          `  tl.to("#${id}", { opacity: 0, duration: ${fadeOut}, ease: "power2.in" }, ${fadeOutStart});`,
          `  tl.set("#${id}", { opacity: 0 }, ${truncateDuration(start + duration)});`,
        ].join("\n");
      }

      const hold = duration - fadeIn - fadeOut;
      const end = truncateDuration(start + duration);
      return [
        `  tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: ${fadeIn} }, ${start});`,
        hold > 0
          ? `  tl.to("#${id}", { opacity: 0, duration: ${fadeOut} }, ${truncateDuration(start + fadeIn + hold)});`
          : `  tl.to("#${id}", { opacity: 0, duration: ${fadeOut} }, ${truncateDuration(start + fadeIn)});`,
        `  tl.set("#${id}", { opacity: 0 }, ${end});`,
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
<html lang="und">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;800&family=Noto+Sans:ital,wght@0,400;0,500;0,700;1,900&family=Noto+Sans+Arabic:wght@400;500;700;900&family=Noto+Sans+Bengali:wght@400;500;700;900&family=Noto+Sans+Devanagari:wght@400;500;700;900&family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: ${background};
        font-family: ${TEXT_FONT_STACK};
      }
      .clip { opacity: 0; }
      .key-learning-screen {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        padding: 0;
        overflow: hidden;
        pointer-events: none;
      }
      .key-learning-frame {
        width: 1536px;
        height: 1080px;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 225px 10px 251px;
        gap: 61px;
      }
      .key-learning-head {
        width: 1516px;
        height: 77px;
        flex: 0 0 77px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: flex-start;
        gap: 10px;
      }
      .key-learning-lead-in {
        width: 100%;
        color: #ffffff;
        font-family: 'Inter', ${TEXT_FONT_STACK};
        font-size: 64px;
        font-style: normal;
        font-weight: 800;
        line-height: 77px;
        white-space: nowrap;
        unicode-bidi: plaintext;
        filter: drop-shadow(4px 5px 6.1px rgba(0, 0, 0, 0.69));
      }
      .key-learning-points {
        width: 1516px;
        height: 466px;
        flex: 1 0 466px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        align-items: center;
        padding: 0 49px;
        gap: 10px;
      }
      .key-learning-point {
        width: 100%;
        height: 62px;
        flex: 0 0 62px;
        display: flex;
        flex-direction: row;
        align-items: center;
        padding: 0;
        gap: 47px;
        color: #ffffff;
        font-family: 'Inter', ${TEXT_FONT_STACK};
        font-size: var(--key-learning-point-font-size, 51px);
        font-style: normal;
        font-weight: 500;
        line-height: 62px;
        white-space: nowrap;
        unicode-bidi: plaintext;
        will-change: transform, opacity;
      }
      .key-learning-bullet {
        width: 34px;
        height: 34px;
        flex: 0 0 34px;
        background: url("${KEY_LEARNING_POINT_SVG_DATA_URI}") center / contain no-repeat;
        will-change: transform, opacity;
      }
      .key-learning-copy {
        min-width: 0;
        overflow: visible;
        filter: drop-shadow(4px 5px 6.1px rgba(0, 0, 0, 0.69));
      }
      .key-learning-reveal-text {
        display: inline-block;
        -webkit-mask-image: ${KEY_LEARNING_REVEAL_MASK};
        -webkit-mask-size: 220% 100%;
        -webkit-mask-repeat: no-repeat;
        mask-image: ${KEY_LEARNING_REVEAL_MASK};
        mask-size: 220% 100%;
        mask-repeat: no-repeat;
        will-change: opacity, mask-position;
      }
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
