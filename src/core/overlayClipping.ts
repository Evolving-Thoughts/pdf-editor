import { isStroke, isTextbox, type Overlay, type StrokePoint } from './model'

function frame(overlay: Exclude<Overlay, { points: StrokePoint[] }>) {
  const text = isTextbox(overlay)
  const width = Math.max(1e-9, text ? overlay.fontSize : overlay.width || overlay.height)
  const height = Math.max(1e-9, text ? overlay.fontSize : overlay.height || overlay.width)
  const x = text ? overlay.x : overlay.x + overlay.width / 2
  const y = text ? overlay.y : overlay.y + overlay.height / 2
  const angle = (overlay.rotation ?? 0) * Math.PI / 180
  return { x, y, width, height, cos: Math.cos(angle), sin: Math.sin(angle) }
}
/** Capture the visible old page, without freezing future element movement/rotation. */
export function capturePageClip(overlay: Overlay, size: { width: number; height: number }) {
  const points = [{ x: 0, y: 0 }, { x: size.width, y: 0 }, { x: size.width, y: size.height }, { x: 0, y: size.height }]
  overlay.clips = [...(overlay.clips ?? []), localizeOverlayClip(overlay, points)]
}
/** Re-anchor an existing world-space clip when an editable element is split. */
export function localizeOverlayClip(overlay: Overlay, points: StrokePoint[]): StrokePoint[] {
  return isStroke(overlay) ? points.map(p => ({ ...p })) : points.map(p => {
    const f = frame(overlay), dx = p.x - f.x, dy = p.y - f.y
    return { x: (f.cos * dx - f.sin * dy) / f.width, y: (f.sin * dx + f.cos * dy) / f.height }
  })
}
export function resolvedOverlayClips(overlay: Overlay): StrokePoint[][] {
  if (isStroke(overlay)) return overlay.clips ?? []
  const f = frame(overlay)
  return (overlay.clips ?? []).map(polygon => polygon.map(p => ({
    x: f.x + f.cos * p.x * f.width + f.sin * p.y * f.height,
    y: f.y - f.sin * p.x * f.width + f.cos * p.y * f.height,
  })))
}
