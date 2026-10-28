/** Free-space rules for a re-laid paragraph, shared by the worker check and
 * the inline editor's fit display, so both judge a layout identically. */
export interface Box { left: number; right: number; bottom: number; top: number }
export const union = (a: Box, b: Box): Box => ({
  left: Math.min(a.left, b.left),
  right: Math.max(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
  top: Math.max(a.top, b.top),
})
export const overlap = (a: Box, b: Box, gap = 0) =>
  a.left < b.right + gap && a.right + gap > b.left && a.bottom < b.top + gap && a.top + gap > b.bottom
export const contains = (a: Box, b: Box) =>
  a.left <= b.left + 0.001 && a.right + 0.001 >= b.right && a.bottom <= b.bottom + 0.001 && a.top + 0.001 >= b.top
export const separation = (a: Box, b: Box) =>
  Math.max(b.left - a.right, a.left - b.right, b.bottom - a.top, a.bottom - b.top, 0)

export interface BlockSpace {
  /** MediaBox and CropBox. */
  limits: Box[]
  /** Own clip, widened by the original overhang. */
  clip?: Box
  /** Union of the original line boxes. */
  whole?: Box
  leading: number
  /** Full-font band of the block's fonts relative to a baseline. */
  bandBottom: number
  bandTop: number
  /** Other content: text runs, images, graphics, annotations. */
  others: Box[]
}
/** Original line slot (full-font band from the unchanged origin). */
export const slotBox = (band: Pick<BlockSpace, 'bandBottom' | 'bandTop'>, left: number, baseline: number, right: number): Box => ({
  left, right: Math.max(left, right), bottom: baseline + band.bandBottom, top: baseline + band.bandTop,
})
/** Why `rect` (a changed original line slot with its `old` slot, or the ink of
 * a new line) is not allowed; undefined when it is. */
export function blockedBy(space: BlockSpace, rect: Box, old: Box | undefined, ink = rect): string | undefined {
  const { limits, clip, whole } = space
  if (limits.some((l) => !contains(l, ink))) return 'Der Absatz würde die Seiten- oder Zuschnittgrenze überschreiten.'
  if (clip && !contains(clip, ink)) return 'Der Absatz würde außerhalb der ursprünglichen Clipfläche liegen.'
  for (const other of space.others) {
    // Backgrounds contain the whole original block (page fills, boxes).
    if (whole && contains(other, whole)) {
      // Stay inside the background with its original margin (up to 3 pt).
      const margin = Math.max(0, Math.min(3, whole.left - other.left, other.right - whole.right, whole.bottom - other.bottom, other.top - whole.top))
      const inner = { left: other.left + margin, right: other.right - margin, bottom: other.bottom + margin, top: other.top - margin }
      if (!contains(inner, ink)) return 'Der Absatz würde über seine hinterlegte Fläche hinausragen.'
      continue
    }
    if (old && overlap(old, other)) {
      // Existing overlaps (e.g. the bounding box of an image beside a
      // contour-wrapped line) may not grow toward that content.
      if (overlap(rect, other) && Math.min(rect.right, other.right) > Math.min(old.right, other.right) + 0.001)
        return 'Der Absatz würde stärker als bisher mit anderen Inhalten überlappen.'
      continue
    }
    const need = old ? Math.min(3, separation(old, other)) : Math.max(3, Math.min(whole ? separation(whole, other) : 3, space.leading / 2))
    if (overlap(rect, other, Math.max(0, need - 0.001)))
      return old
        ? 'Die Korrektur würde den geschützten Abstand zu benachbartem Text, Bild, Link oder einer Grafik unterschreiten.'
        : 'Für die zusätzliche Absatzzeile ist unter dem Absatz nicht genug freier Platz. Nachfolgende Inhalte werden nicht verschoben.'
  }
  return undefined
}
