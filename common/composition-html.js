import { buildOstClipHtml } from "./ost-style.js";

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

function buildCharacterSpans(value) {
  return Array.from(String(value))
    .map((char) => {
      const text = char === " " ? "&nbsp;" : escapeHtml(char);
      return `<span class="key-learning-char">${text}</span>`;
    })
    .join("");
}

function estimateKeyLearningPointFontSize(points) {
  const maxChars = points.reduce((max, point) => Math.max(max, Array.from(String(point)).length), 0);
  const availableTextWidth = 1516;
  const estimatedTextWidth = Math.max(1, maxChars * 31);
  if (estimatedTextWidth <= availableTextWidth) return 62;
  return Math.max(46, Math.floor(62 * (availableTextWidth / estimatedTextWidth)));
}

function estimateKeyLearningTitleFontSize(content) {
  const titleTexts = [content?.blue ?? "", content?.green ?? ""];
  const maxChars = titleTexts.reduce((max, text) => Math.max(max, Array.from(String(text)).length), 0);
  const availableTextWidth = 1171;
  const estimatedTextWidth = Math.max(1, maxChars * 91);
  if (estimatedTextWidth <= availableTextWidth) return 166.32;
  return Math.max(104, Math.floor(166.32 * (availableTextWidth / estimatedTextWidth)));
}

function buildKeyLearningsHtml({ baseAttrs, content }) {
  const attrs = baseAttrs.replace('class="clip"', 'class="clip key-learning-screen"');
  const points = Array.isArray(content?.points) ? content.points.slice(0, 4) : [];
  const pointFontSize = estimateKeyLearningPointFontSize(points);
  const titleFontSize = estimateKeyLearningTitleFontSize(content);
  const pointRows = points
    .map(
      (point, index) => `
        <div class="key-learning-point" data-point-index="${index}">
          <div class="key-learning-point-text">
            <span class="key-learning-bullet">&bull;</span>
            <span class="key-learning-copy">${buildCharacterSpans(point)}</span>
          </div>
        </div>`,
    )
    .join("");

  return `<div ${attrs}>
        <div class="key-learning-frame" style="--key-learning-title-font-size: ${titleFontSize}px; --key-learning-point-font-size: ${pointFontSize}px">
          <div class="key-learning-title">
            <div class="key-learning-blue">${escapeHtml(content?.blue ?? "")}</div>
            <div class="key-learning-green">${escapeHtml(content?.green ?? "")}</div>
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
        return [
          `  tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: 0 }, ${start});`,
          `  tl.to("#${id}", { opacity: 0, duration: 0 }, ${start + duration});`,
          `  tl.fromTo("${chipSel}", { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: ${fadeIn}, ease: "power3.out" }, ${start});`,
          `  tl.to("${chipSel}", { opacity: 0, duration: ${fadeOut}, ease: "power2.in" }, ${start + duration - fadeOut});`,
        ].join("\n");
      }

      if (type === "keyLearnings") {
        const pointRevealStart = truncateDuration(start + 1.1);
        const pointHoldEnd = Math.max(start + duration - fadeOut, pointRevealStart);
        const pointTweens = [0, 1, 2, 3]
          .map((pointIndex) => {
            const pointStart = truncateDuration(pointRevealStart + pointIndex * 0.52);
            return [
              `  tl.fromTo("#${id} .key-learning-point[data-point-index='${pointIndex}']", { x: -48, opacity: 0 }, { x: 0, opacity: 1, duration: 0.36, ease: "power3.out" }, ${pointStart});`,
              `  tl.fromTo("#${id} .key-learning-point[data-point-index='${pointIndex}'] .key-learning-char", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.04, stagger: 0.012, ease: "none" }, ${truncateDuration(pointStart + 0.12)});`,
            ].join("\n");
          })
          .join("\n");
        return [
          `  tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: ${fadeIn} }, ${start});`,
          `  tl.fromTo("#${id} .key-learning-blue", { x: 220, opacity: 0 }, { x: 0, opacity: 1, duration: 0.65, ease: "back.out(1.25)" }, ${truncateDuration(start + 0.15)});`,
          `  tl.fromTo("#${id} .key-learning-green", { x: -260, opacity: 0 }, { x: 0, opacity: 1, duration: 0.72, ease: "expo.out" }, ${truncateDuration(start + 0.35)});`,
          pointTweens,
          `  tl.to("#${id}", { opacity: 0, duration: ${fadeOut}, ease: "power2.in" }, ${pointHoldEnd});`,
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
    <link href="https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;1,900&display=swap" rel="stylesheet">
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
        width: 1612px;
        height: 1080px;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 80px 10px;
        gap: 36px;
      }
      .key-learning-title {
        width: 1171px;
        height: 392px;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
      }
      .key-learning-blue,
      .key-learning-green {
        font-family: 'Inter', sans-serif;
        font-style: italic;
        font-weight: 900;
        font-size: var(--key-learning-title-font-size, 166.32px);
        line-height: 196px;
        letter-spacing: 0;
        text-transform: uppercase;
        font-variation-settings: 'slnt' -10;
        will-change: transform, opacity;
      }
      .key-learning-blue {
        width: 1171px;
        height: 196px;
        color: #0092D9;
        text-shadow: 4.32px 4.32px 0 #013B58, 7.56px 10.8px 0 #000000;
      }
      .key-learning-green {
        width: 1171px;
        height: 196px;
        color: #A4CD4E;
        text-shadow: 4.32px 4.32px 0 #3F4C1B, 7.56px 10.8px 0 #000000;
      }
      .key-learning-points {
        width: 1592px;
        min-width: 1338px;
        height: 492px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        align-items: center;
        padding: 10px 16px;
        gap: 10px;
      }
      .key-learning-point {
        width: 1560px;
        height: 75px;
        flex: 0 0 75px;
        display: flex;
        flex-direction: row;
        align-items: center;
        padding: 0 22px;
        gap: 10px;
        background: #FFFFFF;
        box-shadow: 0 7px 0 #328EFE;
        overflow: hidden;
        will-change: transform, opacity;
      }
      .key-learning-point-text {
        width: 1516px;
        height: 75px;
        display: flex;
        align-items: center;
        gap: 28px;
        padding: 0;
        font-family: 'Inter', sans-serif;
        font-style: normal;
        font-weight: 400;
        font-size: var(--key-learning-point-font-size, 62px);
        line-height: 75px;
        color: #000000;
        white-space: nowrap;
      }
      .key-learning-bullet {
        flex: 0 0 auto;
      }
      .key-learning-copy {
        min-width: 0;
        overflow: visible;
      }
      .key-learning-char {
        display: inline-block;
        white-space: pre;
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
