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

// Widths are chosen so a mark survives the 224 px AuDrA scoring render. At the
// old default of 3 a stroke was 0.66 px there and antialiased to mid-grey, with
// no solid pixel anywhere in the scoring image; at 6 it is 1.3 px and solid.
// The minimum is the thinnest width that still renders as ink rather than haze.
export const pencilWidth = { min: 4, max: 16, default: 6 } as const;
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
