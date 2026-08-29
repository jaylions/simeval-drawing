import { useCallback, useRef, useState } from "react";
import {
  silenceThreshold,
  thinkAloudChunkMs,
  type ThinkAloudChunk,
  type ThinkAloudSegment
} from "./thinkAloud";

type SttResponse = {
  success: boolean;
  error?: string;
  transcript?: string;
  languageCode?: string;
  segments?: ThinkAloudSegment[];
};

export type ThinkAloudRecorder = {
  chunks: readonly ThinkAloudChunk[];
  isRecording: boolean;
  /** Live input level, 0-1, for the meter. */
  inputLevel: number;
  /** True once enough time has passed with no signal at all. */
  noInputSignal: boolean;
  pendingTranscriptions: number;
  error: string | null;
  supported: boolean;
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
  audioBlob: () => Blob | null;
};

function preferredMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const candidate of ["audio/webm;codecs=opus", "audio/webm"]) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

async function blobToBase64(blob: Blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Captures human think-aloud during a trial.
 *
 * Two recorders share one microphone stream: a sequence of fixed-length chunk
 * recorders feeding speech-to-text, and one continuous recorder producing the
 * archival audio. Chunks are transcribed independently so a single failed
 * request costs one chunk rather than the whole trace, and a failure is kept
 * with its reason instead of being dropped.
 *
 * The recorder never touches canvas state.
 */
export function useThinkAloud(input: {
  sessionId: string;
  trialId: string;
  actorId: string;
  elapsedMs: () => number;
  currentRevision: () => number;
}): ThinkAloudRecorder {
  const [chunks, setChunks] = useState<ThinkAloudChunk[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [pendingTranscriptions, setPendingTranscriptions] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [inputLevel, setInputLevel] = useState(0);
  const [noInputSignal, setNoInputSignal] = useState(false);

  // The caller rebuilds `input` every render. Reading it through a ref keeps the
  // long-lived recorder callbacks from capturing a stale elapsedMs or revision.
  const inputRef = useRef(input);
  inputRef.current = input;

  const streamRef = useRef<MediaStream | null>(null);
  const chunkRecorderRef = useRef<MediaRecorder | null>(null);
  const fullRecorderRef = useRef<MediaRecorder | null>(null);
  const fullPartsRef = useRef<Blob[]>([]);
  const chunkPartsRef = useRef<Blob[]>([]);
  const chunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const sequenceRef = useRef(0);
  const previousEndRef = useRef(0);
  const pendingRef = useRef(0);
  const flushQueueRef = useRef<Promise<void>>(Promise.resolve());
  const stopResolveRef = useRef<(() => void) | null>(null);

  // Continuous level metering. MediaRecorder happily produces valid Opus from a
  // dead microphone, so the only way to tell a muted device from a quiet room is
  // to watch the samples.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunkPeakRef = useRef(0);
  const chunkSumSquaresRef = useRef(0);
  const chunkSampleCountRef = useRef(0);

  const startMeter = useCallback((stream: MediaStream) => {
    const AudioContextClass =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    void context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = context;
    analyserRef.current = analyser;

    const samples = new Float32Array(analyser.fftSize);
    let silentSamples = 0;
    meterTimerRef.current = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let peak = 0;
      let sumSquares = 0;
      for (const sample of samples) {
        const magnitude = Math.abs(sample);
        if (magnitude > peak) peak = magnitude;
        sumSquares += sample * sample;
      }
      chunkPeakRef.current = Math.max(chunkPeakRef.current, peak);
      chunkSumSquaresRef.current += sumSquares / samples.length;
      chunkSampleCountRef.current += 1;
      setInputLevel(peak);
      // Roughly three seconds of dead input before warning, so a genuine pause
      // does not trip it.
      silentSamples = peak < silenceThreshold ? silentSamples + 1 : 0;
      setNoInputSignal(silentSamples > 30);
    }, 100);
  }, []);

  const stopMeter = useCallback(() => {
    if (meterTimerRef.current) clearInterval(meterTimerRef.current);
    meterTimerRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    setInputLevel(0);
  }, []);

  const takeChunkLevels = useCallback(() => {
    const peakLevel = chunkPeakRef.current;
    const rmsLevel = chunkSampleCountRef.current > 0
      ? Math.sqrt(chunkSumSquaresRef.current / chunkSampleCountRef.current)
      : 0;
    chunkPeakRef.current = 0;
    chunkSumSquaresRef.current = 0;
    chunkSampleCountRef.current = 0;
    return { peakLevel, rmsLevel, silent: peakLevel < silenceThreshold };
  }, []);

  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const updateChunk = useCallback((sequence: number, patch: Partial<ThinkAloudChunk>) => {
    setChunks(previous =>
      previous.map(chunk => (chunk.sequence === sequence ? { ...chunk, ...patch } : chunk))
    );
  }, []);

  const transcribe = useCallback(
    async (blob: Blob, chunk: ThinkAloudChunk) => {
      pendingRef.current += 1;
      setPendingTranscriptions(pendingRef.current);
      try {
        const response = await fetch("/api/google-stt-transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audioBase64: await blobToBase64(blob),
            mimeType: blob.type,
            chunkIndex: chunk.chunkIndex,
            chunkStartedAtMs: chunk.chunkStartedAtMs,
            chunkEndedAtMs: chunk.chunkEndedAtMs
          })
        });
        const result = (await response.json()) as SttResponse;
        const content = (result.transcript ?? "").trim();
        const succeeded = response.ok && result.success;
        updateChunk(chunk.sequence, {
          content,
          transcriptionStatus: succeeded ? (content.length > 0 ? "completed" : "empty") : "failed",
          audio: {
            ...chunk.audio,
            languageCode: result.languageCode ?? "",
            success: succeeded,
            error: result.error,
            segments: result.segments ?? []
          }
        });
      } catch (caught) {
        // The audio is already captured; only the transcript is lost, and the
        // reason is kept so the gap is explainable during analysis.
        updateChunk(chunk.sequence, {
          content: "",
          transcriptionStatus: "failed",
          audio: {
            ...chunk.audio,
            languageCode: "",
            success: false,
            error: caught instanceof Error ? caught.message : String(caught),
            segments: []
          }
        });
      } finally {
        pendingRef.current -= 1;
        setPendingTranscriptions(pendingRef.current);
      }
    },
    [updateChunk]
  );

  const startChunkRecorder = useCallback(
    (stream: MediaStream, mimeType: string) => {
      if (!activeRef.current || !stream.active) return;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const startedAtMs = previousEndRef.current;
      const revisionAtStart = inputRef.current.currentRevision();
      chunkPartsRef.current = [];
      chunkRecorderRef.current = recorder;

      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunkPartsRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (chunkTimerRef.current) clearTimeout(chunkTimerRef.current);
        chunkTimerRef.current = null;
        const parts = chunkPartsRef.current;
        chunkPartsRef.current = [];
        // Read and reset the accumulator now, before the next chunk recorder
        // starts adding to it.
        const levels = takeChunkLevels();

        const flush = async () => {
          const endedAtMs = inputRef.current.elapsedMs();
          if (parts.length > 0) {
            const blob = new Blob(parts, { type: recorder.mimeType || mimeType || "audio/webm" });
            const sequence = sequenceRef.current;
            sequenceRef.current += 1;
            const chunk: ThinkAloudChunk = {
              sessionId: inputRef.current.sessionId,
              trialId: inputRef.current.trialId,
              actorType: "human",
              actorId: inputRef.current.actorId,
              sequence,
              chunkIndex: sequence + 1,
              chunkStartedAtMs: startedAtMs,
              chunkEndedAtMs: endedAtMs,
              durationMs: Math.max(0, endedAtMs - startedAtMs),
              content: "",
              transcriptionStatus: "pending",
              revisionAtStart,
              revisionAtEnd: inputRef.current.currentRevision(),
              audio: {
                mimeType: blob.type,
                byteSize: blob.size,
                languageCode: "",
                success: false,
                segments: [],
                ...levels
              }
            };
            setChunks(previous => [...previous, chunk]);
            void transcribe(blob, chunk);
          }
          previousEndRef.current = endedAtMs;
          chunkRecorderRef.current = null;

          if (activeRef.current && stream.active) {
            startChunkRecorder(stream, mimeType);
            return;
          }
          const full = fullRecorderRef.current;
          if (full && full.state !== "inactive") full.stop();
          else stopResolveRef.current?.();
        };
        flushQueueRef.current = flushQueueRef.current.then(flush, flush);
      };

      recorder.start();
      chunkTimerRef.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, thinkAloudChunkMs);
    },
    [takeChunkLevels, transcribe]
  );

  const start = useCallback(async () => {
    if (!supported) {
      setError("This browser cannot record audio, so think-aloud is unavailable.");
      return false;
    }
    if (activeRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredMimeType();
      streamRef.current = stream;
      activeRef.current = true;
      previousEndRef.current = inputRef.current.elapsedMs();
      sequenceRef.current = 0;
      fullPartsRef.current = [];

      const full = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      full.ondataavailable = event => {
        if (event.data.size > 0) fullPartsRef.current.push(event.data);
      };
      full.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        stopResolveRef.current?.();
      };
      fullRecorderRef.current = full;
      full.start();

      startMeter(stream);
      startChunkRecorder(stream, mimeType);
      setIsRecording(true);
      setError(null);
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error
          ? `Microphone unavailable: ${caught.message}`
          : "Microphone unavailable."
      );
      return false;
    }
  }, [startChunkRecorder, startMeter, supported]);

  /** Resolves once the audio is finalized and every transcription has settled. */
  const stop = useCallback(async () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setIsRecording(false);

    await new Promise<void>(resolve => {
      stopResolveRef.current = resolve;
      const chunkRecorder = chunkRecorderRef.current;
      if (chunkRecorder && chunkRecorder.state === "recording") chunkRecorder.stop();
      else {
        const full = fullRecorderRef.current;
        if (full && full.state !== "inactive") full.stop();
        else resolve();
      }
    });
    stopResolveRef.current = null;

    stopMeter();
    await flushQueueRef.current;
    // Transcriptions are fired per chunk; wait for the last of them to settle so
    // no chunk is exported still marked pending.
    while (pendingRef.current > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    streamRef.current = null;
  }, [stopMeter]);

  const audioBlob = useCallback(() => {
    if (fullPartsRef.current.length === 0) return null;
    return new Blob(fullPartsRef.current, {
      type: fullPartsRef.current[0]?.type || "audio/webm"
    });
  }, []);

  return {
    chunks,
    isRecording,
    inputLevel,
    noInputSignal,
    pendingTranscriptions,
    error,
    supported,
    start,
    stop,
    audioBlob
  };
}
