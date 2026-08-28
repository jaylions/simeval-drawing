import type { AudraEvent, StrokePoint } from "./events";
import { boundingBox, polylineLength } from "./geometry";
import { deriveScene, type AudraTrialState } from "./reducer";

/**
 * Normalized action chunks: one record per canonical event, enriched with the
 * process measures a later analysis is likely to want, plus the canvas state
 * that resulted from it.
 *
 * The raw event log stays the source of truth; this is a derived view. Nothing
 * here is fabricated - fields a given actor cannot supply are null rather than
 * filled with a plausible number.
 */
export type ActionChunk = {
  actionIndex: number;
  eventIndex: number;
  eventType: AudraEvent["eventType"];
  actorType: AudraEvent["actorType"];
  actorId: string;
  timestampMs: number;
  /** Gesture duration from pointer sample times. Null for agents: a tool call has no gesture. */
  gestureDurationMs: number | null;
  /** Milliseconds since the previous event, for both actors. */
  sincePreviousMs: number;
  tool: "pencil" | "eraser" | null;
  strokeId: string | null;
  width: number | null;
  pointCount: number | null;
  pathLengthUnits: number | null;
  boundingBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  meanPressure: number | null;
  description: string | null;
  /** The event this undo reverted. */
  undoneEventIndex: number | null;
  /** Whether this event is still in effect at the end of the trial. */
  undone: boolean;
  /** Canvas state after the event, so a chunk is readable without replaying. */
  revisionAfter: number;
  strokeCountAfter: number;
  inkLengthAfterUnits: number;
};

export function normalizeActions(state: AudraTrialState): ActionChunk[] {
  const undone = new Set(state.undoneEventIndices);
  const chunks: ActionChunk[] = [];
  let previousTimestampMs = 0;
  let cursor = { ...state, events: [] as AudraEvent[] };

  for (const [actionIndex, event] of state.events.entries()) {
    // Replaying the prefix keeps the "after" columns exact rather than estimated.
    cursor = { ...cursor, events: state.events.slice(0, actionIndex + 1) };
    const scene = deriveScene({
      ...cursor,
      undoneEventIndices: state.undoneEventIndices.filter(index => index <= event.eventIndex)
    });
    const points = event.payload.points ?? null;

    chunks.push({
      actionIndex,
      eventIndex: event.eventIndex,
      eventType: event.eventType,
      actorType: event.actorType,
      actorId: event.actorId,
      timestampMs: event.timestampMs,
      gestureDurationMs: gestureDuration(points),
      sincePreviousMs: event.timestampMs - previousTimestampMs,
      tool: event.payload.tool ?? null,
      strokeId: event.payload.strokeId ?? null,
      width: event.payload.width ?? null,
      pointCount: points ? points.length : null,
      pathLengthUnits: points ? round(polylineLength(points)) : null,
      boundingBox: points && points.length > 0 ? roundBox(boundingBox(points)) : null,
      meanPressure: meanPressure(points),
      description: event.eventType === "description_update" ? event.payload.description ?? "" : null,
      undoneEventIndex: event.eventType === "undo" ? undoneTargetFor(state, event.eventIndex) : null,
      undone: undone.has(event.eventIndex),
      revisionAfter: actionIndex + 1,
      strokeCountAfter: scene.strokes.length,
      inkLengthAfterUnits: round(
        scene.strokes.reduce((total, stroke) => total + polylineLength(stroke.points), 0)
      )
    });
    previousTimestampMs = event.timestampMs;
  }
  return chunks;
}

/**
 * Which event a given undo reverted. The reducer appends undo targets in order,
 * so the nth undo event corresponds to the nth entry of `undoneEventIndices`.
 */
function undoneTargetFor(state: AudraTrialState, undoEventIndex: number) {
  const undoOrdinal = state.events
    .filter(event => event.eventType === "undo" && event.eventIndex <= undoEventIndex)
    .length - 1;
  return state.undoneEventIndices[undoOrdinal] ?? null;
}

function gestureDuration(points: readonly StrokePoint[] | null) {
  if (!points || points.length < 2) return null;
  const first = points[0].tMs;
  const last = points[points.length - 1].tMs;
  if (first == null || last == null) return null;
  return round(last - first);
}

function meanPressure(points: readonly StrokePoint[] | null) {
  if (!points) return null;
  const readings = points.map(point => point.pressure).filter((value): value is number => value != null);
  if (readings.length === 0) return null;
  return round(readings.reduce((total, value) => total + value, 0) / readings.length, 4);
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundBox(box: { minX: number; minY: number; maxX: number; maxY: number }) {
  return { minX: round(box.minX), minY: round(box.minY), maxX: round(box.maxX), maxY: round(box.maxY) };
}

export function summarizeActions(chunks: readonly ActionChunk[]) {
  const strokes = chunks.filter(chunk => chunk.eventType === "draw_stroke");
  const erases = chunks.filter(chunk => chunk.eventType === "erase_stroke");
  const gestureTimes = strokes
    .map(chunk => chunk.gestureDurationMs)
    .filter((value): value is number => value != null);
  return {
    eventCount: chunks.length,
    drawCount: strokes.length,
    eraseCount: erases.length,
    undoCount: chunks.filter(chunk => chunk.eventType === "undo").length,
    descriptionUpdateCount: chunks.filter(chunk => chunk.eventType === "description_update").length,
    totalPointCount: strokes.reduce((total, chunk) => total + (chunk.pointCount ?? 0), 0),
    totalPathLengthUnits: round(strokes.reduce((total, chunk) => total + (chunk.pathLengthUnits ?? 0), 0)),
    finalStrokeCount: chunks.at(-1)?.strokeCountAfter ?? 0,
    finalInkLengthUnits: chunks.at(-1)?.inkLengthAfterUnits ?? 0,
    trialDurationMs: chunks.at(-1)?.timestampMs ?? 0,
    meanGestureDurationMs: gestureTimes.length > 0
      ? round(gestureTimes.reduce((total, value) => total + value, 0) / gestureTimes.length)
      : null
  };
}
