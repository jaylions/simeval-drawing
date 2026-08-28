import assert from "node:assert/strict";
import { loadTsBundle } from "./loadTsBundle.mjs";

const audra = await loadTsBundle(new URL("../src/audra/index.ts", import.meta.url).pathname);
const {
  applyEvent,
  audraExportProfile,
  buildTextFiles,
  bundleBaseName,
  createTrialState,
  developmentStimulus,
  normalizeActions,
  parseEventsJsonl,
  replay,
  summarizeActions,
  summarizeThinkAloud,
  validateThinkAloudChunks
} = audra;

function thinkAloudChunk(sequence, overrides = {}) {
  return {
    sessionId: "session-1", trialId: "trial-1", actorType: "human", actorId: "p001",
    sequence, chunkIndex: sequence + 1,
    chunkStartedAtMs: sequence * 10000,
    chunkEndedAtMs: (sequence + 1) * 10000,
    durationMs: 10000,
    content: `spoken segment ${sequence}`,
    transcriptionStatus: "completed",
    revisionAtStart: sequence, revisionAtEnd: sequence + 1,
    audio: { mimeType: "audio/webm", byteSize: 4096, languageCode: "ko-KR", success: true, segments: [] },
    ...overrides
  };
}

const stimulusId = developmentStimulus.stimulusId;
const background = { kind: "svg_fragment", markup: '<path d="M 10 10 L 90 90" stroke="#111111" fill="none"/>' };

function build(actorType, actorId) {
  let state = createTrialState({
    sessionId: "session-1", trialId: "trial-1", stimulusId, actorType, actorId
  });
  const base = { sessionId: "session-1", trialId: "trial-1", stimulusId, actorType, actorId };
  const steps = [
    { eventType: "draw_stroke", payload: { tool: "pencil", strokeId: `${actorType}-1`, width: 3,
      points: [{ x: 100, y: 100 }, { x: 300, y: 400 }, { x: 500, y: 120 }] } },
    { eventType: "draw_stroke", payload: { tool: "pencil", strokeId: `${actorType}-2`, width: 3,
      points: [{ x: 600, y: 600 }, { x: 800, y: 600 }] } },
    { eventType: "erase_stroke", payload: { tool: "eraser", strokeId: `${actorType}-e1`, width: 40,
      points: [{ x: 700, y: 560 }, { x: 700, y: 640 }] } },
    { eventType: "draw_stroke", payload: { tool: "pencil", strokeId: `${actorType}-3`, width: 3,
      points: [{ x: 200, y: 800 }, { x: 400, y: 800 }] } },
    { eventType: "undo", payload: {} },
    { eventType: "description_update", payload: { description: "a bridge over a canyon" } },
    { eventType: "submit", payload: {} }
  ];
  let timestampMs = 0;
  for (const step of steps) {
    timestampMs += 250;
    const result = applyEvent(state, { ...base, timestampMs, ...step });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    state = result.state;
  }
  return state;
}

function context(state, overrides = {}) {
  return {
    state,
    stimulus: developmentStimulus,
    background,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
    exportedAt: "2026-01-01T00:05:01.000Z",
    appVersion: "0.1.0",
    appCommit: "abcdef123456",
    replayRuntimeJs: "/* runtime */",
    ...overrides
  };
}

function fileMap(files) {
  return Object.fromEntries(files.map(file => [file.name, file.content]));
}

const human = build("human", "p001");
const agent = build("agent", "agent-1");

// ---------------------------------------------------------------------------
// Every required artefact is present.
// ---------------------------------------------------------------------------

const humanFiles = fileMap(buildTextFiles(context(human)));
for (const name of [
  "events.jsonl", "actions.json", "final_canvas.svg", "description.txt", "session.json", "replay.html"
]) {
  assert.ok(name in humanFiles, `missing ${name}`);
  assert.ok(humanFiles[name].length > 0, `${name} is empty`);
}
assert.equal(humanFiles["description.txt"], "a bridge over a canyon\n");

