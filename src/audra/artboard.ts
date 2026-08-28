// Canonical artboard for the AuDrA-style incomplete-shapes task.
//
// Every trial - human or agent - uses this coordinate system. Points are
// expressed in artboard units with the origin at the top-left corner, x
// increasing to the right and y increasing downward. The on-screen canvas is
// only ever a scaled view of this space, so a stroke recorded at (512, 512)
// lands on the same place in the artboard regardless of display size.

export const canonicalArtboard = {
  width: 1024,
  height: 1024,
  backgroundColor: "#ffffff"
} as const;

// Near-black on white. Deliberately the only ink color available to either
// actor: color would leak semantic information that the task does not grant.
export const inkColor = "#111111";

export const pencilWidth = { min: 1, max: 12, default: 3 } as const;
export const eraserWidth = { min: 4, max: 64, default: 24 } as const;

// A stroke longer than this is almost certainly an agent dumping a whole
// drawing into one call, or a runaway pointer capture.
export const maxPointsPerStroke = 4000;
export const maxDescriptionLength = 500;

// Spacing used when a polyline is densified for eraser hit-testing. Small
// enough to be visually lossless at artboard scale, large enough to keep the
// hit test cheap.
export const eraserSampleSpacing = 2;

export type ArtboardSize = { width: number; height: number };
