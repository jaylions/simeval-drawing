import { canonicalArtboard, eraserWidth, maxDescriptionLength, pencilWidth } from "./artboard";
import type { AudraEventDraft } from "./events";

/**
 * The complete agent-visible surface.
 *
 * Every tool here compiles to one of the same canonical events the human UI
 * emits, so there is no operation an agent can perform that a participant with
 * a pointer could not. There is deliberately no tool that inserts SVG, raster
 * images, text objects, or scene nodes, and no tool that reads trial state:
 * `observe_canvas` returns a rendered image and visible status only.
 */
export type AgentToolName =
  | "observe_canvas"
  | "draw_stroke"
  | "erase_stroke"
  | "undo_last"
  | "set_description"
  | "submit_task";

export type AgentPoint = { x: number; y: number };

export type AgentToolCall =
  | { tool: "observe_canvas" }
  | { tool: "draw_stroke"; points: AgentPoint[]; width?: number }
  | { tool: "erase_stroke"; points: AgentPoint[]; width?: number }
  | { tool: "undo_last" }
  | { tool: "set_description"; text: string }
  | { tool: "submit_task" };

export type ParseResult =
  | { ok: true; call: AgentToolCall }
  | { ok: false; error: string; code: "unsupported_tool" | "unsupported_field" | "invalid_arguments" };

const allowedFields: Record<AgentToolName, readonly string[]> = {
  observe_canvas: [],
  draw_stroke: ["points", "width"],
  erase_stroke: ["points", "width"],
  undo_last: [],
  set_description: ["text"],
  submit_task: []
};

const toolNames = Object.keys(allowedFields) as AgentToolName[];

/**
 * Model-agnostic tool descriptors. Any driver - a local open-weight server, a
 * hosted API, or a scripted harness - can translate these into its own function
 * schema; nothing here is provider-specific.
 */
export const agentToolDefinitions = [
  {
    name: "observe_canvas",
    description:
      "Return a rendered image of the current canvas and the visible task status. This is the only way to see the canvas.",
    parameters: {}
  },
  {
    name: "draw_stroke",
    description:
      `Draw one pencil polyline. Points are in artboard coordinates: x in [0, ${canonicalArtboard.width}], y in [0, ${canonicalArtboard.height}], origin at the top-left, y increasing downward. At least 2 points.`,
    parameters: {
      points: "array of {x, y}",
      width: `optional stroke width, ${pencilWidth.min}-${pencilWidth.max}, default ${pencilWidth.default}`
    }
  },
  {
    name: "erase_stroke",
    description:
      "Erase along a polyline, as if dragging an eraser. Removes only your own marks that fall under the path; the starter lines cannot be erased.",
    parameters: {
      points: "array of {x, y}",
      width: `optional eraser width, ${eraserWidth.min}-${eraserWidth.max}, default ${eraserWidth.default}`
    }
  },
  { name: "undo_last", description: "Undo your most recent draw or erase action.", parameters: {} },
  {
    name: "set_description",
    description: `Record a short answer to "What did you draw?". At most ${maxDescriptionLength} characters.`,
    parameters: { text: "string" }
  },
  {
    name: "submit_task",
    description: "Submit the finished drawing. Requires at least one visible mark. This ends the trial.",
    parameters: {}
  }
] as const;

/**
 * Strict parser. Unknown tools and unknown argument fields are rejected rather
 * than ignored, so an attempt to smuggle `svg`, `image`, `elements`, or
 * `strokeId` into a call fails loudly instead of being silently dropped.
 */
export function parseAgentToolCall(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("invalid_arguments", "A tool call must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const tool = record.tool;
  if (typeof tool !== "string" || !toolNames.includes(tool as AgentToolName)) {
    return fail("unsupported_tool", `Unsupported tool: ${String(tool)}. Available: ${toolNames.join(", ")}.`);
  }
  const name = tool as AgentToolName;

  const extraneous = Object.keys(record).filter(
    key => key !== "tool" && !allowedFields[name].includes(key)
  );
  if (extraneous.length > 0) {
    return fail("unsupported_field", `${name} does not accept: ${extraneous.join(", ")}.`);
  }

  if (name === "observe_canvas" || name === "undo_last" || name === "submit_task") {
    return { ok: true, call: { tool: name } };
  }

  if (name === "set_description") {
    if (typeof record.text !== "string") return fail("invalid_arguments", "set_description requires text: string.");
    return { ok: true, call: { tool: name, text: record.text } };
  }

  const points = record.points;
  if (!Array.isArray(points) || points.length === 0) {
    return fail("invalid_arguments", `${name} requires a non-empty points array.`);
  }
  const parsedPoints: AgentPoint[] = [];
  for (const point of points) {
    if (!point || typeof point !== "object" || Array.isArray(point)) {
      return fail("invalid_arguments", "Each point must be an object with numeric x and y.");
    }
    const candidate = point as Record<string, unknown>;
    const unexpected = Object.keys(candidate).filter(key => key !== "x" && key !== "y");
    if (unexpected.length > 0) {
      return fail("unsupported_field", `A point accepts only x and y, not: ${unexpected.join(", ")}.`);
    }
    if (typeof candidate.x !== "number" || typeof candidate.y !== "number") {
      return fail("invalid_arguments", "Each point must have numeric x and y.");
    }
    parsedPoints.push({ x: candidate.x, y: candidate.y });
  }
  const width = record.width;
  if (width != null && typeof width !== "number") {
    return fail("invalid_arguments", `${name} width must be a number.`);
  }
  return { ok: true, call: { tool: name, points: parsedPoints, width: width as number | undefined } };
}

export type AgentEventContext = {
  sessionId: string;
  trialId: string;
  stimulusId: string;
  actorId: string;
  timestampMs: number;
  /** Monotonic counter used to build a stable strokeId without exposing state. */
  strokeSequence: number;
};

/**
 * Compiles an accepted tool call into a canonical event draft. `observe_canvas`
 * returns null because it changes nothing. Range checks are intentionally left
 * to the reducer so agent and human input hit exactly the same validation.
 */
export function toEventDraft(call: AgentToolCall, context: AgentEventContext): AudraEventDraft | null {
  const base = {
    sessionId: context.sessionId,
    trialId: context.trialId,
    stimulusId: context.stimulusId,
    actorType: "agent" as const,
    actorId: context.actorId,
    timestampMs: context.timestampMs
  };
  switch (call.tool) {
    case "observe_canvas":
      return null;
    case "draw_stroke":
      return {
        ...base,
        eventType: "draw_stroke",
        payload: {
          tool: "pencil",
          strokeId: `agent-${context.strokeSequence}`,
          width: call.width ?? pencilWidth.default,
          points: call.points.map(point => ({ x: point.x, y: point.y }))
        }
      };
    case "erase_stroke":
      return {
        ...base,
        eventType: "erase_stroke",
        payload: {
          tool: "eraser",
          strokeId: `agent-erase-${context.strokeSequence}`,
          width: call.width ?? eraserWidth.default,
          points: call.points.map(point => ({ x: point.x, y: point.y }))
        }
      };
    case "undo_last":
      return { ...base, eventType: "undo", payload: {} };
    case "set_description":
      return { ...base, eventType: "description_update", payload: { description: call.text } };
    case "submit_task":
      return { ...base, eventType: "submit", payload: {} };
  }
}

function fail(code: "unsupported_tool" | "unsupported_field" | "invalid_arguments", error: string): ParseResult {
  return { ok: false, code, error };
}
