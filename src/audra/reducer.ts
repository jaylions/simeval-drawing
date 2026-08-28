import {
  canonicalArtboard,
  eraserWidth,
  maxDescriptionLength,
  maxPointsPerStroke,
  pencilWidth
} from "./artboard";
import { eraseFromStrokes, type ForegroundStroke } from "./eraser";
import {
  isUndoableEventType,
  type AudraActorType,
  type AudraEvent,
  type AudraEventDraft,
  type StrokePoint
} from "./events";

/**
 * The single state-transition layer for the incomplete-shapes task.
 *
 * Human pointer input and agent tool calls both build an `AudraEventDraft` and
 * hand it to `applyEvent`. Neither path can reach canvas state any other way,
 * so the two actors are subject to byte-identical validation, undo semantics,
 * and geometry.
 *
 * The state is the event log. The visible scene is derived by folding the
 * non-undone events in order, which makes every state reproducible from the
 * log alone - that is what `replay` and the export bundle rely on.
 */
export type AudraTrialState = {
  sessionId: string;
  trialId: string;
  stimulusId: string;
  actorType: AudraActorType;
  actorId: string;
  events: readonly AudraEvent[];
  /** `eventIndex` values reverted by `undo`, in the order they were reverted. */
  undoneEventIndices: readonly number[];
  description: string;
  submittedAtMs: number | null;
  /** Increments on every accepted state-changing event. Snapshot boundary key. */
  revision: number;
};

export type AudraScene = {
  strokes: readonly ForegroundStroke[];
};

export type ApplyResult =
  | { ok: true; state: AudraTrialState; event: AudraEvent }
  | { ok: false; error: string; code: RejectionCode };

export type RejectionCode =
  | "trial_submitted"
  | "unsupported_event"
  | "unsupported_tool"
  | "invalid_points"
  | "out_of_bounds"
  | "invalid_width"
  | "nothing_to_undo"
  | "no_drawing_attempt"
  | "invalid_description"
  | "actor_mismatch";

export function createTrialState(input: {
  sessionId: string;
  trialId: string;
  stimulusId: string;
  actorType: AudraActorType;
  actorId: string;
}): AudraTrialState {
  return {
    ...input,
    events: [],
    undoneEventIndices: [],
    description: "",
    submittedAtMs: null,
    revision: 0
  };
}

export function applyEvent(state: AudraTrialState, draft: AudraEventDraft): ApplyResult {
  if (draft.actorType !== state.actorType || draft.actorId !== state.actorId) {
    return reject("actor_mismatch", "The event actor does not match the trial actor.");
  }
  if (state.submittedAtMs != null) {
    return reject("trial_submitted", "The trial is already submitted and no longer accepts events.");
  }

  const validation = validateDraft(state, draft);
  if (validation) return validation;

  const event: AudraEvent = {
    sessionId: state.sessionId,
    trialId: state.trialId,
    stimulusId: state.stimulusId,
    actorType: draft.actorType,
    actorId: draft.actorId,
    eventIndex: state.events.length,
    timestampMs: draft.timestampMs,
    eventType: draft.eventType,
    payload: normalizePayload(draft)
  };

  const events = [...state.events, event];
  let undoneEventIndices = state.undoneEventIndices;
  let description = state.description;
  // Narrowed to null by the guard above; widened so `submit` can set a time.
  let submittedAtMs: number | null = state.submittedAtMs;

  if (draft.eventType === "undo") {
    const target = lastUndoableIndex(state);
    // validateDraft already guaranteed a target exists.
    undoneEventIndices = [...undoneEventIndices, target!];
  } else if (draft.eventType === "description_update") {
    description = event.payload.description ?? "";
  } else if (draft.eventType === "submit") {
    submittedAtMs = event.timestampMs;
  }

  return {
    ok: true,
    event,
    state: {
      ...state,
      events,
      undoneEventIndices,
      description,
      submittedAtMs,
      revision: state.revision + 1
    }
  };
}

/** Folds the non-undone event log into the visible foreground scene. */
export function deriveScene(state: AudraTrialState): AudraScene {
  const undone = new Set(state.undoneEventIndices);
  let strokes: ForegroundStroke[] = [];
  for (const event of state.events) {
    if (undone.has(event.eventIndex)) continue;
    if (event.eventType === "draw_stroke") {
      strokes = [
        ...strokes,
        {
          strokeId: event.payload.strokeId!,
          width: event.payload.width ?? pencilWidth.default,
          points: (event.payload.points ?? []).map(point => ({ ...point }))
        }
      ];
    } else if (event.eventType === "erase_stroke") {
      strokes = eraseFromStrokes(
        strokes,
        event.payload.points ?? [],
        event.payload.width ?? eraserWidth.default
      );
    }
  }
  return { strokes };
}

/** True once the actor has produced at least one visible mark. Gates submission. */
export function hasDrawingAttempt(state: AudraTrialState) {
  return deriveScene(state).strokes.length > 0;
}

