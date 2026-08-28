import assert from "node:assert/strict";
import { loadTsBundle } from "./loadTsBundle.mjs";

const audra = await loadTsBundle(new URL("../src/audra/index.ts", import.meta.url).pathname);
const {
  applyEvent,
  canonicalArtboard,
  createTrialState,
  deriveScene,
  developmentStimulus,
  eraseFromStrokes,
  hasDrawingAttempt,
  parseAgentToolCall,
  replay,
  strokeDraft,
  toEventDraft
} = audra;

const stimulusId = developmentStimulus.stimulusId;

function trial(actorType, actorId) {
  return createTrialState({
    sessionId: "session-1",
    trialId: "trial-1",
    stimulusId,
    actorType,
    actorId
  });
}

function push(state, draft) {
  const result = applyEvent(state, draft);
  assert.equal(result.ok, true, result.ok ? "" : `unexpectedly rejected: ${result.error}`);
  return result.state;
}

function expectReject(state, draft, code) {
  const result = applyEvent(state, draft);
  assert.equal(result.ok, false, `expected rejection with code ${code}`);
  assert.equal(result.code, code);
  return state;
}

// ---------------------------------------------------------------------------
// Human and agent paths produce replay-equivalent canvas states.
// ---------------------------------------------------------------------------

const script = [
  { kind: "draw", points: [{ x: 200, y: 200 }, { x: 400, y: 420 }, { x: 600, y: 200 }], width: 4 },
  { kind: "draw", points: [{ x: 300, y: 700 }, { x: 500, y: 700 }], width: 3 },
  { kind: "erase", points: [{ x: 380, y: 660 }, { x: 420, y: 740 }], width: 30 },
  { kind: "undo" },
  { kind: "draw", points: [{ x: 700, y: 300 }, { x: 820, y: 380 }], width: 3 },
  { kind: "description", text: "a lantern over water" }
];

function humanState() {
  let state = trial("human", "p001");
  let sequence = 0;
  let timestampMs = 0;
  for (const step of script) {
    timestampMs += 100;
    const context = {
      sessionId: "session-1",
      trialId: "trial-1",
      stimulusId,
      actorId: "p001",
      timestampMs,
      strokeSequence: (sequence += 1)
    };
    if (step.kind === "draw" || step.kind === "erase") {
      state = push(
        state,
        strokeDraft(step.kind === "draw" ? "pencil" : "eraser", step.points, step.width, context)
      );
    } else if (step.kind === "undo") {
      state = push(state, {
        sessionId: "session-1", trialId: "trial-1", stimulusId,
        actorType: "human", actorId: "p001", timestampMs, eventType: "undo", payload: {}
      });
    } else {
      state = push(state, {
        sessionId: "session-1", trialId: "trial-1", stimulusId,
        actorType: "human", actorId: "p001", timestampMs,
        eventType: "description_update", payload: { description: step.text }
      });
    }
  }
  return state;
}

function agentState() {
  let state = trial("agent", "agent-1");
  let sequence = 0;
  let timestampMs = 0;
  for (const step of script) {
    timestampMs += 100;
    const call =
      step.kind === "draw"
        ? { tool: "draw_stroke", points: step.points, width: step.width }
        : step.kind === "erase"
          ? { tool: "erase_stroke", points: step.points, width: step.width }
          : step.kind === "undo"
            ? { tool: "undo_last" }
            : { tool: "set_description", text: step.text };
    const parsed = parseAgentToolCall(call);
    assert.equal(parsed.ok, true, `agent tool call rejected: ${parsed.error ?? ""}`);
    const draft = toEventDraft(parsed.call, {
      sessionId: "session-1",
      trialId: "trial-1",
      stimulusId,
      actorId: "agent-1",
      timestampMs,
      strokeSequence: (sequence += 1)
    });
    state = push(state, draft);
  }
  return state;
}

const human = humanState();
const agent = agentState();

// Geometry, not just event counts: the rendered scene is what gets scored.
function scenePoints(state) {
  return deriveScene(state).strokes.map(stroke => ({
    width: stroke.width,
    points: stroke.points.map(point => [point.x, point.y])
  }));
}

assert.deepEqual(scenePoints(human), scenePoints(agent),
  "human and agent dispatch of the same canonical actions must produce identical geometry");
assert.equal(human.description, agent.description);
assert.equal(human.revision, agent.revision);
assert.deepEqual(
  human.events.map(event => [event.eventIndex, event.eventType]),
  agent.events.map(event => [event.eventIndex, event.eventType]),
  "event ordering must match across actors"
);
// The actor label lives on the events, and only there.
assert.equal(human.events[0].actorType, "human");
assert.equal(agent.events[0].actorType, "agent");

