# AuDrA-style Incomplete Shapes Drawing Task

A task mode for comparing human and agent creative drawing processes on the
same stimulus, under the same allowed operations.

> **The bundled stimulus is a development fixture.** `dev-fixture-01` was drawn
> for interface development. It is **not** an official CAP/MTCI stimulus, is not
> derived from or validated against any published incomplete-shapes instrument,
> and must not be used for analysable data collection. Replace it with the
> official contour set first.

## Running it

```
npm run dev
# human trial
open 'http://localhost:5173/?mode=audra-incomplete-shapes'
```

Anything other than `mode=audra-incomplete-shapes` loads the existing
Excalidraw session app unchanged. The two modes share no canvas, toolbar, or
scene state.

## Architecture of the shared action reducer

Everything that can change a canvas is a **canonical event**. Human pointer
input and agent tool calls both compile to the same event shapes and are
applied by the same pure reducer. Neither path can write canvas state any other
way.

```
human pointer ──> humanInput.strokeDraft ──┐
                                           ├──> reducer.applyEvent ──> AudraTrialState
agent tool call ─> agentTools.toEventDraft ┘         (validate, index, append)
                                                              │
                                                    reducer.deriveScene
                                                              │
                                                        render.renderTrial
                                                    [white | starter image | strokes]
```

State *is* the event log. The visible scene is derived by folding the non-undone
events in order, so any state is reproducible from the log alone. That is what
makes replay and the export bundle deterministic.

| Module | Role |
| --- | --- |
| `src/audra/artboard.ts` | Canonical artboard size, ink colour, width and length limits |
| `src/audra/events.ts` | Canonical event schema and JSONL helpers |
| `src/audra/reducer.ts` | Validation, event indexing, undo, scene derivation, `replay` |
| `src/audra/eraser.ts` | Geometry-based eraser |
| `src/audra/geometry.ts` | Polyline densification and distance helpers |
| `src/audra/render.ts` | Layered browser canvas renderer (human UI) |
| `src/audra/svg.ts` | Canonical scene → SVG, the shared geometry definition |
| `src/audra/stimulus.ts` | `Stimulus` interface and registry |
| `src/audra/humanInput.ts` | Pointer samples → canonical events |
| `src/audra/agentTools.ts` | Agent tool surface → canonical events |
| `src/audra/server/renderer.ts` | Headless SVG → PNG rasterizer (resvg) |
| `src/audra/server/` | Authoritative trial registry and HTTP endpoints |
| `scripts/audraAgentDriver.mjs` | Model-agnostic agent driver, plus a mock trajectory |
| `scripts/audraToolCallParser.mjs` | Tolerant reader for small-model replies |

### Coordinate system

A fixed **1024 × 1024** artboard, origin top-left, x right, y down, for every
trial and both actors. The displayed canvas is only a scaled window onto it;
`humanInput.toArtboardPoint` is the single place display pixels become canonical
units.

### Undo

`undo` reverts the most recent non-undone `draw_stroke` or `erase_stroke`.
Description edits and submission are not undoable. Because undo appends an
event and marks a target index rather than mutating a stack, the log stays a
complete record and replay reproduces the undo exactly. Both actors use this one
implementation.

### Eraser

The eraser is a swept disc along a polyline. Stroke geometry inside the swept
area is removed and the surviving parts remain as separate fragments
(`s1` → `s1~0`, `s1~1`). It is deliberately **not** delete-by-id: an agent
cannot remove a mark it could not reach with a pointer path, and it never
paints white pixels, so starter contours survive an eraser pass across them.

## Immutability of starter contours

The stimulus is referenced only as an **opaque background asset**. No module
holds contour geometry, so there is no code path by which a starter contour
could be hit-tested, selected, erased, moved, or transformed — for either actor.
Immutability is structural rather than a convention or a `locked` flag.

The renderer redraws the background from the asset on every frame, and it is
never derived from trial state, so no sequence of events can alter it.

## Human versus agent interfaces

| | Human | Agent |
| --- | --- | --- |
| Input | Pointer (mouse / pen / touch), coalesced samples | `draw_stroke` / `erase_stroke` polylines |
| Sees | The rendered canvas | A PNG of the same rendered canvas |
| Tools | Pencil, Eraser, Undo Last, description, Submit | The six tools below |
| Validation | `reducer.applyEvent` | `parseAgentToolCall` → `reducer.applyEvent` |

Colours, shape libraries, text boxes, image import, copy/paste, selection and
transform tools, layers, templates, and AI assistance are absent from both.

### Agent tool API

