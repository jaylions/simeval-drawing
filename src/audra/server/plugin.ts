import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { developmentStimulus, stimulusById } from "../stimulus";
import { renderTrialToPng } from "./renderer";
import {
  agentContract,
  createTrial,
  executeToolCall,
  getTrial,
  noteRetry,
  recordFrame,
  visibleStatus,
  type TrialRecord
} from "./trialRegistry";

const maxBodyBytes = 8 * 1024 * 1024;

/**
 * HTTP surface for the incomplete-shapes task.
 *
 * Two disjoint groups:
 *   /api/audra/*        agent-facing. Tool calls and rendered observations only.
 *   /api/audra/_host/*  host-page only, gated by a render token that is issued
 *                       once at trial creation and never returned in a tool
 *                       response. These carry raw state and must not be exposed
 *                       to the agent's network namespace.
 */
export function audraTaskPlugin(): Plugin {
  return {
    name: "simeval-audra-task",
    configureServer(server) {
      // Stimulus assets live under Vite's public directory; the renderer reads
      // them from disk rather than over HTTP.
      const publicDir = server.config.publicDir;
      server.middlewares.use("/api/audra", async (request, response) => {
        response.setHeader("Content-Type", "application/json");
        const url = new URL(request.url ?? "/", "http://localhost");
        const route = url.pathname.replace(/\/+$/, "") || "/";

        try {
          if (route === "/trial" && request.method === "POST") return await handleCreate(request, response);
          if (route === "/tool" && request.method === "POST") return await handleTool(request, response, publicDir);
          if (route === "/contract" && request.method === "GET") return handleContract(url, response);
          if (route === "/_host/state" && request.method === "GET") return handleHostState(url, response);
          if (route === "/_host/frame" && request.method === "POST") return await handleFrame(request, response);
          if (route === "/_host/run" && request.method === "GET") return handleHostRun(url, response);
          send(response, 404, { ok: false, error: `Unknown endpoint: ${route}` });
        } catch (error) {
          send(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    }
  };
}

async function handleCreate(request: IncomingMessage, response: ServerResponse) {
  const body = await readJson(request);
  const stimulusId = typeof body.stimulusId === "string" ? body.stimulusId : developmentStimulus.stimulusId;
  const stimulus = stimulusById(stimulusId);
  if (!stimulus) return send(response, 400, { ok: false, error: `Unknown stimulus: ${stimulusId}` });
  const actorId = typeof body.actorId === "string" && body.actorId.trim().length > 0 ? body.actorId.trim() : null;
  if (!actorId) return send(response, 400, { ok: false, error: "actorId is required." });

  const record = createTrial({
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    actorId,
    stimulus,
    agentRun: typeof body.agentRun === "object" && body.agentRun ? body.agentRun : undefined,
    observationSize: typeof body.observationSize === "number" ? body.observationSize : undefined
  });

  send(response, 200, {
    ok: true,
    trialId: record.trialId,
    sessionId: record.sessionId,
    // Host-only. The driver that runs the model must not forward these two.
    renderToken: record.renderToken,
    hostUrl: `/?mode=audra-incomplete-shapes&trialId=${record.trialId}&token=${record.renderToken}`,
    observationSize: record.observationSize,
    contract: agentContract(record)
  });
}

function handleContract(url: URL, response: ServerResponse) {
  const record = requireTrial(url.searchParams.get("trialId"), response);
  if (!record) return;
  send(response, 200, { ok: true, contract: agentContract(record), status: visibleStatus(record) });
}

async function handleTool(request: IncomingMessage, response: ServerResponse, publicDir: string) {
  const body = await readJson(request);
  const record = requireTrial(typeof body.trialId === "string" ? body.trialId : null, response);
  if (!record) return;
  if (body.isRetry === true) noteRetry(record);

  const nowMs = Date.now() - record.createdAtEpochMs;
  const call = body.call ?? body;
  const result = executeToolCall(record, stripEnvelope(call), nowMs);

  if (!result.ok) {
    return send(response, 400, {
      ok: false,
      code: result.code,
      error: result.error,
      status: result.status
    });
  }

  // Every accepted call returns the canvas as it now stands, so the agent never
  // acts on a stale observation and never has to guess what its stroke did.
  const png = renderTrialToPng(record.state, record.stimulus, publicDir, record.observationSize);
  send(response, 200, {
    ok: true,
    revision: result.revision,
    status: result.status,
    image: {
      mimeType: "image/png",
      width: record.observationSize,
      height: record.observationSize,
      base64: png.toString("base64")
    }
  });
}

function handleHostState(url: URL, response: ServerResponse) {
  const record = requireHostTrial(url, response);
  if (!record) return;
  send(response, 200, {
    ok: true,
    stimulusId: record.stimulus.stimulusId,
    sessionId: record.sessionId,
    trialId: record.trialId,
    actorId: record.state.actorId,
    revision: record.state.revision,
    events: record.state.events,
    undoneEventIndices: record.state.undoneEventIndices,
    description: record.state.description,
    submittedAtMs: record.state.submittedAtMs
  });
}

async function handleFrame(request: IncomingMessage, response: ServerResponse) {
  const body = await readJson(request);
  const record = getTrial(typeof body.trialId === "string" ? body.trialId : "");
  if (!record) return send(response, 404, { ok: false, error: "Unknown trial." });
  if (body.token !== record.renderToken) return send(response, 403, { ok: false, error: "Invalid render token." });
  if (typeof body.revision !== "number" || typeof body.base64 !== "string") {
    return send(response, 400, { ok: false, error: "revision (number) and base64 (string) are required." });
  }
  recordFrame(record, body.revision, {
    mimeType: typeof body.mimeType === "string" ? body.mimeType : "image/png",
    base64: body.base64,
    receivedAtMs: Date.now() - record.createdAtEpochMs
  });
  send(response, 200, { ok: true });
}

function handleHostRun(url: URL, response: ServerResponse) {
  const record = requireHostTrial(url, response);
  if (!record) return;
  send(response, 200, {
    ok: true,
    // Kept deliberately separate from the shared canvas event log.
    agentRun: record.agentRun,
    runStats: {
      ...record.runStats,
      wallClockMs: (record.runStats.lastToolCallAtMs ?? 0) - (record.runStats.firstToolCallAtMs ?? 0)
    },
    rejections: record.rejections
  });
}

/** Accepts both `{call: {...}}` and a bare `{tool, ...}` body, but nothing else. */
function stripEnvelope(call: unknown) {
  if (call && typeof call === "object" && !Array.isArray(call)) {
    const { trialId, isRetry, ...rest } = call as Record<string, unknown>;
    void trialId;
    void isRetry;
    return rest;
  }
  return call;
}

function requireTrial(trialId: string | null, response: ServerResponse): TrialRecord | null {
  const record = trialId ? getTrial(trialId) : null;
  if (!record) {
    send(response, 404, { ok: false, error: "Unknown trial." });
    return null;
  }
  return record;
}

function requireHostTrial(url: URL, response: ServerResponse): TrialRecord | null {
  const record = requireTrial(url.searchParams.get("trialId"), response);
  if (!record) return null;
  if (url.searchParams.get("token") !== record.renderToken) {
    send(response, 403, { ok: false, error: "Invalid render token." });
    return null;
  }
  return record;
}

function readJson(request: IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let body = "";
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (body.trim().length === 0) return resolve({});
      try {
        const parsed = JSON.parse(body);
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${(error as Error).message}`));
      }
    });
    request.on("error", reject);
  });
}

function send(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.end(JSON.stringify(payload));
}
