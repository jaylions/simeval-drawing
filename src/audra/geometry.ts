import type { StrokePoint } from "./events";

export type BoundingBox = { minX: number; minY: number; maxX: number; maxY: number };

export function boundingBox(points: readonly StrokePoint[]): BoundingBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

export function boxesOverlap(left: BoundingBox, right: BoundingBox, margin: number) {
  return !(
    left.maxX + margin < right.minX ||
    right.maxX + margin < left.minX ||
    left.maxY + margin < right.minY ||
    right.maxY + margin < left.minY
  );
}

export function distanceToSegment(
  point: StrokePoint,
  start: StrokePoint,
  end: StrokePoint
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

export function distanceToPolyline(point: StrokePoint, polyline: readonly StrokePoint[]) {
  if (polyline.length === 0) return Infinity;
  if (polyline.length === 1) return Math.hypot(point.x - polyline[0].x, point.y - polyline[0].y);
  let shortest = Infinity;
  for (let index = 0; index < polyline.length - 1; index += 1) {
    const distance = distanceToSegment(point, polyline[index], polyline[index + 1]);
    if (distance < shortest) shortest = distance;
  }
  return shortest;
}

/**
 * Inserts linearly interpolated points so no two consecutive points are further
 * apart than `spacing`. Interpolated points carry interpolated `tMs`/`pressure`
 * so a densified stroke stays a faithful record of the original gesture.
 *
 * Deterministic: the same input always yields the same output, which is what
 * lets erase-then-replay reproduce a pixel-identical canvas.
 */
export function densify(points: readonly StrokePoint[], spacing: number): StrokePoint[] {
  if (points.length < 2 || spacing <= 0) return [...points];
  const result: StrokePoint[] = [points[0]];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.ceil(distance / spacing);
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      result.push(interpolate(start, end, t));
    }
  }
  return result;
}

function interpolate(start: StrokePoint, end: StrokePoint, t: number): StrokePoint {
  const point: StrokePoint = {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t
  };
  if (start.tMs != null && end.tMs != null) point.tMs = start.tMs + (end.tMs - start.tMs) * t;
  if (start.pressure != null && end.pressure != null) {
    point.pressure = start.pressure + (end.pressure - start.pressure) * t;
  }
  return point;
}

export function polylineLength(points: readonly StrokePoint[]) {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    total += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
  }
  return total;
}
