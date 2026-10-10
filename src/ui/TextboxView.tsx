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
const SIZE_PRESETS = [8, 10, 12, 14, 18, 24, 36]
const MIN_FONT_SIZE = 4
const MAX_FONT_SIZE = 200

function clampFontSize(raw: string): number | null {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(parsed * 10) / 10))
}

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
  // Local editing state for the font-size field; null = show the box's value.
  const [sizeDraft, setSizeDraft] = useState<string | null>(null)
  // Escape blurs the size field; this flag stops the blur from committing.
  const sizeCancelled = useRef(false)
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
          <input
            type="text"
            inputMode="decimal"
            className="font-size"
            aria-label="Schriftgröße"
            list={`font-size-presets-${box.id}`}
            value={sizeDraft ?? box.fontSize}
            onChange={(event) => setSizeDraft(event.target.value)}
            onBlur={(event) => {
              if (sizeCancelled.current) {
                sizeCancelled.current = false
                setSizeDraft(null)
                return
              }
              setSizeDraft(null)
              const size = clampFontSize(event.target.value)
              if (size !== null && size !== box.fontSize) {
                store.dispatch(updateTextbox(box.id, { fontSize: box.fontSize }, { fontSize: size }))
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                sizeCancelled.current = true
                setSizeDraft(null)
                event.currentTarget.blur()
              }
            }}
          />
          <datalist id={`font-size-presets-${box.id}`}>
            {SIZE_PRESETS.map((size) => (
              <option key={size} value={size} />
            ))}
          </datalist>
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
