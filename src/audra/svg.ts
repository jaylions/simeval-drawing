import { canonicalArtboard, inkColor } from "./artboard";
import type { ForegroundStroke } from "./eraser";
import type { AudraScene } from "./reducer";

/**
 * Canonical vector representation of a trial.
 *
 * This is the single definition of "what the drawing is". The human UI
 * rasterizes it through the browser canvas for interactivity; the server
 * rasterizes this exact markup with resvg for agent observations and exports.
 * Two rasterizers, one source of geometry.
 */

export type BackgroundEmbed =
  /** Inner markup lifted from a stimulus authored on the canonical artboard. */
  | { kind: "svg_fragment"; markup: string }
  /** base64 data URI, for raster stimuli. */
  | { kind: "data_uri"; href: string };

/** Fixed precision keeps the markup byte-stable across runs and platforms. */
function n(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function strokeMarkup(stroke: ForegroundStroke) {
  const points = stroke.points.map(point => `${n(point.x)},${n(point.y)}`).join(" ");
  return `<polyline points="${points}" stroke-width="${n(stroke.width)}"/>`;
}

export function sceneToSvg(scene: AudraScene, background: BackgroundEmbed | null) {
  const { width, height, backgroundColor } = canonicalArtboard;
  const backgroundLayer = !background
    ? ""
    : background.kind === "svg_fragment"
      ? `<g id="starter-contours">${background.markup}</g>`
      : `<image id="starter-contours" x="0" y="0" width="${width}" height="${height}" href="${background.href}"/>`;
  const foreground = scene.strokes.map(strokeMarkup).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${backgroundColor}"/>` +
    backgroundLayer +
    `<g id="actor-marks" fill="none" stroke="${inkColor}" stroke-linecap="round" stroke-linejoin="round">` +
    foreground +
    `</g></svg>`
  );
}

/**
 * Lifts the drawable content out of a stimulus SVG so it can be nested inside
 * the canonical document. Only valid for stimuli authored on the canonical
 * artboard, which the loader checks before calling this.
 */
export function svgInnerMarkup(source: string) {
  const open = source.search(/<svg[\s>]/i);
  if (open === -1) throw new Error("The stimulus asset is not an SVG document.");
  const openEnd = source.indexOf(">", open);
  const close = source.lastIndexOf("</svg>");
  if (openEnd === -1 || close === -1) throw new Error("The stimulus SVG is malformed.");
  return source
    .slice(openEnd + 1, close)
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

/** Reads width/height/viewBox so a mis-sized stimulus fails loudly at load time. */
export function svgDeclaredSize(source: string) {
  const open = source.slice(0, Math.max(0, source.indexOf(">", source.search(/<svg[\s>]/i))));
  const viewBox = /viewBox\s*=\s*"([^"]+)"/i.exec(open)?.[1];
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return { width: parts[2] - parts[0], height: parts[3] - parts[1] };
    }
  }
  const width = Number(/\bwidth\s*=\s*"(\d+(?:\.\d+)?)"/i.exec(open)?.[1]);
  const height = Number(/\bheight\s*=\s*"(\d+(?:\.\d+)?)"/i.exec(open)?.[1]);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}