export function canUndo(state: AudraTrialState) {
  return lastUndoableIndex(state) != null;
}

/** Rebuilds a trial from its raw log. Used by replay and by the export tests. */
export function replay(
  base: Pick<AudraTrialState, "sessionId" | "trialId" | "stimulusId" | "actorType" | "actorId">,
  events: readonly AudraEvent[]
): AudraTrialState {
  let state = createTrialState(base);
  for (const event of events) {
    const result = applyEvent(state, {
      sessionId: event.sessionId,
      trialId: event.trialId,
      stimulusId: event.stimulusId,
      actorType: event.actorType,
      actorId: event.actorId,
      timestampMs: event.timestampMs,
      eventType: event.eventType,
      payload: event.payload
    });
    if (!result.ok) throw new Error(`Replay rejected event ${event.eventIndex}: ${result.error}`);
    if (result.event.eventIndex !== event.eventIndex) {
      throw new Error(`Replay reindexed event ${event.eventIndex} as ${result.event.eventIndex}.`);
    }
    state = result.state;
  }
  return state;
}

function lastUndoableIndex(state: AudraTrialState) {
  const undone = new Set(state.undoneEventIndices);
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (!isUndoableEventType(event.eventType)) continue;
    if (undone.has(event.eventIndex)) continue;
    return event.eventIndex;
  }
  return null;
}

function validateDraft(state: AudraTrialState, draft: AudraEventDraft): ApplyResult | null {
  switch (draft.eventType) {
    case "draw_stroke":
      return validateStroke(draft, "pencil", pencilWidth.min, pencilWidth.max, 2);
    case "erase_stroke":
      return validateStroke(draft, "eraser", eraserWidth.min, eraserWidth.max, 1);
    case "undo":
      return lastUndoableIndex(state) == null
        ? reject("nothing_to_undo", "There is no draw or erase action left to undo.")
        : null;
    case "description_update": {
      const description = draft.payload.description;
      if (typeof description !== "string") {
        return reject("invalid_description", "description must be a string.");
      }
      if (description.length > maxDescriptionLength) {
        return reject(
          "invalid_description",
          `description must be at most ${maxDescriptionLength} characters.`
        );
      }
      return null;
    }
    case "submit":
      // Logged validation rule: a trial cannot be submitted without a drawing attempt.
      return hasDrawingAttempt(state)
        ? null
        : reject("no_drawing_attempt", "Submission requires at least one visible mark on the canvas.");
    default:
      return reject("unsupported_event", `Unsupported event type: ${String(draft.eventType)}`);
  }
}

function validateStroke(
  draft: AudraEventDraft,
  expectedTool: "pencil" | "eraser",
  minWidth: number,
  maxWidth: number,
  minPoints: number
): ApplyResult | null {
  if (draft.payload.tool !== expectedTool) {
    return reject("unsupported_tool", `${draft.eventType} requires tool "${expectedTool}".`);
  }
  const points = draft.payload.points;
  if (!Array.isArray(points) || points.length < minPoints) {
    return reject("invalid_points", `${draft.eventType} requires at least ${minPoints} point(s).`);
  }
  if (points.length > maxPointsPerStroke) {
    return reject("invalid_points", `A stroke may contain at most ${maxPointsPerStroke} points.`);
  }
  for (const point of points) {
    if (!isFiniteNumber(point?.x) || !isFiniteNumber(point?.y)) {
      return reject("invalid_points", "Every point requires finite numeric x and y.");
    }
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.x > canonicalArtboard.width ||
      point.y > canonicalArtboard.height
    ) {
      return reject(
        "out_of_bounds",
        `Point (${point.x}, ${point.y}) lies outside the ${canonicalArtboard.width}x${canonicalArtboard.height} artboard.`
      );
    }
  }
  const width = draft.payload.width;
  if (width != null && (!isFiniteNumber(width) || width < minWidth || width > maxWidth)) {
    return reject("invalid_width", `width must be between ${minWidth} and ${maxWidth}.`);
  }
  return null;
}

function normalizePayload(draft: AudraEventDraft): AudraEvent["payload"] {
  const { eventType, payload } = draft;
  if (eventType === "draw_stroke" || eventType === "erase_stroke") {
    const isPencil = eventType === "draw_stroke";
    return {
      tool: isPencil ? "pencil" : "eraser",
      strokeId: payload.strokeId ?? `${eventType}-${draft.timestampMs}`,
      width: payload.width ?? (isPencil ? pencilWidth.default : eraserWidth.default),
      points: (payload.points ?? []).map(normalizePoint)
    };
  }
  if (eventType === "description_update") return { description: payload.description ?? "" };
  return {};
}

function normalizePoint(point: StrokePoint): StrokePoint {
  const normalized: StrokePoint = { x: point.x, y: point.y };
  if (point.tMs != null) normalized.tMs = point.tMs;
  if (point.pressure != null) normalized.pressure = point.pressure;
  return normalized;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function reject(code: RejectionCode, error: string): ApplyResult {
  return { ok: false, code, error };
}