// ---------------------------------------------------------------------------
// Replay is deterministic and reproduces the scene exactly.
// ---------------------------------------------------------------------------

const replayed = replay(
  { sessionId: "session-1", trialId: "trial-1", stimulusId, actorType: "human", actorId: "p001" },
  human.events
);
assert.deepEqual(scenePoints(replayed), scenePoints(human));
assert.deepEqual(replayed.undoneEventIndices, human.undoneEventIndices);
assert.equal(replayed.revision, human.revision);
assert.deepEqual(
  scenePoints(replay({ sessionId: "session-1", trialId: "trial-1", stimulusId, actorType: "human", actorId: "p001" }, human.events)),
  scenePoints(replayed),
  "repeated replay of the same log must be byte-stable"
);

// ---------------------------------------------------------------------------
// Undo has identical semantics for both actors and only reaches mutations.
// ---------------------------------------------------------------------------

{
  let state = trial("human", "p001");
  const base = { sessionId: "session-1", trialId: "trial-1", stimulusId, actorType: "human", actorId: "p001" };
  state = push(state, { ...base, timestampMs: 1, eventType: "draw_stroke",
    payload: { tool: "pencil", strokeId: "s1", width: 3, points: [{ x: 10, y: 10 }, { x: 90, y: 90 }] } });
  state = push(state, { ...base, timestampMs: 2, eventType: "description_update", payload: { description: "kite" } });
  state = push(state, { ...base, timestampMs: 3, eventType: "undo", payload: {} });
  // Undo reached the stroke, not the description.
  assert.equal(deriveScene(state).strokes.length, 0);
  assert.equal(state.description, "kite");
  expectReject(state, { ...base, timestampMs: 4, eventType: "undo", payload: {} }, "nothing_to_undo");
}

// ---------------------------------------------------------------------------
// The eraser is geometry-based and splits strokes rather than deleting objects.
// ---------------------------------------------------------------------------

{
  const stroke = { strokeId: "s1", width: 3, points: [{ x: 100, y: 500 }, { x: 900, y: 500 }] };
  const fragments = eraseFromStrokes([stroke], [{ x: 500, y: 450 }, { x: 500, y: 550 }], 40);
  assert.equal(fragments.length, 2, "an eraser crossing a line's middle must leave two fragments");
  assert.ok(fragments[0].points.at(-1).x < 500 && fragments[1].points[0].x > 500);
  assert.notEqual(fragments[0].strokeId, stroke.strokeId, "fragments get distinct ids");

  // A miss leaves the stroke untouched, id included.
  const untouched = eraseFromStrokes([stroke], [{ x: 100, y: 100 }, { x: 200, y: 100 }], 40);
  assert.deepEqual(untouched, [stroke]);
}

// ---------------------------------------------------------------------------
// Starter contours are unreachable: no event or tool can name or alter them.
// ---------------------------------------------------------------------------

{
  // The trial state carries a stimulus id and nothing else about the stimulus.
  // There is no contour geometry to select, erase, move, or transform.
  const state = human;
  const serialized = JSON.stringify(state);
  assert.ok(serialized.includes(stimulusId));
  assert.equal(deriveScene(state).strokes.every(stroke => stroke.strokeId.startsWith("human-")), true,
    "every stroke in the scene originates from an actor event");

  // Erasing straight across the whole artboard removes actor marks only,
  // because the background is never part of the scene the eraser sees.
  let wiped = trial("human", "p001");
  const base = { sessionId: "session-1", trialId: "trial-1", stimulusId, actorType: "human", actorId: "p001" };
  wiped = push(wiped, { ...base, timestampMs: 1, eventType: "draw_stroke",
    payload: { tool: "pencil", strokeId: "s1", width: 3, points: [{ x: 0, y: 512 }, { x: 1024, y: 512 }] } });
  wiped = push(wiped, { ...base, timestampMs: 2, eventType: "erase_stroke",
    payload: { tool: "eraser", strokeId: "e1", width: 64, points: [{ x: 0, y: 512 }, { x: 1024, y: 512 }] } });
  assert.equal(deriveScene(wiped).strokes.length, 0);
  assert.equal(wiped.stimulusId, stimulusId, "the stimulus reference survives a full-canvas erase");
}

// ---------------------------------------------------------------------------
// The agent tool surface rejects everything outside the human's vocabulary.
// ---------------------------------------------------------------------------

