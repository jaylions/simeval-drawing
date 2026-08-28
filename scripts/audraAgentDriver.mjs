#!/usr/bin/env node
// Driver for the audra-incomplete-shapes agent path.
//
// Talks to any OpenAI-compatible /v1/chat/completions server (vLLM, llama.cpp,
// LM Studio, Ollama), so the model is a configuration choice rather than a code
// dependency. `--driver mock` runs a scripted trajectory instead, which
// exercises the whole loop without a GPU.
//
// The app server validates every call; this driver is deliberately not trusted.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractReasoning, extractToolCall, stripThinkTags } from "./audraToolCallParser.mjs";

const defaults = {
  base: "http://127.0.0.1:5173",
  endpoint: "http://127.0.0.1:8000/v1/chat/completions",
  model: "qwen3-vl-2b",
  driver: "openai",
  actorId: "agent",
  stimulus: "dev-fixture-01",
  maxTurns: 24,
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 512,
  observationSize: 768,
  seed: null,
  apiKey: null,
  out: null,
  checkpoint: null,
  export: "true"
};

function parseArgs(argv) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in options)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    index += 1;
    const numeric = ["maxTurns", "temperature", "topP", "maxTokens", "observationSize", "seed"];
    options[key] = numeric.includes(key) ? Number(value) : value;
  }
  return options;
}

const systemPrompt = `You are drawing on a square canvas that already contains four unfinished lines.

Your task: use ALL four starting lines as part of ONE creative drawing. Be as creative as you can.

Coordinates: x from 0 (left) to 1024 (right), y from 0 (top) to 1024 (bottom).

Reply with exactly ONE JSON object. Always include "thought": one or two
sentences saying what you see and why you chose this action.

{"thought":"...","tool":"draw_stroke","points":[[x,y],[x,y],...],"width":4}
{"thought":"...","tool":"erase_stroke","points":[[x,y],[x,y],...],"width":24}
{"thought":"...","tool":"undo_last"}
{"thought":"...","tool":"set_description","text":"what you drew"}
{"thought":"...","tool":"submit_task"}

Rules:
- draw_stroke needs at least 2 points. Long curves need many points.
- You cannot move or erase the four starting lines.
- Draw several strokes before finishing.
- When the drawing is done: set_description, then submit_task.`;

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function callModel(options, imageBase64, historyText) {
  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: `${historyText}\n\nThis is the canvas right now. What is your next action?` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } }
      ]
    }
  ];
  const body = {
    model: options.model,
    messages,
    temperature: options.temperature,
    top_p: options.topP,
    max_tokens: options.maxTokens
  };
  if (options.seed != null && Number.isFinite(options.seed)) body.seed = options.seed;

  const headers = { "Content-Type": "application/json" };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  const startedAt = Date.now();
  const response = await fetch(options.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Model server returned ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  const choice = payload.choices?.[0] ?? {};
  const message = choice.message ?? {};
  return {
    content: message.content ?? "",
    message,
    finishReason: choice.finish_reason ?? null,
    usage: payload.usage ?? null,
    latencyMs: Date.now() - startedAt
  };
}