```
observe_canvas()                  → rendered PNG + visible status only
draw_stroke(points, width?)
erase_stroke(points, width?)
undo_last()
set_description(text)
submit_task()
```

`agentToolDefinitions` in `agentTools.ts` is provider-neutral; a local
open-weight server, a hosted API, or a scripted harness each translate it into
their own function schema.

`parseAgentToolCall` rejects unknown tools **and unknown argument fields**, so
an attempt to pass `svg`, `elements`, `href`, `strokeId`, or an `elementId` on a
point fails loudly rather than being silently dropped. Range and width checks
are left to the reducer so agent and human input hit byte-identical validation.

`observe_canvas` returns an image and the status a human could read off the
screen (`canUndo`, `hasDrawingAttempt`, `description`, `submitted`) — never
event counts, element ids, or scene structure.

### HTTP endpoints

Two disjoint groups:

**Agent-facing** — tool calls and rendered observations only:

```
POST /api/audra/trial      {actorId, stimulusId?, agentRun?} → {trialId, contract, renderToken, hostUrl}
POST /api/audra/tool       {trialId, call, isRetry?}          → {revision, status, image}
GET  /api/audra/contract?trialId=
```

**Host-only** — gated by a render token issued once at trial creation and never
returned in a tool response:

```
GET  /api/audra/_host/state?trialId=&token=
POST /api/audra/_host/frame  {trialId, token, revision, base64}
GET  /api/audra/_host/run?trialId=&token=
```

The server holds authoritative state, re-validates every tool call, and renders
observations itself with resvg. **No browser is required for an agent trial**,
which is what makes batch runs across several models practical. Every accepted
call returns the canvas as it now stands, so an agent never acts on a stale
observation.

Opening `hostUrl` in a browser is optional and gives a live view of a running
agent trial; it is no longer part of the render path.

### Two rasterizers, one geometry

`svg.ts` produces the canonical vector definition of a trial. The human UI
rasterizes it through the browser canvas because it needs interactive redraw;
the server rasterizes the same markup with resvg. The geometry, stroke order,
widths, and layer order are identical by construction — only the rasterizing
engine differs, which shows up as sub-pixel antialiasing differences. See the
fairness limitations below.

**The `_host/*` endpoints carry the raw event log and must not be reachable from
the agent's network namespace.** The render token is the control; network
isolation is the backstop.

### Running an agent

```bash
npm run dev                       # terminal 1

# scripted trajectory - verifies the whole loop with no GPU
node scripts/audraAgentDriver.mjs --driver mock --actor-id mock-1

# a local open-weight model behind any OpenAI-compatible server
node scripts/audraAgentDriver.mjs \
  --endpoint http://127.0.0.1:8000/v1/chat/completions \
  --model Qwen3-VL-2B-Instruct \
  --actor-id qwen3vl2b-run1 \
  --temperature 0.7 --top-p 0.9 --seed 1234 \
  --observation-size 768 --max-turns 24 \
  --out runs/
```

The driver is a client like any other: the app server validates everything it
sends. `--driver mock` replaces the model with a fixed trajectory, which is the
fastest way to check the loop after a change.

Small vision models rarely emit clean JSON, so
`scripts/audraToolCallParser.mjs` accepts fenced blocks, surrounding prose, key
aliases (`action`/`name` for `tool`, `description` for `text`), `[x, y]` pairs
as well as `{x, y}` objects, and numeric strings. It never widens the tool
surface: an unrecognised tool name is passed through untouched and rejected by
the server. **Every repair is counted and reported as `driverAssistance` in the
run log**, because leniency the driver grants an agent is help a human
participant does not get.

Each turn sends the system prompt, one image of the current canvas, and a short
text history of previous actions — not an accumulating stack of images, which
2B-class models handle badly.

### Run metadata

Model, checkpoint, decoding parameters, seed, driver, tool-call count, accepted
and rejected counts, observation count, retries, and wall-clock time are kept in
the trial registry and served by `_host/run`, deliberately **separate from the
shared canvas event log**. Rejections are retained with their code and message.

## Event schema

```jsonc
{
  "sessionId": "session-…", "trialId": "trial-…", "stimulusId": "dev-fixture-01",
  "actorType": "human" | "agent", "actorId": "p001",
  "eventIndex": 0,          // assigned by the reducer, never by the actor
  "timestampMs": 1240,      // milliseconds since trial start
  "eventType": "draw_stroke" | "erase_stroke" | "undo" | "submit" | "description_update",
  "payload": {
    "tool": "pencil" | "eraser",
    "strokeId": "human-3",
    "width": 3,
    "points": [{ "x": 200, "y": 200, "tMs": 1240, "pressure": 0.42 }],
    "description": "a lantern over water"
  }
}
```

