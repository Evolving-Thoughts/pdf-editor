// Pure viewer zoom logic — no React, no PDF libraries.
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 3
export const ZOOM_STEP = 0.25

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

export function zoomIn(zoom: number): number {
  return clampZoom(zoom + ZOOM_STEP)
}

export function zoomOut(zoom: number): number {
  return clampZoom(zoom - ZOOM_STEP)
}