/** A fixed trajectory used to verify the loop without a model. */
const mockScript = [
  { thought: "The broken arch reads as the top of a lantern; I will close its body.", tool: "draw_stroke", points: [[187, 259], [150, 430], [250, 540], [413, 470], [413, 259]], width: 4 },
  { thought: "The zigzag can be a second lantern with a folded paper shade.", tool: "draw_stroke", points: [[640, 200], [610, 430], [880, 430], [880, 290]], width: 4 },
  { thought: "Boxing the wave turns it into water inside a tank.", tool: "draw_stroke", points: [[170, 690], [170, 800], [470, 800], [470, 690]], width: 4 },
  { thought: "The hook becomes a small creature curled on the ground.", tool: "draw_stroke", points: [[700, 820], [660, 900], [860, 900], [840, 860]], width: 4 },
  { thought: "The tank base is too heavy; I will open a gap in it.", tool: "erase_stroke", points: [[300, 800], [340, 800]], width: 24 },
  { thought: "Naming the scene now that all four starting lines are used.", tool: "set_description", text: "four lanterns floating above a river" },
  { thought: "Every starting line is part of the drawing, so I am done.", tool: "submit_task" }
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  const created = await postJson(`${options.base}/api/audra/trial`, {
    actorId: options.actorId,
    stimulusId: options.stimulus,
    observationSize: options.observationSize,
    agentRun: {
      model: options.driver === "mock" ? "mock-script" : options.model,
      checkpoint: options.checkpoint,
      seed: options.seed,
      driver: options.driver,
      decodingParameters:
        options.driver === "mock"
          ? null
          : { temperature: options.temperature, top_p: options.topP, max_tokens: options.maxTokens }
    }
  });
  if (!created.payload.ok) throw new Error(`Trial creation failed: ${JSON.stringify(created.payload)}`);
  const { trialId, renderToken } = created.payload;
  console.log(`trial ${trialId}  stimulus ${options.stimulus}  driver ${options.driver}`);

  const turns = [];
  let parseRepairs = 0;
  let parseFailures = 0;
  const history = [];

  // Seed the loop with an observation, exactly as a participant opening the page.
  let observation = await postJson(`${options.base}/api/audra/tool`, {
    trialId,
    call: { tool: "observe_canvas" }
  });
  if (!observation.payload.ok) throw new Error(`Initial observation failed: ${JSON.stringify(observation.payload)}`);
  let image = observation.payload.image.base64;
  let submitted = false;

  for (let turn = 1; turn <= options.maxTurns && !submitted; turn += 1) {
    let call;
    let rawReply = null;
    let repairs = [];
    let trace = null;

    if (options.driver === "mock") {
      const scripted = mockScript[Math.min(turn - 1, mockScript.length - 1)];
      // `thought` is trace data, not a tool argument; the server rejects any
      // field outside the canonical surface, mock runs included.
      const { thought, ...toolCall } = JSON.parse(JSON.stringify(scripted));
      call = toolCall;
      if (Array.isArray(call.points)) call.points = call.points.map(([x, y]) => ({ x, y }));
      trace = { promptedThought: thought ?? null, reasoningContent: null, thinkBlocks: [], channels: [] };
    } else {
      const historyText = history.length === 0
        ? "You have not drawn anything yet."
        : `Your actions so far:\n${history.join("\n")}`;
      const reply = await callModel(options, image, historyText);
      rawReply = reply.content;
      const reasoning = extractReasoning(reply.content, reply.message);
      // Think spans are reasoning, not the answer; the tool call is read from
      // what remains so a stray brace inside a <think> block cannot be parsed
      // as the action.
      const extracted = extractToolCall(stripThinkTags(reply.content));
      trace = {
        ...reasoning,
        promptedThought: extracted.promptedThought ?? null,
        finishReason: reply.finishReason,
        usage: reply.usage,
        latencyMs: reply.latencyMs
      };
      if (!extracted.ok) {
        parseFailures += 1;
        parseRepairs += extracted.repairs?.length ?? 0;
        history.push(`turn ${turn}: unreadable reply (${extracted.error})`);
        turns.push({ turn, rawReply, reasoning: trace, parseError: extracted.error, accepted: false });
        console.log(`  turn ${turn}: unparseable reply - ${extracted.error}`);
        continue;
      }
      call = extracted.call;
      repairs = extracted.repairs;
      parseRepairs += repairs.length;
    }

    const result = await postJson(`${options.base}/api/audra/tool`, { trialId, call });
    const accepted = result.payload.ok === true;
    if (accepted && result.payload.image) image = result.payload.image.base64;

    const label = call.tool === "draw_stroke" || call.tool === "erase_stroke"
      ? `${call.tool} (${call.points.length} points)`
      : call.tool;
    history.push(`turn ${turn}: ${label} -> ${accepted ? "accepted" : `rejected: ${result.payload.error}`}`);
    turns.push({
      turn,
      rawReply,
      reasoning: trace,
      call,
      repairs,
      accepted,
      error: accepted ? null : result.payload.error,
      code: accepted ? null : result.payload.code,
      revision: accepted ? result.payload.revision : null
    });
    const thought = trace?.promptedThought ?? trace?.thinkBlocks?.[0] ?? null;
    console.log(`  turn ${turn}: ${label} -> ${accepted ? "ok" : `REJECTED (${result.payload.code})`}`);
    if (thought) console.log(`           thought: ${thought.replace(/\s+/g, " ").slice(0, 110)}`);

    if (accepted && call.tool === "submit_task") submitted = true;
  }

  const run = await fetch(
    `${options.base}/api/audra/_host/run?trialId=${trialId}&token=${renderToken}`
  ).then(response => response.json());

  let exported = null;
  if (options.export !== "false") {
    const result = await postJson(`${options.base}/api/audra/export`, {
      trialId,
      token: renderToken,
      endedAt: new Date().toISOString()
    });
    if (result.payload.ok) {
      exported = result.payload;
      console.log(`bundle   -> ${result.payload.directory}`);
    } else {
      console.log(`export failed: ${result.payload.error}`);
    }
  }

  const summary = {
    trialId,
    stimulusId: options.stimulus,
    submitted,
    wallClockMs: Date.now() - startedAt,
    turnsUsed: turns.length,
    // Driver leniency is assistance a human participant does not receive, so it
    // is reported rather than hidden.
    driverAssistance: { parseRepairs, parseFailures },
    reasoningTrace: {
      turnsWithThought: turns.filter(entry => entry.reasoning?.promptedThought).length,
      turnsWithReasoningContent: turns.filter(entry => entry.reasoning?.reasoningContent).length,
      turnsWithThinkTags: turns.filter(entry => (entry.reasoning?.thinkBlocks?.length ?? 0) > 0).length
    },
    options: { ...options, apiKey: options.apiKey ? "[set]" : null },
    exportBundle: exported,
    serverRun: run.ok ? { agentRun: run.agentRun, runStats: run.runStats, rejections: run.rejections } : null,
    turns
  };

  if (options.out) {
    mkdirSync(options.out, { recursive: true });
    const file = join(options.out, `${trialId}.run.json`);
    writeFileSync(file, JSON.stringify(summary, null, 2));

    // The reasoning trace is written separately, one record per turn, so it can
    // be analysed without the run log and never travels with a scoring image.
    const traceFile = join(options.out, `${trialId}.reasoning.jsonl`);
    const records = turns.map(entry => ({
      trialId,
      actorType: "agent",
      actorId: options.actorId,
      model: summary.serverRun?.agentRun?.model ?? options.model,
      turn: entry.turn,
      tool: entry.call?.tool ?? null,
      accepted: entry.accepted,
      revision: entry.revision ?? null,
      promptedThought: entry.reasoning?.promptedThought ?? null,
      reasoningContent: entry.reasoning?.reasoningContent ?? null,
      thinkBlocks: entry.reasoning?.thinkBlocks ?? [],
      channels: entry.reasoning?.channels ?? [],
      finishReason: entry.reasoning?.finishReason ?? null,
      usage: entry.reasoning?.usage ?? null,
      latencyMs: entry.reasoning?.latencyMs ?? null,
      rawReply: entry.rawReply
    }));
    writeFileSync(traceFile, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    console.log(`run log  -> ${file}`);
    console.log(`reasoning -> ${traceFile}`);
  }

  console.log(
    `\n${submitted ? "submitted" : "NOT submitted"} after ${turns.length} turns · ` +
      `accepted ${run.runStats?.acceptedCount ?? "?"} · rejected ${run.runStats?.rejectedCount ?? "?"} · ` +
      `parse repairs ${parseRepairs} · parse failures ${parseFailures}\n` +
      `reasoning captured on ${summary.reasoningTrace.turnsWithThought} turns (thought), ` +
      `${summary.reasoningTrace.turnsWithReasoningContent} (reasoning_content), ` +
      `${summary.reasoningTrace.turnsWithThinkTags} (think tags)`
  );
  if (!submitted) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
