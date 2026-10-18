// Limits per canvas, not a promise to bound all PDF parsing/decoding memory.
export const MAX_RENDER_PIXELS = 16_000_000
export const MAX_RENDER_SIDE = 8192
export const MAX_PAGE_SIDE = 32_768

export function validatePageSize(width: number, height: number): void {
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= MAX_PAGE_SIDE)) {
    throw new Error('Die Seitenabmessungen sind ungültig oder zu groß für eine sichere Anzeige.')
  }
}

/** Preserve CSS geometry; reduce only raster resolution on large/HiDPI views. */
export function renderPlan(width: number, height: number, zoom: number, pixelRatio: number) {
  validatePageSize(width, height)
  if (![zoom, pixelRatio].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Ungültiger Zoom oder Pixelfaktor für die Seitenanzeige.')
  }
  const cssWidth = width * zoom, cssHeight = height * zoom
  validatePageSize(cssWidth, cssHeight)
  const scale = Math.min(
    zoom * pixelRatio,
    MAX_RENDER_SIDE / width,
    MAX_RENDER_SIDE / height,
    Math.sqrt(MAX_RENDER_PIXELS / width / height),
  )
  return { scale, cssWidth, cssHeight }
}