// ---------------------------------------------------------------------------
// Export is deterministic: same log in, byte-identical bundle out.
// ---------------------------------------------------------------------------

assert.deepEqual(fileMap(buildTextFiles(context(human))), humanFiles,
  "rebuilding a bundle from the same log must be byte-identical");
assert.equal(bundleBaseName(human, "2026-01-01T00:00:00.000Z"),
  bundleBaseName(human, "2026-01-01T00:00:00.000Z"));

// Replaying the log and re-exporting also reproduces the bundle exactly.
const replayed = replay(
  { sessionId: "session-1", trialId: "trial-1", stimulusId, actorType: "human", actorId: "p001" },
  human.events
);
assert.deepEqual(fileMap(buildTextFiles(context(replayed))), humanFiles,
  "export after replay must match export before replay");

// ---------------------------------------------------------------------------
// events.jsonl round-trips and preserves ordering.
// ---------------------------------------------------------------------------

const parsed = parseEventsJsonl(humanFiles["events.jsonl"]);
assert.deepEqual(parsed, [...human.events]);
assert.deepEqual(parsed.map(event => event.eventIndex), parsed.map((_, index) => index));

// ---------------------------------------------------------------------------
// Human and agent runs of the same geometry export an identical canvas.
// ---------------------------------------------------------------------------

const agentFiles = fileMap(buildTextFiles(context(agent)));
const stripIds = (svg) => svg.replace(/(human|agent)-\d+/g, "id");
assert.equal(stripIds(humanFiles["final_canvas.svg"]), stripIds(agentFiles["final_canvas.svg"]),
  "the same canonical actions must export the same canvas for either actor");

// ---------------------------------------------------------------------------
// The scoring image carries the drawing and starter contour, and nothing else.
// ---------------------------------------------------------------------------

const svg = humanFiles["final_canvas.svg"];
assert.ok(svg.includes('fill="#ffffff"'), "the artboard must be painted white");
assert.ok(svg.includes('id="starter-contours"'), "the starter contour layer must be present");
assert.ok(svg.includes('id="actor-marks"'), "the actor layer must be present");
// White background is painted before the contours, which are painted before marks.
assert.ok(svg.indexOf('fill="#ffffff"') < svg.indexOf('id="starter-contours"'));
assert.ok(svg.indexOf('id="starter-contours"') < svg.indexOf('id="actor-marks"'));

for (const forbidden of ["<text", "<foreignObject", "<title", "<desc", "<metadata"]) {
  assert.ok(!svg.includes(forbidden), `the scoring image must not contain ${forbidden}`);
}
// No actor identity, task wording, or timing is rendered into the image.
for (const leak of ["p001", "agent-1", "human", "agent", "session-1", "trial-1", "creative", "2026-01-01"]) {
  assert.ok(!svg.includes(leak), `the scoring image must not contain "${leak}"`);
}

// ---------------------------------------------------------------------------
// session.json records the actor, and only session.json does.
// ---------------------------------------------------------------------------

const session = JSON.parse(humanFiles["session.json"]);
assert.equal(session.trial.actorType, "human");
assert.equal(session.trial.actorId, "p001");
assert.equal(JSON.parse(agentFiles["session.json"]).trial.actorType, "agent");
assert.equal(session.trial.completed, true);
assert.equal(session.stimulus.source, "development");
assert.equal(session.stimulus.isOfficialInstrument, false,
  "the development fixture must never be reported as an official instrument");

// Export dimensions, scaling, and preprocessing are recorded.
assert.equal(session.exportProfile.archivalPixels, audraExportProfile.archivalPixels);
assert.equal(session.exportProfile.scorePixels, audraExportProfile.scorePixels);
assert.equal(session.exportProfile.includesUiChrome, false);
assert.equal(session.exportProfile.includesActorLabel, false);
assert.equal(session.exportProfile.embeddedMetadata, "none");
assert.ok(session.exportProfile.resizePolicy.includes("not downsampled"));
assert.equal(session.taskConfiguration.artboard.width, 1024);
assert.equal(session.taskConfiguration.eraserImplementation, "geometry_based_swept_disc");

