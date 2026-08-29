import { canonicalArtboard, inkColor } from "./artboard";
import type { ForegroundStroke } from "./eraser";
import type { AudraScene } from "./reducer";
import type { Stimulus } from "./stimulus";

export type RenderTargetSize = { width: number; height: number };

export type RenderOptions = {
  scene: AudraScene;
  /** Decoded starter image, or null while it is still loading. */
  background: CanvasImageSource | null;
  size: RenderTargetSize;
};

/**
 * Draws one trial in canonical layer order:
 *   1. opaque white artboard
 *   2. the immutable starter image
 *   3. the actor's foreground strokes
 *
 * Layer 2 is redrawn from the stimulus asset on every frame and is never
 * derived from trial state, so no sequence of events can alter it. Layer 3
 * never composites in a way that could remove layer 2 pixels: the eraser
 * removes stroke geometry before rendering rather than painting white over the
 * canvas, so starter contours survive an eraser pass across them.
 */
export function renderTrial(ctx: CanvasRenderingContext2D, options: RenderOptions) {
  const { scene, background, size } = options;
  const scale = size.width / canonicalArtboard.width;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.fillStyle = canonicalArtboard.backgroundColor;
  ctx.fillRect(0, 0, size.width, size.height);

  if (background) ctx.drawImage(background, 0, 0, size.width, size.height);

  ctx.scale(scale, scale);
  ctx.strokeStyle = inkColor;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of scene.strokes) drawStroke(ctx, stroke);
  ctx.restore();
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: ForegroundStroke) {
  if (stroke.points.length === 0) return;
  ctx.lineWidth = stroke.width;
  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let index = 1; index < stroke.points.length; index += 1) {
    ctx.lineTo(stroke.points[index].x, stroke.points[index].y);
  }
  ctx.stroke();
}

/** Draws the in-progress stroke on top of the committed scene, without touching state. */
export function renderLiveStroke(
  ctx: CanvasRenderingContext2D,
  stroke: ForegroundStroke,
  size: RenderTargetSize
) {
  const scale = size.width / canonicalArtboard.width;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.strokeStyle = inkColor;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawStroke(ctx, stroke);
  ctx.restore();
}

export function loadStimulusImage(stimulus: Stimulus): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "sync";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load stimulus asset ${stimulus.backgroundAsset}`));
    image.src = stimulus.backgroundAsset;
  });
}

/**
 * Renders one trial off-screen at an explicit pixel size. Every exported raster
 * - archival, score input, and each agent observation - goes through this, so
 * they differ only in `size`.
 */
export async function renderTrialToBlob(options: RenderOptions & { mimeType?: string }) {
  const canvas = document.createElement("canvas");
  canvas.width = options.size.width;
  canvas.height = options.size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("A 2D canvas context is unavailable.");
  renderTrial(ctx, options);
  const mimeType = options.mimeType ?? "image/png";
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mimeType));
  if (!blob) throw new Error("Canvas rasterization returned no data.");
  return blob;
}

export function squareSize(pixels: number): RenderTargetSize {
  return { width: pixels, height: pixels };
}

export const canonicalSize = squareSize(canonicalArtboard.width);
