import { useRef, useState } from 'react'
import { moveRedaction, resizeRedaction, replaceRedactions, type Redaction } from '../core/redactions'
import type { EditorStore } from '../core/editorStore'
import type { Tool } from './tools'
import type { Bounds, Corner } from '../core/images/geometry'
const names: Record<Corner, string> = { nw: 'oben links', ne: 'oben rechts', sw: 'unten links', se: 'unten rechts' }
interface Props { mark: Redaction; zoom: number; pageSize: Bounds; selected: boolean; tool: Tool; store: EditorStore; onSelect: (id: string | null) => void; readOnly?: boolean }
export function RedactionView({ mark, zoom, pageSize, selected, tool, store, onSelect, readOnly }: Props) {
  const active = !readOnly && (tool === 'redact' || tool === 'select'), gesture = useRef<{ id: number; x: number; y: number; zoom: number; version: number; tool: Tool; corner?: Corner; before: Redaction } | null>(null)
  const [preview, setPreview] = useState<{ mark: Redaction; version: number; zoom: number; tool: Tool } | null>(null)
  const shown = preview && preview.version === store.getVersion() && preview.zoom === zoom && preview.tool === tool && active ? preview.mark : mark
  const cancel = () => { gesture.current = null; setPreview(null) }
  const commit = (next: Redaction) => { if (JSON.stringify(next) !== JSON.stringify(mark)) store.dispatch(replaceRedactions(store.state, (store.state.redactions ?? []).map(m => m.id === mark.id ? next : m))) }
  const next = (event: React.PointerEvent, g: NonNullable<typeof gesture.current>) => g.corner ? resizeRedaction(g.before, g.corner, (event.clientX - g.x) / g.zoom, (g.y - event.clientY) / g.zoom, pageSize) : moveRedaction(g.before, (event.clientX - g.x) / g.zoom, (g.y - event.clientY) / g.zoom, pageSize)
  const start = (event: React.PointerEvent<HTMLElement>) => {
    if (!active || !event.isPrimary || event.button !== 0 || gesture.current) return
    event.stopPropagation(); event.preventDefault(); onSelect(mark.id); event.currentTarget.focus({ preventScroll: true })
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, zoom, version: store.getVersion(), tool, corner: event.currentTarget.dataset.corner as Corner | undefined, before: { ...mark } }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const valid = (g: NonNullable<typeof gesture.current>) => active && g.zoom === zoom && g.tool === tool && g.version === store.getVersion()
  const move = (event: React.PointerEvent) => { const g = gesture.current; if (!g || g.id !== event.pointerId) return; event.stopPropagation(); if (!valid(g)) { cancel(); return } setPreview({ mark: next(event, g), version: g.version, zoom: g.zoom, tool: g.tool }) }
  const finish = (event: React.PointerEvent) => { const g = gesture.current; if (!g || g.id !== event.pointerId) return; event.stopPropagation(); const result = next(event, g), ok = valid(g); cancel(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (ok) commit(result) }
  const key = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!active) return
    if (event.key === 'Escape') { cancel(); return }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); store.dispatch(replaceRedactions(store.state, (store.state.redactions ?? []).filter(m => m.id !== mark.id))); onSelect(null) }
    if (!event.ctrlKey && !event.metaKey && event.key.startsWith('Arrow')) { event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 10 : 1, dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0, corner = event.currentTarget.dataset.corner as Corner | undefined; commit(corner ? resizeRedaction(mark, corner, dx, dy, pageSize) : moveRedaction(mark, dx, dy, pageSize)) }
  }
  return <div className={`redaction-overlay${selected && active ? ' selected' : ''} ${mark.fill}`} data-redaction-id={mark.id} role="group" aria-label="Vorgemerkter Schwärzungsbereich" tabIndex={active ? 0 : -1}
    style={{ left: shown.x * zoom, top: (pageSize.height - shown.y - shown.height) * zoom, width: shown.width * zoom, height: shown.height * zoom, pointerEvents: active ? 'auto' : 'none' }}
    onFocus={() => { if (active) onSelect(mark.id) }} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel} onKeyDown={key}>
    {selected && active && (['nw', 'ne', 'sw', 'se'] as Corner[]).map(corner => <button key={corner} className={`redaction-grip ${corner}`} data-corner={corner} aria-label={`Schwärzungsbereich ${names[corner]} skalieren`} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel} onKeyDown={key} />)}
  </div>
}
