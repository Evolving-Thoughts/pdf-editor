import type { Command } from './commands'
import { cloneOverlay, createId, type EditorState, type Overlay, type StrokePoint } from './model'
import { pageSize, type DocumentPage, type PageSource } from './pages'
export interface Redaction { id: string; pageId: string; x: number; y: number; width: number; height: number; fill: 'black' | 'white' }
export function createRedaction(pageId: string, start: StrokePoint, end: StrokePoint, size: { width: number; height: number }, fill: Redaction['fill']): Redaction | null {
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value))
  const x1 = clamp(start.x, size.width), x2 = clamp(end.x, size.width), y1 = clamp(start.y, size.height), y2 = clamp(end.y, size.height)
  const x = Math.min(x1, x2), y = Math.min(y1, y2), width = Math.abs(x2 - x1), height = Math.abs(y2 - y1)
  if (![x, y, width, height].every(Number.isFinite) || width < 2 || height < 2) return null
  return { id: createId(), pageId, x, y, width, height, fill }
}
export function replaceRedactions(state: EditorState, next: Redaction[]): Command {
  const before = structuredClone(state.redactions), after = structuredClone(next)
  return { label: 'Edit pending redactions', apply: s => { s.redactions = structuredClone(after) }, revert: s => { s.redactions = structuredClone(before) } }
}
export function moveRedaction(mark: Redaction, dx: number, dy: number, size: { width: number; height: number }): Redaction {
  return { ...mark, x: Math.max(0, Math.min(size.width - mark.width, mark.x + dx)), y: Math.max(0, Math.min(size.height - mark.height, mark.y + dy)) }
}
export function resizeRedaction(mark: Redaction, corner: 'nw' | 'ne' | 'sw' | 'se', dx: number, dy: number, size: { width: number; height: number }): Redaction {
  const east = corner.endsWith('e'), north = corner.startsWith('n')
  const anchorX = east ? mark.x : mark.x + mark.width, anchorY = north ? mark.y : mark.y + mark.height
  const width = Math.max(2, Math.min(east ? size.width - anchorX : anchorX, mark.width + (east ? dx : -dx)))
  const height = Math.max(2, Math.min(north ? size.height - anchorY : anchorY, mark.height + (north ? dy : -dy)))
  return { ...mark, x: east ? anchorX : anchorX - width, y: north ? anchorY : anchorY - height, width, height }
}
export function validateRedactions(marks: Redaction[], pages: DocumentPage[]) {
  if (!marks.length) throw new Error('Bitte zuerst einen Bereich markieren.')
  for (const mark of marks) {
    const page = pages.find(p => p.id === mark.pageId)
    if (!page || page.hasXfa) throw new Error('Die markierte Seite fehlt oder enthält ein nicht unterstütztes XFA-Formular.')
    const size = pageSize(page)
    if (![mark.x, mark.y, mark.width, mark.height].every(Number.isFinite) || mark.x < 0 || mark.y < 0 || mark.width < 2 || mark.height < 2 || mark.x + mark.width > size.width + 1e-6 || mark.y + mark.height > size.height + 1e-6 || !['black', 'white'].includes(mark.fill)) throw new Error('Ungültiger Schwärzungsbereich.')
  }
}
export function applyRedactionResult(state: EditorState, source: PageSource, replacements: DocumentPage[], newText: Overlay[]): Command {
  const affected = new Set(replacements.map(p => p.id)), before = { applied: state.redactionApplied, pages: structuredClone(state.pages), sources: [...(state.pageSources ?? [])], overlays: state.overlays.map(cloneOverlay), marks: structuredClone(state.redactions ?? []) }
  const after = { applied: true, pages: state.pages!.map(p => replacements.find(r => r.id === p.id) ?? p), sources: [...before.sources, source], overlays: [...state.overlays.filter(o => !affected.has(state.pages![o.pageIndex].id)).map(cloneOverlay), ...newText.map(cloneOverlay)], marks: [] }
  const assign = (s: EditorState, v: typeof before) => { s.redactionApplied = v.applied; s.pages = structuredClone(v.pages); s.pageSources = [...v.sources]; s.overlays = v.overlays.map(cloneOverlay); s.redactions = structuredClone(v.marks) }
  return { label: 'Apply true redaction', apply: s => assign(s, after), revert: s => assign(s, before) }
}
