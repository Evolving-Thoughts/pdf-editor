import { localizeOverlayClip, resolvedOverlayClips } from './overlayClipping'
// Geometry for freehand strokes. Pure and framework-free (ADR-004).
import { createId, isMarker, isStroke, type Overlay, type Stroke, type StrokePoint } from './model'

import { createShape, shapeWorldPoints } from './shapes'

function formatCoordinate(value: number): string {
  return Number(value.toFixed(3)).toString()
}

/** The same sampled polyline is displayed, erased and exported. */
export function strokeToSvgPath(points: StrokePoint[], pageHeight: number): string {
  if (points.length === 0) return ''
  const svgPoint = (point: StrokePoint) => `${formatCoordinate(point.x)} ${formatCoordinate(pageHeight - point.y)}`
  if (points.length === 1) {
    // Round caps turn this tiny segment into the same dot in SVG and PDF.
    const [point] = points
    return `M ${svgPoint(point)} L ${formatCoordinate(point.x + 0.01)} ${formatCoordinate(pageHeight - point.y)}`
  }
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${svgPoint(point)}`).join(' ')
}

type Interval = [number, number]
const EPSILON = 1e-9

function circleInterval(start: StrokePoint, end: StrokePoint, center: StrokePoint, radius: number): Interval | null {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const a = dx * dx + dy * dy
  const px = start.x - center.x
  const py = start.y - center.y
  const c = px * px + py * py - radius * radius
  if (a < EPSILON) return c <= 0 ? [0, 1] : null
  const b = 2 * (px * dx + py * dy)
  const discriminant = b * b - 4 * a * c
  if (discriminant <= 0) return null
  const root = Math.sqrt(discriminant)
  const from = Math.max(0, (-b - root) / (2 * a))
  const to = Math.min(1, (-b + root) / (2 * a))
  return to - from > EPSILON ? [from, to] : null
}

function linearInterval(origin: number, slope: number, min: number, max: number): Interval | null {
  if (Math.abs(slope) < EPSILON) return origin >= min && origin <= max ? [0, 1] : null
  const a = (min - origin) / slope
  const b = (max - origin) / slope
  const from = Math.max(0, Math.min(a, b))
  const to = Math.min(1, Math.max(a, b))
  return to - from > EPSILON ? [from, to] : null
}

/** Intersections with a swept eraser capsule = two circles plus its middle strip. */
function capsuleIntervals(start: StrokePoint, end: StrokePoint, a: StrokePoint, b: StrokePoint, radius: number): Interval[] {
  const result: Interval[] = []
  for (const center of [a, b]) {
    const interval = circleInterval(start, end, center, radius)
    if (interval) result.push(interval)
  }
  const ex = b.x - a.x
  const ey = b.y - a.y
  const length = Math.hypot(ex, ey)
  if (length < EPSILON) return result
  const ux = ex / length
  const uy = ey / length
  const px = start.x - a.x
  const py = start.y - a.y
  const dx = end.x - start.x
  const dy = end.y - start.y
  const along = linearInterval(px * ux + py * uy, dx * ux + dy * uy, 0, length)
  const across = linearInterval(-px * uy + py * ux, -dx * uy + dy * ux, -radius, radius)
  if (along && across) {
    const from = Math.max(along[0], across[0])
    const to = Math.min(along[1], across[1])
    if (to - from > EPSILON) result.push([from, to])
  }
  return result
}

function erasedIntervals(start: StrokePoint, end: StrokePoint, eraser: StrokePoint[], radius: number): Interval[] {
  const intervals: Interval[] = []
  if (eraser.length === 1) {
    const interval = circleInterval(start, end, eraser[0], radius)
    if (interval) intervals.push(interval)
  } else {
    for (let i = 1; i < eraser.length; i += 1) {
      intervals.push(...capsuleIntervals(start, end, eraser[i - 1], eraser[i], radius))
    }
  }
  intervals.sort((a, b) => a[0] - b[0])
  const merged: Interval[] = []
  for (const interval of intervals) {
    const last = merged[merged.length - 1]
    if (last && interval[0] <= last[1] + EPSILON) last[1] = Math.max(last[1], interval[1])
    else merged.push([...interval])
  }
  return merged
}

function eraseStroke(stroke: Stroke, eraser: StrokePoint[], radius: number): Stroke[] | null {
  if (stroke.points.length === 0) return null
  const threshold = radius + stroke.width / 2
  // A dot is deliberately handled as a degenerate segment.
  if (stroke.points.length === 1) {
    return erasedIntervals(stroke.points[0], stroke.points[0], eraser, threshold).length ? [] : null
  }
  let touched = false
  const parts: Stroke[] = []
  let run: StrokePoint[] = []
  const flush = () => {
    if (run.length > 0) parts.push({ ...stroke, id: createId(), points: run })
    run = []
  }
  const interpolate = (a: StrokePoint, b: StrokePoint, t: number): StrokePoint => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  })
  for (let i = 1; i < stroke.points.length; i += 1) {
    const a = stroke.points[i - 1]
    const b = stroke.points[i]
    const erased = erasedIntervals(a, b, eraser, threshold)
    touched ||= erased.length > 0
    const keep: Interval[] = []
    let cursor = 0
    for (const [from, to] of erased) {
      if (from - cursor > EPSILON) keep.push([cursor, from])
      cursor = Math.max(cursor, to)
    }
    if (1 - cursor > EPSILON) keep.push([cursor, 1])
    if (keep.length === 0) flush()
    for (const [from, to] of keep) {
      if (from > EPSILON) flush()
      if (run.length === 0) run.push(interpolate(a, b, from))
      run.push(interpolate(a, b, to))
      if (to < 1 - EPSILON) flush()
    }
  }
  flush()
  return touched ? parts : null
}

/** One eraser path splits vector strokes on this page; a miss returns the same array. */
export function eraseStrokes(overlays: Overlay[], pageIndex: number, eraserPoints: StrokePoint[], radius: number): Overlay[] {
  if (eraserPoints.length === 0 || !Number.isFinite(radius) || radius < 0) return overlays
  let changed = false
  const result: Overlay[] = []
  for (const overlay of overlays) {
    if ((!isStroke(overlay) && !isMarker(overlay)) || overlay.pageIndex !== pageIndex) {
      result.push(overlay)
      continue
    }
    const remaining = eraseStroke(isMarker(overlay) ? { id: overlay.id, pageIndex, points: shapeWorldPoints(overlay),
      color: overlay.strokeColor ?? '#ffff00', width: overlay.strokeWidth } : overlay, eraserPoints, radius)
    if (remaining === null) result.push(overlay)
    else {
      changed = true
      result.push(...(isMarker(overlay) ? remaining.flatMap(part => {
        const shape = createShape('marker', part.points, pageIndex, { fill: null, strokeColor: part.color, strokeWidth: part.width }, part.id)
        if (shape && overlay.clips) shape.clips = resolvedOverlayClips(overlay).map(polygon => localizeOverlayClip(shape, polygon))
        return shape ? [shape] : []
      }) : remaining))
    }
  }
  return changed ? result : overlays
}
