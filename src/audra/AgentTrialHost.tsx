import { useCallback, useEffect, useRef, useState } from "react";
import { canonicalArtboard } from "./artboard";
import type { AudraEvent } from "./events";
import { deriveScene, replay, type AudraTrialState } from "./reducer";
import { canonicalSize, loadStimulusImage, renderTrial } from "./render";
import { developmentStimulus, stimulusById, taskInstruction } from "./stimulus";

const pollIntervalMs = 250;

type HostState = {
  sessionId: string;
  trialId: string;
  actorId: string;
  stimulusId: string;
  revision: number;
  events: AudraEvent[];
  submittedAtMs: number | null;
  description: string;
};

/**
 * Renderer for an agent-driven trial.
 *
 * The server holds authoritative state but has no rasterizer. This page polls
 * that state, replays it through the same reducer, renders it with the same
 * renderer a human participant sees, and posts the frame back. The agent's
 * observations are therefore produced by identical code to the human view -
 * not by a second, near-enough server-side renderer.
 */
export function AgentTrialHost({ trialId, token }: { trialId: string; token: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const backgroundRef = useRef<HTMLImageElement | null>(null);
  const postedRevisionRef = useRef(-1);
  const [hostState, setHostState] = useState<HostState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [framesPosted, setFramesPosted] = useState(0);

  const renderAndPost = useCallback(
    async (state: AudraTrialState, revision: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx || !backgroundRef.current) return;
      renderTrial(ctx, {
        scene: deriveScene(state),
        background: backgroundRef.current,
        size: canonicalSize
      });
      const dataUrl = canvas.toDataURL("image/png");
      const base64 = dataUrl.split(",")[1] ?? "";
      await fetch("/api/audra/_host/frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trialId, token, revision, mimeType: "image/png", base64 })
      });
      postedRevisionRef.current = revision;
      setFramesPosted(count => count + 1);
    },
    [token, trialId]
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const response = await fetch(
          `/api/audra/_host/state?trialId=${encodeURIComponent(trialId)}&token=${encodeURIComponent(token)}`
        );
        const payload = await response.json();
        if (cancelled) return;
        if (!payload.ok) {
          setError(payload.error ?? "The host state request failed.");
          return;
        }
        const next: HostState = payload;
        setHostState(next);

        if (!backgroundRef.current) {
          const stimulus = stimulusById(next.stimulusId) ?? developmentStimulus;
          backgroundRef.current = await loadStimulusImage(stimulus);
        }
        if (postedRevisionRef.current !== next.revision) {
          const state = replay(
            {
              sessionId: next.sessionId,
              trialId: next.trialId,
              stimulusId: next.stimulusId,
              actorType: "agent",
              actorId: next.actorId
            },
            next.events
          );
          await renderAndPost(state, next.revision);
        }
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) timer = setTimeout(tick, pollIntervalMs);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [renderAndPost, token, trialId]);

  return (
    <div className="audra-shell">
      <section className="audra-stage">
        <p className="audra-instruction-banner">{taskInstruction}</p>
        <div className="audra-canvas-frame">
          <canvas
            ref={canvasRef}
            className="audra-canvas"
            width={canonicalArtboard.width}
            height={canonicalArtboard.height}
          />
        </div>
        <p className="audra-meta">
          Agent trial host · trial {trialId} · revision {hostState?.revision ?? "-"} · frames posted{" "}
          {framesPosted}
          {hostState?.submittedAtMs != null ? " · submitted" : ""}
        </p>
        {hostState?.description && <p className="audra-meta">Description: {hostState.description}</p>}
        {error && <p className="audra-error">{error}</p>}
      </section>
    </div>
  );
}

export default AgentTrialHost;
