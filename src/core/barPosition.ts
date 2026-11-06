// Where a movable toolbar may sit inside the workspace. Screen pixels, y downwards.
export interface BarPosition { x: number; y: number }
interface Size { width: number; height: number }

export const BAR_HOME: BarPosition = { x: 16, y: 16 }
const MARGIN = 8

/** Keeps the bar reachable, also in a space too small for it. */
export function boundBar(next: BarPosition, space: Size, bar: Size): BarPosition {
  return {
    x: Math.max(MARGIN, Math.min(next.x, Math.max(MARGIN, space.width - bar.width - MARGIN))),
    y: Math.max(MARGIN, Math.min(next.y, Math.max(MARGIN, space.height - bar.height - MARGIN))),
  }
}

/** The grip's keys. Null for any other key. */
export function barKeyTarget({ key, shiftKey }: { key: string; shiftKey: boolean }, from: BarPosition): BarPosition | null {
  const step = shiftKey ? 40 : 10
  if (key === 'Home') return BAR_HOME
  if (key === 'ArrowLeft') return { ...from, x: from.x - step }
  if (key === 'ArrowRight') return { ...from, x: from.x + step }
  if (key === 'ArrowUp') return { ...from, y: from.y - step }
  if (key === 'ArrowDown') return { ...from, y: from.y + step }
  return null
}

export interface Rect { left: number; top: number; right: number; bottom: number }
const GAP = 6

/**
 * Where an element's own toolbar goes: above the element, below when there is
 * no room above, always inside the visible area. Hidden once the element has
 * left that area, so the bar never floats over unrelated content.
 */
export function floatingBarPosition(element: Rect, bar: Size, area: Rect): { left: number; top: number; hidden: boolean } {
  const hidden = element.bottom < area.top || element.top > area.bottom || element.right < area.left || element.left > area.right
  let top = element.top - bar.height - GAP
  if (top < area.top) top = element.bottom + GAP
  if (top + bar.height > area.bottom) top = area.bottom - bar.height
  top = Math.max(area.top, top)
  const left = Math.max(area.left, Math.min(element.left, area.right - bar.width))
  return { left, top, hidden }
}
