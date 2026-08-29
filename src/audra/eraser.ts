import { eraserSampleSpacing } from "./artboard";
import type { StrokePoint } from "./events";
import { boundingBox, boxesOverlap, densify, distanceToPolyline } from "./geometry";

export type ForegroundStroke = {
  strokeId: string;
  width: number;
  points: StrokePoint[];
};

/**
 * Geometry-based eraser.
 *
 * The eraser is a swept disc along `eraserPoints`. Any part of a foreground
 * stroke falling inside that swept area is removed; the surviving parts stay as
 * separate fragments. This is deliberately *not* a delete-by-id operation:
 * both actors erase the same way, and neither can remove a stroke it cannot
 * see and reach with a pointer path.
 *
 * Strokes are densified before hit-testing so that a long straight segment
 * crossing the eraser path is cut where it actually crosses, rather than
 * surviving because both endpoints happened to sit outside the radius.
 */
export function eraseFromStrokes(
  strokes: readonly ForegroundStroke[],
  eraserPoints: readonly StrokePoint[],
  eraserStrokeWidth: number
): ForegroundStroke[] {
  if (eraserPoints.length === 0) return strokes.map(cloneStroke);

  const eraserPath = densify(eraserPoints, eraserSampleSpacing);
  const eraserRadius = eraserStrokeWidth / 2;
  const eraserBox = boundingBox(eraserPath);
  const result: ForegroundStroke[] = [];

  for (const stroke of strokes) {
    const radius = eraserRadius + stroke.width / 2;
    if (!boxesOverlap(boundingBox(stroke.points), eraserBox, radius)) {
      result.push(cloneStroke(stroke));
      continue;
    }

    const samples = densify(stroke.points, eraserSampleSpacing);
    const survives = samples.map(point => distanceToPolyline(point, eraserPath) > radius);
    if (survives.every(Boolean)) {
      result.push(cloneStroke(stroke));
      continue;
    }

    let fragmentIndex = 0;
    let run: StrokePoint[] = [];
    const flush = () => {
      // A single surviving sample has no length to draw, so it is dropped.
      if (run.length >= 2) {
        result.push({
          strokeId: `${stroke.strokeId}~${fragmentIndex}`,
          width: stroke.width,
          points: run
        });
        fragmentIndex += 1;
      }
      run = [];
    };

    for (let index = 0; index < samples.length; index += 1) {
      if (survives[index]) run.push({ ...samples[index] });
      else flush();
    }
    flush();
  }

  return result;
}

function cloneStroke(stroke: ForegroundStroke): ForegroundStroke {
  return { strokeId: stroke.strokeId, width: stroke.width, points: stroke.points.map(point => ({ ...point })) };
}
