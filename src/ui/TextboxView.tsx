import { useEffect, useRef, useState } from 'react'
import { moveTextbox, removeTextbox, updateTextbox } from '../core/commands'
import type { EditorStore } from '../core/editorStore'
import { patchOverlay, type OverlayFont, type Textbox } from '../core/model'
import type { Tool } from './tools'

const FONT_CSS: Record<OverlayFont, string> = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
}

const FONT_OPTIONS: Array<{ value: OverlayFont; label: string }> = [
  { value: 'helvetica', label: 'Helvetica' },
  { value: 'times', label: 'Times' },
  { value: 'courier', label: 'Courier' },
]
const SIZE_OPTIONS = [8, 10, 12, 14, 18, 24, 36]

interface TextboxViewProps {
  box: Textbox
  zoom: number
  pageHeightPts: number
  selected: boolean
  tool: Tool
  store: EditorStore
  onSelect: (id: string | null) => void
}

export function TextboxView({ box, zoom, pageHeightPts, selected, tool, store, onSelect }: TextboxViewProps) {
  const [draft, setDraft] = useState(box.text)
  const [focused, setFocused] = useState(false)
  const beforeEdit = useRef(box.text)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dragFrom = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null)

  // Focus the textarea when a new (still empty) box gets selected.
  useEffect(() => {
    if (selected && box.text === '' && textareaRef.current && document.activeElement !== textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [selected, box.text])

  const commitText = () => {
    if (draft === beforeEdit.current) return
    if (draft.trim().length === 0) {
      store.dispatch(removeTextbox(box))
      onSelect(null)
      return
    }
    store.dispatch(updateTextbox(box.id, { text: beforeEdit.current }, { text: draft }))
  }

  // Selection tool: a surface over the text makes the whole frame draggable;
  // double-click enters text editing. Text tool: the textarea is directly editable.
  const onSurfacePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    event.preventDefault()
    onSelect(box.id)
    event.currentTarget.setPointerCapture(event.pointerId)
    dragFrom.current = { pointerX: event.clientX, pointerY: event.clientY, x: box.x, y: box.y }
  }

  const onSurfacePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragFrom.current
    if (!drag) return
    const dx = (event.clientX - drag.pointerX) / zoom
    const dy = (event.clientY - drag.pointerY) / zoom
    store.preview((state) => patchOverlay(state, box.id, { x: drag.x + dx, y: drag.y - dy }))
  }

  const onSurfacePointerUp = () => {
    const drag = dragFrom.current
    dragFrom.current = null
    if (!drag) return
    const current = store.state.overlays.find((o) => o.id === box.id)
    if (!current || (current.x === drag.x && current.y === drag.y)) return
    store.dispatch(moveTextbox(box.id, { x: drag.x, y: drag.y }, { x: current.x, y: current.y }))
  }

  const left = box.x * zoom
  const top = (pageHeightPts - box.y) * zoom - box.fontSize * zoom

  return (
    <div
      className={`textbox${selected ? ' selected' : ''}`}
      style={{ left, top, fontFamily: FONT_CSS[box.font], fontSize: box.fontSize * zoom }}
      onPointerDown={(event) => {
        event.stopPropagation()
        onSelect(box.id)
      }}
    >
      {selected && (
        <div className="minibar">
          <select
            aria-label="Schriftart"
            value={box.font}
            onChange={(event) =>
              store.dispatch(updateTextbox(box.id, { font: box.font }, { font: event.target.value as OverlayFont }))
            }
          >
            {FONT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Schriftgröße"
            value={box.fontSize}
            onChange={(event) =>
              store.dispatch(updateTextbox(box.id, { fontSize: box.fontSize }, { fontSize: Number(event.target.value) }))
            }
          >
            {SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label="Textbox löschen"
            onClick={() => {
              store.dispatch(removeTextbox(box))
              onSelect(null)
            }}
          >
            🗑
          </button>
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={focused ? draft : box.text}
        rows={1}
        placeholder="Text …"
        aria-label="Textbox-Inhalt"
        onFocus={() => {
          beforeEdit.current = box.text
          setDraft(box.text)
          setFocused(true)
        }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
        onBlur={() => {
          setFocused(false)
          commitText()
        }}
      />
      {tool === 'select' && !focused && (
        <div
          className="drag-surface"
          title="Ziehen zum Verschieben, Doppelklick zum Bearbeiten"
          onPointerDown={onSurfacePointerDown}
          onPointerMove={onSurfacePointerMove}
          onPointerUp={onSurfacePointerUp}
          onDoubleClick={() => textareaRef.current?.focus()}
        />
      )}
    </div>
  )
}
