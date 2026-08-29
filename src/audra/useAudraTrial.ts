import { useCallback, useMemo, useRef, useState } from "react";
import type { AudraActorType, AudraEvent, AudraEventDraft } from "./events";
import {
  applyEvent,
  canUndo,
  createTrialState,
  deriveScene,
  hasDrawingAttempt,
  type ApplyResult,
  type AudraTrialState,
  type RejectionCode
} from "./reducer";

export type RejectionRecord = {
  timestampMs: number;
  eventType: AudraEventDraft["eventType"];
  code: RejectionCode;
  error: string;
};

export type AudraTrialController = {
  state: AudraTrialState;
  scene: ReturnType<typeof deriveScene>;
  rejections: readonly RejectionRecord[];
  canUndo: boolean;
  hasDrawingAttempt: boolean;
  isSubmitted: boolean;
  elapsedMs: () => number;
  nextStrokeSequence: () => number;
  dispatch: (draft: AudraEventDraft) => ApplyResult;
  lastEvent: AudraEvent | null;
};

/**
 * Owns one trial. This is the only writer of trial state in the browser: the
 * human UI and any in-page agent driver both call `dispatch`, and `dispatch`
 * only ever delegates to the shared reducer.
 *
 * Rejections are kept rather than thrown away. "Submission requires a drawing
 * attempt" is a research-relevant behavioural signal, not just a UI guard, so
 * it is exported alongside the accepted events.
 */
export function useAudraTrial(input: {
  sessionId: string;
  trialId: string;
  stimulusId: string;
  actorType: AudraActorType;
  actorId: string;
  startedAtEpochMs: number;
}): AudraTrialController {
  const [state, setState] = useState<AudraTrialState>(() => createTrialState(input));
  const [rejections, setRejections] = useState<RejectionRecord[]>([]);
  const [lastEvent, setLastEvent] = useState<AudraEvent | null>(null);
  const strokeSequenceRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const elapsedMs = useCallback(
    () => Math.max(0, Math.round(performance.timeOrigin + performance.now() - input.startedAtEpochMs)),
    [input.startedAtEpochMs]
  );

  const nextStrokeSequence = useCallback(() => {
    strokeSequenceRef.current += 1;
    return strokeSequenceRef.current;
  }, []);

  const dispatch = useCallback((draft: AudraEventDraft) => {
    const result = applyEvent(stateRef.current, draft);
    if (result.ok) {
      stateRef.current = result.state;
      setState(result.state);
      setLastEvent(result.event);
    } else {
      setRejections(previous => [
        ...previous,
        {
          timestampMs: draft.timestampMs,
          eventType: draft.eventType,
          code: result.code,
          error: result.error
        }
      ]);
    }
    return result;
  }, []);

  const scene = useMemo(() => deriveScene(state), [state]);

  return {
    state,
    scene,
    rejections,
    canUndo: canUndo(state),
    hasDrawingAttempt: hasDrawingAttempt(state),
    isSubmitted: state.submittedAtMs != null,
    elapsedMs,
    nextStrokeSequence,
    dispatch,
    lastEvent
  };
}
