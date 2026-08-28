// Canonical event schema shared by the human UI and the agent tool API.
//
// This is the only vocabulary either actor has. Nothing reaches canvas state
// except by becoming one of these events and passing through the reducer.

export const audraSchemaVersion = "audra-incomplete-shapes-v1" as const;

export type AudraActorType = "human" | "agent";

export type StrokePoint = {
  x: number;
  y: number;
  /** Milliseconds since trial start. Present for human pointer samples. */
  tMs?: number;
  /** Normalized 0..1 pointer pressure where the input device reports it. */
  pressure?: number;
};

export type AudraEventType =
  | "draw_stroke"
  | "erase_stroke"
  | "undo"
  | "submit"
  | "description_update";

export type AudraEventPayload = {
  tool?: "pencil" | "eraser";
  strokeId?: string;
  points?: StrokePoint[];
  width?: number;
  description?: string;
};

export type AudraEvent = {
  sessionId: string;
  trialId: string;
  stimulusId: string;
  actorType: AudraActorType;
  actorId: string;
  eventIndex: number;
  timestampMs: number;
  eventType: AudraEventType;
  payload: AudraEventPayload;
};

/** What a caller submits. `eventIndex` is assigned by the reducer, never by the actor. */
export type AudraEventDraft = Omit<AudraEvent, "eventIndex">;

/** Mutating events are the only ones `undo` can reach. */
export const undoableEventTypes = ["draw_stroke", "erase_stroke"] as const;

export function isUndoableEventType(eventType: AudraEventType) {
  return (undoableEventTypes as readonly string[]).includes(eventType);
}

export function toEventsJsonl(events: readonly AudraEvent[]) {
  return events.map(event => JSON.stringify(event)).join("\n");
}

export function parseEventsJsonl(jsonl: string): AudraEvent[] {
  return jsonl
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as AudraEvent);
}