// ---------------------------------------------------------------------------
// Normalized action chunks describe the process without inventing data.
// ---------------------------------------------------------------------------

const actions = normalizeActions(human);
assert.equal(actions.length, human.events.length);
assert.deepEqual(actions.map(chunk => chunk.eventIndex), human.events.map(event => event.eventIndex));

const undoChunk = actions.find(chunk => chunk.eventType === "undo");
assert.equal(undoChunk.undoneEventIndex, 3, "undo must name the event it reverted");
assert.equal(actions[3].undone, true, "the reverted event is marked undone");
assert.equal(actions[0].undone, false);

// The eraser split one stroke into two fragments, so the count rose.
assert.equal(actions[1].strokeCountAfter, 2);
assert.equal(actions[2].strokeCountAfter, 3);

// Agents have no gesture: the field is null rather than a fabricated duration.
for (const chunk of normalizeActions(agent)) {
  assert.equal(chunk.gestureDurationMs, null);
  assert.equal(chunk.meanPressure, null);
}
assert.equal(summarizeActions(normalizeActions(agent)).meanGestureDurationMs, null);

// A human stroke carrying pointer sample times reports a real duration.
{
  let state = createTrialState({
    sessionId: "s", trialId: "t", stimulusId, actorType: "human", actorId: "p002"
  });
  const result = applyEvent(state, {
    sessionId: "s", trialId: "t", stimulusId, actorType: "human", actorId: "p002",
    timestampMs: 900, eventType: "draw_stroke",
    payload: { tool: "pencil", strokeId: "h1", width: 3, points: [
      { x: 10, y: 10, tMs: 400, pressure: 0.4 },
      { x: 60, y: 60, tMs: 900, pressure: 0.6 }
    ] }
  });
  assert.equal(result.ok, true);
  const chunk = normalizeActions(result.state)[0];
  assert.equal(chunk.gestureDurationMs, 500);
  assert.equal(chunk.meanPressure, 0.5);
}

// ---------------------------------------------------------------------------
// replay.html embeds the log and cannot be closed early by its own payload.
// ---------------------------------------------------------------------------

const replayHtml = humanFiles["replay.html"];
assert.ok(replayHtml.includes("__AUDRA_REPLAY__"));
assert.ok(replayHtml.includes('id="replay-root"'));
const payloadStart = replayHtml.indexOf("__AUDRA_REPLAY__");
const payloadEnd = replayHtml.indexOf("</script>", payloadStart);
assert.ok(payloadEnd > payloadStart, "the data script must terminate");
assert.ok(!replayHtml.slice(payloadStart, payloadEnd).includes("</"),
  "embedded data must be escaped so it cannot close the script tag");

{
  // A description containing a closing script tag must not break the document.
  let state = createTrialState({
    sessionId: "s", trialId: "t", stimulusId, actorType: "human", actorId: "p003"
  });
  const base = { sessionId: "s", trialId: "t", stimulusId, actorType: "human", actorId: "p003" };
  state = applyEvent(state, { ...base, timestampMs: 1, eventType: "draw_stroke",
    payload: { tool: "pencil", strokeId: "h1", width: 3, points: [{ x: 1, y: 1 }, { x: 9, y: 9 }] } }).state;
  state = applyEvent(state, { ...base, timestampMs: 2, eventType: "description_update",
    payload: { description: "</script><img src=x onerror=alert(1)>" } }).state;
  const html = fileMap(buildTextFiles(context(state)))["replay.html"];
  const start = html.indexOf("__AUDRA_REPLAY__");
  assert.ok(!html.slice(start, html.indexOf("</script>", start)).includes("</script>"));
}

