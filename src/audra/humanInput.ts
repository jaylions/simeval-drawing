import { canonicalArtboard, eraserWidth, pencilWidth } from "./artboard";
import type { AudraEventDraft, StrokePoint } from "./events";

export type HumanTool = "pencil" | "eraser";

export type HumanEventContext = {
  sessionId: string;
  trialId: string;
  stimulusId: string;
  actorId: string;
  timestampMs: number;
  strokeSequence: number;
};

/**
 * Maps a raw pointer event onto the canonical artboard.
 *
 * The displayed canvas is only a scaled window onto the artboard, so this is
 * the single place where display pixels become canonical units. Coordinates are
 * clamped rather than dropped: a pointer that grazes the edge should still
 * leave the mark the participant intended.
 */
export function toArtboardPoint(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  sample: { tMs: number; pressure?: number }
): StrokePoint {
  const scaleX = canonicalArtboard.width / bounds.width;
  const scaleY = canonicalArtboard.height / bounds.height;
  const point: StrokePoint = {
    x: clamp((clientX - bounds.left) * scaleX, 0, canonicalArtboard.width),
    y: clamp((clientY - bounds.top) * scaleY, 0, canonicalArtboard.height),
    tMs: sample.tMs
  };
  // Devices without pressure report a constant 0.5; recording it would be a
  // fabricated signal, so only genuine readings are kept.
  if (sample.pressure != null && sample.pressure > 0 && sample.pressure !== 0.5) {
    point.pressure = sample.pressure;
  }
  return point;
}

/** Human strokes become the exact event shape the agent tools compile to. */
export function strokeDraft(
  tool: HumanTool,
  points: readonly StrokePoint[],
  width: number,
  context: HumanEventContext
): AudraEventDraft {
  return {
    sessionId: context.sessionId,
    trialId: context.trialId,
    stimulusId: context.stimulusId,
    actorType: "human",
    actorId: context.actorId,
    timestampMs: context.timestampMs,
    eventType: tool === "pencil" ? "draw_stroke" : "erase_stroke",
    payload: {
      tool,
      strokeId: `human-${tool === "pencil" ? "" : "erase-"}${context.strokeSequence}`,
      width,
      points: points.map(point => ({ ...point }))
    }
  };
}

export function controlDraft(
  eventType: "undo" | "submit" | "description_update",
  context: HumanEventContext,
  description?: string
): AudraEventDraft {
  return {
    sessionId: context.sessionId,
    trialId: context.trialId,
    stimulusId: context.stimulusId,
    actorType: "human",
    actorId: context.actorId,
    timestampMs: context.timestampMs,
    eventType,
    payload: eventType === "description_update" ? { description: description ?? "" } : {}
  };
}

export function defaultWidthFor(tool: HumanTool) {
  return tool === "pencil" ? pencilWidth.default : eraserWidth.default;
}

/**
 * A tap produces a single pointer sample, but a stroke needs two points to be
 * drawable. Duplicating the sample yields a round dot of the pencil's width,
 * which is what the participant saw under their finger.
 */
export function ensureDrawablePoints(points: readonly StrokePoint[]): StrokePoint[] {
  if (points.length === 0) return [];
  if (points.length >= 2) return points.map(point => ({ ...point }));
  return [{ ...points[0] }, { ...points[0] }];
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}
