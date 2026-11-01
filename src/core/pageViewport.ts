// Where the pages sit in the scrolling view. Measuring stays in the UI; this is the
// arithmetic on those measurements, in screen pixels.
export interface Box { left: number; right: number; top: number; bottom: number }

export function visibleArea(page: Box, view: Box) {
  return Math.max(0, Math.min(page.bottom, view.bottom) - Math.max(page.top, view.top)) *
    Math.max(0, Math.min(page.right, view.right) - Math.max(page.left, view.left))
}

/** The page with the largest visible area. The fallback stands when none is visible. */
export function largestVisiblePage(pages: readonly { index: number; box: Box }[], view: Box, fallback: number) {
  let best = fallback, area = 0
  for (const { index, box } of pages) {
    const visible = visibleArea(box, view)
    if (visible > area) { area = visible; best = index }
  }
  return best
}

/** The middle of what is visible of a page, in page points with y upwards. */
export function visibleCenter(page: Box, view: Box, zoom: number, pageHeight: number) {
  return {
    x: ((Math.max(page.left, view.left) + Math.min(page.right, view.right)) / 2 - page.left) / zoom,
    y: pageHeight - ((Math.max(page.top, view.top) + Math.min(page.bottom, view.bottom)) / 2 - page.top) / zoom,
  }
}

export interface HitPoint { x: number; y: number }
export const polygonCenter = (polygon: readonly HitPoint[]): HitPoint => ({
  x: polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length,
  y: polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length,
})

/** How far to scroll so a point on a page lands in the part of the view no panel covers. */
export function scrollToPoint(
  point: HitPoint, page: Box, view: Box, zoom: number,
  client: { width: number; height: number }, panel?: Box,
) {
  const centeredX = view.left + client.width / 2
  const coveredTop = panel && centeredX >= panel.left && centeredX <= panel.right
    ? Math.max(0, Math.min(client.height, panel.bottom - view.top + 8)) : 0
  return {
    left: page.left - view.left + point.x * zoom - client.width / 2,
    top: page.top - view.top + point.y * zoom - (coveredTop + (client.height - coveredTop) / 2),
  }
}