// ---------------------------------------------------------------------------
// Human think-aloud is exported beside the event log, never inside it.
// ---------------------------------------------------------------------------

{
  const chunks = [thinkAloudChunk(0), thinkAloudChunk(1)];
  const files = fileMap(buildTextFiles(context(human, {
    thinkAloud: chunks, audioFileName: "thinkaloud_audio.webm"
  })));

  assert.ok("thinkaloud.jsonl" in files, "a trial with audio must export a think-aloud trace");
  const lines = files["thinkaloud.jsonl"].trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].content, "spoken segment 0");
  // The trace links speech to the canvas state it accompanied.
  assert.equal(lines[0].revisionAtStart, 0);
  assert.equal(lines[1].revisionAtEnd, 2);

  // Spoken content must not reach the event log or the scoring image.
  assert.ok(!files["events.jsonl"].includes("spoken segment"));
  assert.ok(!files["final_canvas.svg"].includes("spoken segment"));
  assert.ok(!files["replay.html"].includes("spoken segment"));

  const session = JSON.parse(files["session.json"]);
  assert.equal(session.thinkAloud.chunkCount, 2);
  assert.equal(session.thinkAloud.transcribedChunks, 2);
  assert.equal(session.thinkAloud.audioFileName, "thinkaloud_audio.webm");
  assert.deepEqual(session.thinkAloud.validationErrors, []);

  // Both actors' process traces sit in the same place in session.json, so a
  // comparison does not have to special-case one of them.
  assert.equal(JSON.parse(files["session.json"]).agentRun, null);
  assert.notEqual(session.thinkAloud, null);
}

// A trial without audio exports no think-aloud file and reports none.
{
  const files = fileMap(buildTextFiles(context(human)));
  assert.ok(!("thinkaloud.jsonl" in files));
  assert.equal(JSON.parse(files["session.json"]).thinkAloud, null);
}

// Validation catches the traces that would silently corrupt an analysis.
{
  assert.deepEqual(validateThinkAloudChunks([thinkAloudChunk(0), thinkAloudChunk(1)]), []);

  const outOfOrder = validateThinkAloudChunks([thinkAloudChunk(1), thinkAloudChunk(0)]);
  assert.ok(outOfOrder.some(error => error.includes("out of order")));

  const stillPending = validateThinkAloudChunks([
    thinkAloudChunk(0, { transcriptionStatus: "pending" })
  ]);
  assert.ok(stillPending.some(error => error.includes("before transcription finished")));

  const overlapping = validateThinkAloudChunks([
    thinkAloudChunk(0),
    thinkAloudChunk(1, { chunkStartedAtMs: 5000 })
  ]);
  assert.ok(overlapping.some(error => error.includes("overlaps")));

  const silent = validateThinkAloudChunks([thinkAloudChunk(0, {
    audio: { mimeType: "audio/webm", byteSize: 0, languageCode: "", success: false, segments: [] }
  })]);
  assert.ok(silent.some(error => error.includes("no audio")));
}

// A failed transcription keeps its audio and its reason rather than vanishing.
{
  const failed = thinkAloudChunk(0, {
    content: "",
    transcriptionStatus: "failed",
    audio: { mimeType: "audio/webm", byteSize: 4096, languageCode: "", success: false,
             error: "STT credentials are not configured.", segments: [] }
  });
  const summary = summarizeThinkAloud([failed]);
  assert.equal(summary.failedChunks, 1);
  assert.equal(summary.transcribedChunks, 0);
  assert.equal(summary.totalBytes, 4096, "audio is retained even when transcription fails");
  const files = fileMap(buildTextFiles(context(human, { thinkAloud: [failed] })));
  assert.ok(files["thinkaloud.jsonl"].includes("STT credentials are not configured."));
}

console.log("audra export integrity tests passed");