for (const call of [
  { tool: "add_elements", elements: [] },
  { tool: "insert_image", href: "data:image/png;base64,AAA" },
  { tool: "get_scene" },
  { tool: "inspect_canvas" },
  { tool: "delete_element", id: "s1" }
]) {
  const parsed = parseAgentToolCall(call);
  assert.equal(parsed.ok, false, `${call.tool} must be rejected`);
  assert.equal(parsed.code, "unsupported_tool");
}

for (const call of [
  { tool: "draw_stroke", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], svg: "<path/>" },
  { tool: "draw_stroke", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], strokeId: "forged" },
  { tool: "draw_stroke", points: [{ x: 1, y: 1, elementId: "seed_1" }, { x: 2, y: 2 }] },
  { tool: "submit_task", force: true }
]) {
  const parsed = parseAgentToolCall(call);
  assert.equal(parsed.ok, false, "smuggled fields must be rejected");
  assert.equal(parsed.code, "unsupported_field");
}

// observe_canvas is the only read, and it carries no arguments and no state.
assert.deepEqual(parseAgentToolCall({ tool: "observe_canvas" }), { ok: true, call: { tool: "observe_canvas" } });
assert.equal(toEventDraft({ tool: "observe_canvas" }, {
  sessionId: "session-1", trialId: "trial-1", stimulusId, actorId: "agent-1", timestampMs: 0, strokeSequence: 0
}), null, "observe_canvas must not produce a state-changing event");

// ---------------------------------------------------------------------------
// Bounds, widths, and the submission guard apply identically to both actors.
// ---------------------------------------------------------------------------

for (const actorType of ["human", "agent"]) {
  const actorId = actorType === "human" ? "p001" : "agent-1";
  const base = { sessionId: "session-1", trialId: "trial-1", stimulusId, actorType, actorId };
  let state = trial(actorType, actorId);

  expectReject(state, { ...base, timestampMs: 1, eventType: "draw_stroke",
    payload: { tool: "pencil", width: 3, points: [{ x: -1, y: 10 }, { x: 20, y: 20 }] } }, "out_of_bounds");
  expectReject(state, { ...base, timestampMs: 1, eventType: "draw_stroke",
    payload: { tool: "pencil", width: 3, points: [{ x: 10, y: canonicalArtboard.height + 1 }, { x: 20, y: 20 }] } }, "out_of_bounds");
  expectReject(state, { ...base, timestampMs: 1, eventType: "draw_stroke",
    payload: { tool: "pencil", width: 999, points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] } }, "invalid_width");
  expectReject(state, { ...base, timestampMs: 1, eventType: "draw_stroke",
    payload: { tool: "eraser", width: 3, points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] } }, "unsupported_tool");
  expectReject(state, { ...base, timestampMs: 1, eventType: "draw_stroke",
    payload: { tool: "pencil", width: 3, points: [{ x: 10, y: 10 }] } }, "invalid_points");

  // Logged validation rule: no submission without a drawing attempt.
  assert.equal(hasDrawingAttempt(state), false);
  expectReject(state, { ...base, timestampMs: 2, eventType: "submit", payload: {} }, "no_drawing_attempt");

  state = push(state, { ...base, timestampMs: 3, eventType: "draw_stroke",
    payload: { tool: "pencil", strokeId: "s1", width: 3, points: [{ x: 10, y: 10 }, { x: 90, y: 90 }] } });
  state = push(state, { ...base, timestampMs: 4, eventType: "submit", payload: {} });

  // Nothing is accepted after submission, so the drawing cannot be altered.
  expectReject(state, { ...base, timestampMs: 5, eventType: "draw_stroke",
    payload: { tool: "pencil", width: 3, points: [{ x: 10, y: 10 }, { x: 90, y: 90 }] } }, "trial_submitted");
  expectReject(state, { ...base, timestampMs: 6, eventType: "undo", payload: {} }, "trial_submitted");
  expectReject(state, { ...base, timestampMs: 7, eventType: "description_update",
    payload: { description: "changed my mind" } }, "trial_submitted");
}

// An event cannot claim a different actor than the trial it is applied to.
expectReject(trial("human", "p001"), {
  sessionId: "session-1", trialId: "trial-1", stimulusId, actorType: "agent", actorId: "agent-1",
  timestampMs: 1, eventType: "draw_stroke",
  payload: { tool: "pencil", width: 3, points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] }
}, "actor_mismatch");

console.log("audra canonical integrity tests passed");
