/**
 * Human think-aloud trace.
 *
 * The human counterpart to the agent reasoning trace. Both are process data
 * *about the actor*: they sit beside the canonical event log rather than inside
 * it, and never reach an exported image. Keeping the two symmetric is what
 * makes a process comparison between actors defensible.
 */

export type TranscriptionStatus = "pending" | "completed" | "empty" | "failed";

export type ThinkAloudWord = {
  word: string;
  startSec: number;
  endSec: number;
  confidence: number | null;
};

export type ThinkAloudSegment = {
  index: number;
  transcript: string;
  confidence: number | null;
  words: ThinkAloudWord[];
};

export type ThinkAloudChunk = {
  sessionId: string;
  trialId: string;
  actorType: "human";
  actorId: string;
  sequence: number;
  chunkIndex: number;
  chunkStartedAtMs: number;
  chunkEndedAtMs: number;
  durationMs: number;
  content: string;
  transcriptionStatus: TranscriptionStatus;
  /**
   * Canvas revision when the chunk opened and closed. This is what lets a
   * spoken remark be aligned with the marks it was about, the same way an
   * agent's reasoning record names the revision its tool call produced.
   */
  revisionAtStart: number;
  revisionAtEnd: number;
  audio: {
    mimeType: string;
    byteSize: number;
    languageCode: string;
    success: boolean;
    error?: string;
    segments: ThinkAloudSegment[];
  };
};

export const thinkAloudChunkMs = 10000;

export function toThinkAloudJsonl(chunks: readonly ThinkAloudChunk[]) {
  return chunks.map(chunk => JSON.stringify(chunk)).join("\n");
}

export function summarizeThinkAloud(chunks: readonly ThinkAloudChunk[]) {
  const byStatus = (status: TranscriptionStatus) =>
    chunks.filter(chunk => chunk.transcriptionStatus === status).length;
  return {
    chunkCount: chunks.length,
    totalAudioMs: chunks.reduce((total, chunk) => total + chunk.durationMs, 0),
    totalBytes: chunks.reduce((total, chunk) => total + chunk.audio.byteSize, 0),
    transcribedChunks: byStatus("completed"),
    emptyChunks: byStatus("empty"),
    failedChunks: byStatus("failed"),
    pendingChunks: byStatus("pending"),
    wordCount: chunks.reduce(
      (total, chunk) => total + chunk.audio.segments.reduce((sum, segment) => sum + segment.words.length, 0),
      0
    )
  };
}

/**
 * Structural checks run before export. A failure is recorded rather than thrown:
 * a broken audio trace must never cost a participant their drawing.
 */
export function validateThinkAloudChunks(chunks: readonly ThinkAloudChunk[]): string[] {
  const errors: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.sequence !== index) {
      errors.push(`Think-aloud chunk ${chunk.sequence} is out of order at position ${index}.`);
    }
    if (chunk.chunkEndedAtMs < chunk.chunkStartedAtMs) {
      errors.push(`Think-aloud chunk ${chunk.sequence} ends before it starts.`);
    }
    if (chunk.transcriptionStatus === "pending") {
      errors.push(`Think-aloud chunk ${chunk.sequence} was exported before transcription finished.`);
    }
    if (chunk.audio.byteSize <= 0) {
      errors.push(`Think-aloud chunk ${chunk.sequence} carries no audio.`);
    }
    const previous = chunks[index - 1];
    if (previous && chunk.chunkStartedAtMs < previous.chunkEndedAtMs) {
      errors.push(`Think-aloud chunk ${chunk.sequence} overlaps the previous chunk.`);
    }
  }
  return errors;
}
