/** Selection is transient UI state, keyed by stable page IDs, never page indexes. */
export interface PageSelectionGesture { range?: boolean; toggle?: boolean; checked?: boolean }
export function selectPages(order: readonly string[], ids: readonly string[], anchor: string | null, target: string, gesture: PageSelectionGesture = {}) {
  const selected = new Set(ids), index = order.indexOf(target)
  const current = order.filter(id => selected.has(id))
  if (index < 0) return { ids: current, anchor }
  if (gesture.range) {
    const start = anchor ? order.indexOf(anchor) : -1
    const from = start < 0 ? index : start
    const range = order.slice(Math.min(from, index), Math.max(from, index) + 1)
    const chosen = new Set(gesture.toggle ? [...current, ...range] : range)
    return { ids: order.filter(id => chosen.has(id)), anchor: start < 0 ? target : anchor }
  }
  if (gesture.toggle || gesture.checked !== undefined) {
    const checked = gesture.checked ?? !selected.has(target)
    return { ids: order.filter(id => id === target ? checked : selected.has(id)), anchor: target }
  }
  // A plain title click previews the page without discarding checked pages.
  return { ids: current, anchor: target }
}
