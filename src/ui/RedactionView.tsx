import { moveRedaction, resizeRedaction, replaceRedactions, type Redaction } from '../core/redactions'
import type { EditorStore } from '../core/editorStore'
import type { Tool } from './tools'
import type { Bounds, Corner } from '../core/images/geometry'
import { arrowStep, type GestureStep } from '../core/overlayGesture'
import { useOverlayGesture } from './useOverlayGesture'
const names: Record<Corner, string> = { nw: 'oben links', ne: 'oben rechts', sw: 'unten links', se: 'unten rechts' }
interface Props { mark: Redaction; zoom: number; pageSize: Bounds; selected: boolean; tool: Tool; store: EditorStore; onSelect: (id: string | null) => void; readOnly?: boolean }
export function RedactionView({ mark, zoom, pageSize, selected, tool, store, onSelect, readOnly }: Props) {
  const active = !readOnly && (tool === 'redact' || tool === 'select')
  const commit = (next: Redaction) => { if (JSON.stringify(next) !== JSON.stringify(mark)) store.dispatch(replaceRedactions(store.state, (store.state.redactions ?? []).map(m => m.id === mark.id ? next : m))) }
  const next = ({ data, dx, dy }: GestureStep<{ corner?: Corner; before: Redaction }>) => data.corner ? resizeRedaction(data.before, data.corner, dx, dy, pageSize) : moveRedaction(data.before, dx, dy, pageSize)
  const gesture = useOverlayGesture(() => ({ zoom, version: store.getVersion(), tool, active }), next, commit)
  const shown = gesture.shown ?? mark
  const start = (event: React.PointerEvent<HTMLElement>) => {
    if (!active || !gesture.begin(event, { corner: event.currentTarget.dataset.corner as Corner | undefined, before: { ...mark } })) return
    onSelect(mark.id); event.currentTarget.focus({ preventScroll: true })
  }
  const key = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!active) return
    if (event.key === 'Escape') { gesture.cancel(); return }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); store.dispatch(replaceRedactions(store.state, (store.state.redactions ?? []).filter(m => m.id !== mark.id))); onSelect(null) }
    const step = event.ctrlKey || event.metaKey ? null : arrowStep(event)
    if (step) { event.preventDefault(); event.stopPropagation(); const corner = event.currentTarget.dataset.corner as Corner | undefined; commit(corner ? resizeRedaction(mark, corner, step.dx, step.dy, pageSize) : moveRedaction(mark, step.dx, step.dy, pageSize)) }
  }
  return <div className={`redaction-overlay${selected && active ? ' selected' : ''} ${mark.fill}`} data-redaction-id={mark.id} role="group" aria-label="Vorgemerkter Schwärzungsbereich" tabIndex={active ? 0 : -1}
    style={{ left: shown.x * zoom, top: (pageSize.height - shown.y - shown.height) * zoom, width: shown.width * zoom, height: shown.height * zoom, pointerEvents: active ? 'auto' : 'none' }}
    onFocus={() => { if (active) onSelect(mark.id) }} onPointerDown={start} {...gesture.pointer} onKeyDown={key}>
    {selected && active && (['nw', 'ne', 'sw', 'se'] as Corner[]).map(corner => <button key={corner} className={`redaction-grip ${corner}`} data-corner={corner} aria-label={`Schwärzungsbereich ${names[corner]} skalieren`} onPointerDown={start} {...gesture.pointer} onKeyDown={key} />)}
  </div>
}
