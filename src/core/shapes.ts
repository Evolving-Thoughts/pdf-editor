// Editable vector geometry. Framework-free; shares proven rectangle transforms with images.
import { createId, type ShapeKind, type ShapeOverlay, type StrokePoint } from './model'
import { moveImage, resizeImage, rotateImage, type Bounds, type Corner } from './images/geometry'
export interface ShapeStyle {
  fill: string | null
  strokeColor: string | null
  strokeWidth: number
}

export function createShape(
  kind: ShapeKind,
  points: StrokePoint[],
  pageId: string,
  style: ShapeStyle,
  id = createId(),
): ShapeOverlay | null {
  if (
    points.length < (kind === 'marker' ? 1 : 2) ||
    points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    return null
  if (!Number.isFinite(style.strokeWidth) || style.strokeWidth <= 0) return null
  const first = points[0],
    last = points[points.length - 1]
  const sampled = kind === 'marker' ? points : [first, last]
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    top = -Infinity
  for (const point of sampled) {
    x = Math.min(x, point.x)
    y = Math.min(y, point.y)
    right = Math.max(right, point.x)
    top = Math.max(top, point.y)
  }
  let width = right - x,
    height = top - y
  if ((kind === 'rect' || kind === 'ellipse') && (width < 4 || height < 4)) return null
  if ((kind === 'line' || kind === 'arrow') && Math.hypot(width, height) < 4) return null
  if (kind === 'marker') {
    x -= Math.max(0, 4 - width) / 2
    y -= Math.max(0, 4 - height) / 2
    width = Math.max(4, width)
    height = Math.max(4, height)
  }
  const shape: ShapeOverlay = {
    kind: 'shape',
    shape: kind,
    id,
    pageId,
    x,
    y,
    width,
    height,
    rotation: 0,
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidth,
    fill: kind === 'rect' || kind === 'ellipse' ? style.fill : null,
  }
  if (kind === 'line' || kind === 'arrow') {
    shape.flipX = last.x < first.x
    shape.flipY = last.y < first.y
  }
  if (kind === 'marker')
    shape.markerPoints = points.map((p) => ({ x: (p.x - x) / width, y: (p.y - y) / height }))
  return shape
}

export type ShapeChanges = Pick<
  ShapeOverlay,
  'x' | 'y' | 'width' | 'height' | 'rotation' | 'fill' | 'strokeColor' | 'strokeWidth' | 'flipX' | 'flipY'
>
export function shapeGeometry(shape: ShapeOverlay): ShapeChanges {
  const { x, y, width, height, rotation, fill, strokeColor, strokeWidth, flipX, flipY } = shape
  return { x, y, width, height, rotation, fill, strokeColor, strokeWidth, flipX, flipY }
}

function transformed(
  shape: ShapeChanges,
  next: { x: number; y: number; width: number; height: number; rotation?: number },
): ShapeChanges {
  return {
    ...shape,
    x: next.x,
    y: next.y,
    width: next.width,
    height: next.height,
    rotation: next.rotation ?? 0,
  }
}
export function moveShape(shape: ShapeChanges, dx: number, dy: number, page: Bounds): ShapeChanges {
  return transformed(shape, moveImage({ ...shape, lockAspectRatio: false }, dx, dy, page))
}
export function resizeShape(
  shape: ShapeChanges,
  corner: Corner,
  dx: number,
  dy: number,
  page: Bounds,
): ShapeChanges {
  return transformed(shape, resizeImage({ ...shape, lockAspectRatio: false }, corner, dx, dy, page))
}
export function rotateShape(shape: ShapeChanges, angle: number, page: Bounds, snap = false): ShapeChanges {
  return transformed(shape, rotateImage({ ...shape, lockAspectRatio: false }, angle, page, snap))
}
export const MARKER_OPACITY = 0.35

export function shapeWorldPoints(shape: ShapeOverlay): StrokePoint[] {
  const local =
    shape.shape === 'marker'
      ? (shape.markerPoints ?? [])
      : [
          { x: shape.flipX ? 1 : 0, y: shape.flipY ? 1 : 0 },
          { x: shape.flipX ? 0 : 1, y: shape.flipY ? 0 : 1 },
        ]
  const a = (shape.rotation * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a)
  const cx = shape.x + shape.width / 2,
    cy = shape.y + shape.height / 2
  return local.map((p) => {
    const dx = (p.x - 0.5) * shape.width,
      dy = (p.y - 0.5) * shape.height
    return { x: cx + c * dx + s * dy, y: cy - s * dx + c * dy }
  })
}
export function setShapeEndpoint(
  shape: ShapeOverlay,
  end: 'start' | 'end',
  point: StrokePoint,
  page: Bounds,
): ShapeChanges {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return shapeGeometry(shape)
  const points = shapeWorldPoints(shape)
  points[end === 'start' ? 0 : 1] = {
    x: Math.max(0, Math.min(page.width, point.x)),
    y: Math.max(0, Math.min(page.height, point.y)),
  }
  const [start, finish] = points
  if (Math.hypot(finish.x - start.x, finish.y - start.y) < 4) return shapeGeometry(shape)
  const a = (shape.rotation * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a)
  const dx = c * (finish.x - start.x) - s * (finish.y - start.y)
  const dy = s * (finish.x - start.x) + c * (finish.y - start.y)
  const width = Math.abs(dx),
    height = Math.abs(dy)
  return {
    ...shapeGeometry(shape),
    x: (start.x + finish.x - width) / 2,
    y: (start.y + finish.y - height) / 2,
    width,
    height,
    flipX: dx < 0,
    flipY: dy < 0,
  }
}

/** One local SVG path is shared by preview and PDF export; SVG coordinates are y-down. */
export function shapeToSvgPath(shape: ShapeOverlay): string {
  const w = shape.width,
    h = shape.height,
    f = (n: number) => Number(n.toFixed(3)).toString()
  if (shape.shape === 'rect') return `M 0 0 L ${f(w)} 0 L ${f(w)} ${f(h)} L 0 ${f(h)} Z`
  if (shape.shape === 'ellipse') {
    const rx = w / 2,
      ry = h / 2,
      k = 0.55228475
    return `M ${f(rx)} 0 C ${f(rx + rx * k)} 0 ${f(w)} ${f(ry - ry * k)} ${f(w)} ${f(ry)} C ${f(w)} ${f(ry + ry * k)} ${f(rx + rx * k)} ${f(h)} ${f(rx)} ${f(h)} C ${f(rx - rx * k)} ${f(h)} 0 ${f(ry + ry * k)} 0 ${f(ry)} C 0 ${f(ry - ry * k)} ${f(rx - rx * k)} 0 ${f(rx)} 0 Z`
  }
  if (shape.shape === 'marker') {
    const points = shape.markerPoints ?? []
    if (points.length === 1)
      return `M ${f(points[0].x * w)} ${f((1 - points[0].y) * h)} L ${f(points[0].x * w + 0.01)} ${f((1 - points[0].y) * h)}`
    return points.map((p, index) => `${index ? 'L' : 'M'} ${f(p.x * w)} ${f((1 - p.y) * h)}`).join(' ')
  }
  const sx = shape.flipX ? w : 0,
    sy = shape.flipY ? 0 : h,
    ex = shape.flipX ? 0 : w,
    ey = shape.flipY ? h : 0
  let path = `M ${f(sx)} ${f(sy)} L ${f(ex)} ${f(ey)}`
  if (shape.shape === 'arrow') {
    const a = Math.atan2(ey - sy, ex - sx),
      length = Math.min(12 + shape.strokeWidth * 2, Math.hypot(w, h) / 2)
    path += ` M ${f(ex - length * Math.cos(a - 0.5))} ${f(ey - length * Math.sin(a - 0.5))} L ${f(ex)} ${f(ey)} L ${f(ex - length * Math.cos(a + 0.5))} ${f(ey - length * Math.sin(a + 0.5))}`
  }
  return path
}
