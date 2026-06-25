export const OST_ANIMATION = { fadeIn: 0.5, fadeOut: 0.5 };

const TEXT_FONT_STACK =
  "'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Bengali', 'Noto Sans Devanagari', 'Noto Sans JP', 'Inter', 'Geist', 'Nirmala UI', 'Yu Gothic', 'Meiryo', 'Segoe UI', Arial, sans-serif";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildOstClipHtml({ baseAttrs, clipId, content }) {
  const wrapperStyle = [
    "position: absolute",
    "inset: 0",
    "display: flex",
    "flex-direction: column",
    "align-items: flex-start",
    "padding: 644px 0 0",
    "gap: 10px",
    "pointer-events: none",
  ].join("; ");

  const mainFrameStyle = [
    "width: fit-content",
    "max-width: 1072px",
    "min-height: 127px",
    "background: #005CA4",
    "display: inline-flex",
    "flex-direction: row",
    "align-items: center",
    "padding: 0",
    "gap: 10px",
    "flex: none",
    "order: 0",
    "flex-grow: 0",
    "transform: translateY(60px)",
    "opacity: 0",
    "will-change: transform, opacity",
  ].join("; ");

  const overlayContainerStyle = [
    "width: fit-content",
    "max-width: 1072px",
    "min-height: 127px",
    "display: flex",
    "flex-direction: row",
    "align-items: center",
    "padding: 0",
    "gap: 10px",
    "flex: none",
    "order: 0",
    "flex-grow: 0",
  ].join("; ");

  const frameStyle = [
    "width: fit-content",
    "max-width: 1072px",
    "min-height: 127px",
    "display: flex",
    "flex-direction: row",
    "align-items: stretch",
    "padding: 0",
    "flex: none",
    "order: 0",
    "flex-grow: 0",
  ].join("; ");

  const accentStyle = [
    "width: 27px",
    "min-height: 127px",
    "background: #C0FF4B",
    "flex: none",
    "order: 0",
    "align-self: stretch",
    "flex-grow: 0",
  ].join("; ");

  const textFrameStyle = [
    "width: fit-content",
    "max-width: 1045px",
    "min-height: 127px",
    "display: flex",
    "flex-direction: column",
    "justify-content: center",
    "align-items: center",
    "padding: 30px 43px",
    "gap: 10px",
    "flex: 1 1 auto",
    "order: 1",
    "box-sizing: border-box",
  ].join("; ");

  const textStyle = [
    "width: max-content",
    "max-width: 959px",
    "color: #FFFFFF",
    `font-family: ${TEXT_FONT_STACK}`,
    "font-style: normal",
    "font-weight: 500",
    "font-size: 55px",
    "line-height: 67px",
    "flex: none",
    "order: 0",
    "align-self: stretch",
    "flex-grow: 0",
    "unicode-bidi: plaintext",
    "overflow-wrap: break-word",
  ].join("; ");

  return `<div ${baseAttrs} style="${wrapperStyle}"><div id="${clipId}-chip" style="${mainFrameStyle}"><div style="${overlayContainerStyle}"><div style="${frameStyle}"><div style="${accentStyle}"></div><div style="${textFrameStyle}"><div dir="auto" style="${textStyle}">${escapeHtml(content)}</div></div></div></div></div></div>`;
}
