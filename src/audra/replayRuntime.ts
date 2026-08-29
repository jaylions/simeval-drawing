import type { AudraEvent } from "./events";
import { deriveScene, replay, type AudraTrialState } from "./reducer";
import { sceneToSvg, type BackgroundEmbed } from "./svg";

/**
 * Replay runtime embedded in the exported `replay.html`.
 *
 * It imports the canonical reducer and SVG serializer rather than
 * reimplementing them, so an exported replay cannot drift from the reducer that
 * produced the trial. The export step bundles this file and inlines the result.
 */

export type ReplayData = {
  trialId: string;
  sessionId: string;
  stimulusId: string;
  actorType: "human" | "agent";
  actorId: string;
  background: BackgroundEmbed | null;
  events: AudraEvent[];
};

declare global {
  interface Window {
    __AUDRA_REPLAY__?: ReplayData;
  }
}

function stateAt(data: ReplayData, count: number): AudraTrialState {
  return replay(
    {
      sessionId: data.sessionId,
      trialId: data.trialId,
      stimulusId: data.stimulusId,
      actorType: data.actorType,
      actorId: data.actorId
    },
    data.events.slice(0, count)
  );
}

function describe(event: AudraEvent | undefined) {
  if (!event) return "start of trial";
  const points = event.payload.points?.length;
  const detail = points ? ` (${points} points)` : "";
  return `#${event.eventIndex} ${event.eventType}${detail} @ ${(event.timestampMs / 1000).toFixed(2)}s`;
}

export function mountReplay(root: HTMLElement, data: ReplayData) {
  root.innerHTML = `
    <div class="replay">
      <div class="replay-stage" id="replay-stage"></div>
      <div class="replay-controls">
        <button id="replay-play">Play</button>
        <input id="replay-scrub" type="range" min="0" max="${data.events.length}" value="${data.events.length}" step="1"/>
        <span id="replay-label"></span>
      </div>
      <p class="replay-meta">
        ${data.actorType} · ${data.actorId} · trial ${data.trialId} · stimulus ${data.stimulusId}
        · ${data.events.length} events
      </p>
    </div>`;

  const stage = root.querySelector("#replay-stage") as HTMLElement;
  const scrub = root.querySelector("#replay-scrub") as HTMLInputElement;
  const label = root.querySelector("#replay-label") as HTMLElement;
  const play = root.querySelector("#replay-play") as HTMLButtonElement;

  const render = (count: number) => {
    stage.innerHTML = sceneToSvg(deriveScene(stateAt(data, count)), data.background);
    label.textContent = `${count} / ${data.events.length} — ${describe(data.events[count - 1])}`;
  };

  let timer: number | null = null;
  const stop = () => {
    if (timer != null) window.clearInterval(timer);
    timer = null;
    play.textContent = "Play";
  };

  play.addEventListener("click", () => {
    if (timer != null) return stop();
    let count = Number(scrub.value) >= data.events.length ? 0 : Number(scrub.value);
    play.textContent = "Pause";
    timer = window.setInterval(() => {
      count += 1;
      scrub.value = String(count);
      render(count);
      if (count >= data.events.length) stop();
    }, 600);
  });

  scrub.addEventListener("input", () => {
    stop();
    render(Number(scrub.value));
  });

  render(data.events.length);
}

const container = typeof document !== "undefined" ? document.getElementById("replay-root") : null;
if (container && typeof window !== "undefined" && window.__AUDRA_REPLAY__) {
  mountReplay(container, window.__AUDRA_REPLAY__);
}