Human strokes carry raw pointer samples including coalesced ones, with `tMs` per
sample and `pressure` only where the device genuinely reports it. Agent
polylines are recorded in the same coordinate space, without fabricated timing
or pressure.

## Human UI rules

- Instructions are shown before the trial begins.
- During the trial only Pencil, Eraser, Undo Last, the description field, and
  Submit are present.
- Submit opens an explicit confirmation before the trial ends.
- Submission is refused without at least one visible mark. This rule is
  enforced in the reducer (`no_drawing_attempt`) and the refusal is recorded, so
  it is available as a behavioural signal rather than only a UI guard.
- After `submit`, the reducer rejects every further event, so nothing can alter
  the drawing afterwards. There is no auto-save.

## Adding the official starter-contour dataset

1. Put each contour asset in `public/audra/stimuli/`. SVG or PNG, exactly
   1024 × 1024, white background, near-black contours at the same stroke weight
   as the pencil (`#111111`, width 3) so the contours carry no colour, weight,
   or label cue.
2. Register it:

```ts
registerStimulus({
  stimulusId: "cap-03",
  version: "1.0.0",
  source: "official",
  backgroundAsset: "/audra/stimuli/cap-03.svg",
  metadata: { instrument: "CAP", plate: 3 }
});
```

3. Leave `developmentStimulus` registered or remove it; `source` distinguishes
   the two in every export, and the human instruction screen shows a development
   notice whenever `source === "development"`.

No other module needs to change: nothing downstream knows contour geometry.

## Known fairness limitations

These are real and should be reported alongside any comparison.

- **Motor channel.** Humans produce continuous pointer traces; agents emit
  explicit coordinate polylines. Equivalence is claimed for *visible
  information, allowed operations, state transitions, and output constraints* —
  not for motor behaviour. An agent cannot express stroke dynamics, and a human
  cannot specify an exact coordinate.
- **Timing.** Human `tMs` reflects real gesture time; agent timestamps reflect
  when a tool call arrived. Human and agent process durations are not directly
  comparable.
- **Pressure.** Recorded for humans only where the device reports it; never
  synthesised for agents.
- **Observation cost.** A human sees the canvas continuously; an agent must
  spend a tool call on `observe_canvas`. The observation count is logged so this
  asymmetry is measurable rather than hidden.
- **Rasterization.** Humans see a browser-canvas rasterization; agents see a
  resvg rasterization of the same canonical SVG. Geometry is identical;
  antialiasing is not. Scoring inputs should be produced by one engine for the
  whole dataset.
- **Driver leniency.** The tolerant reply parser gives agents retries and
  repairs that a human's pointer does not need. `driverAssistance` and the
  server's `rejections` list quantify it; report both.
- **Prompt scaffolding.** Agents receive the coordinate system and an output
  format in text. This is the information a human gets from simply seeing the
  canvas, but it is not the *same* information, and prompt wording is a real
  experimental variable.
- **Endpoint isolation.** The `_host/*` endpoints are protected by a render
  token, not by authentication. In a deployment where the agent driver shares
  the app's network namespace, that isolation must be enforced at the network
  layer.

## Tests

```
npm run test:audra          # canonical layer
npm run test:audra-driver   # tolerant reply parser
```

`scripts/audraCanonicalIntegrity.test.mjs` covers: human and agent dispatch of
the same actions producing identical geometry and event ordering; replay
determinism; undo semantics and reach; the eraser splitting rather than
deleting; starter contours being unreachable from state; rejection of
unsupported tools and smuggled fields; bounds, width, and submission-guard
parity across actors; and immutability after submission.

`scripts/audraDriverParserIntegrity.test.mjs` covers the reply parser against
the shapes small models actually emit, including the cases that must stay
failures — a reply with no JSON, empty or non-numeric points, and values like
`null`, `true`, or `""` that plain `Number()` would silently turn into `0`.

TypeScript modules are bundled for the test with `scripts/loadTsBundle.mjs`
(esbuild), because the audra modules import each other at runtime rather than
type-only.

## Not yet implemented

Export and replay are still to come:

- `events.jsonl`, `actions.json`, `final_canvas.png` / `.svg`, `description.txt`,
  `session.json` (the canonical SVG and the PNG rasterizer both already exist in
  `svg.ts` and `server/renderer.ts`; only the bundling is missing)
- the AuDrA-compatible export profile — archival PNG plus a deterministic
  resized score-input PNG, with dimensions, scaling, and preprocessing recorded
  in metadata
- the `replay.html` route
- tests for export determinism and for the scoring PNG containing only the
  drawing and starter contour on white
