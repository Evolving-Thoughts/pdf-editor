import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { moveTextbox, removeTextbox, updateTextbox } from '../core/commands'
import type { EditorStore } from '../core/editorStore'
import { patchOverlay, type OverlayFont, type Textbox } from '../core/model'
import type { Tool } from './tools'

interface FontCss {
  fontFamily: string
  fontWeight?: 'bold'
  fontStyle?: 'italic'
}

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
const LINE_HEIGHT = 1.2

function clampFontSize(raw: string): number | null {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(parsed * 10) / 10))
}

// Text measurement for the textarea autosize: field-sizing is not reliable
// enough across browsers, so we size the box explicitly from the content.
let measureCtx: CanvasRenderingContext2D | null = null

function measureText(text: string, css: FontCss, px: number): { width: number; lines: number } {
  const lines = text.split('\n')
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return { width: text.length * px * 0.6, lines: Math.max(1, lines.length) }
  measureCtx.font = `${css.fontStyle ?? 'normal'} ${css.fontWeight ?? 'normal'} ${px}px ${css.fontFamily}`
  let width = 0
  for (const line of lines) width = Math.max(width, measureCtx.measureText(line || ' ').width)
  return { width, lines: Math.max(1, lines.length) }
}

interface FontSizePickerProps {
  value: number
  onCommit: (size: number) => void
}

/** Button that opens a small popover: free input on top, preset list below. */
function FontSizePicker({ value, onCommit }: FontSizePickerProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(String(value))
  const wrapRef = useRef<HTMLSpanElement>(null)
  const cancelled = useRef(false)

  const close = useCallback(
    (commit: boolean) => {
      if (commit && !cancelled.current) {
        const size = clampFontSize(draft)
        if (size !== null && size !== value) onCommit(size)
      }
      cancelled.current = false
      setOpen(false)
    },
    [draft, value, onCommit],
  )

  // Commit-and-close when clicking anywhere outside the picker.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) close(true)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open, close])

  const pickPreset = (size: number) => {
    setOpen(false)
    if (size !== value) onCommit(size)
  }

  return (
    <span className="font-size-picker" ref={wrapRef}>
      <button
        type="button"
        aria-label="Schriftgröße"
        aria-expanded={open}
        onClick={() => {
          if (open) close(true)
          else {
            setDraft(String(value))
            setOpen(true)
          }
        }}
      >
        {value}&nbsp;▾
      </button>
      {open && (
        <span className="font-size-popover">
          <input
            type="text"
            inputMode="decimal"
            autoFocus
            aria-label="Schriftgröße eingeben"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') close(true)
              if (event.key === 'Escape') {
                cancelled.current = true
                close(false)
              }
            }}
            onBlur={() => close(true)}
          />
          {SIZE_PRESETS.map((size) => (
            <button
              key={size}
              type="button"
              className={size === value ? 'current' : ''}
              // pointerdown (not click) + preventDefault: commit before the
              // input's blur can fire, so no double commit with a stale value.
              onPointerDown={(event) => {
                event.preventDefault()
                pickPreset(size)
              }}
            >
              {size}
            </button>
          ))}
        </span>
      )}
    </span>
  )
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
  const beforeEdit = useRef(box.text)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dragFrom = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null)

  const displayText = focused ? draft : box.text

  const fontCss: FontCss = {
    fontFamily: FONT_CSS[box.font],
    fontWeight: box.bold ? 'bold' : undefined,
    fontStyle: box.italic ? 'italic' : undefined,
  }

  // Autosize the textarea to its content (also when the font size grows
  // beyond the current box): width fits the longest line, height the lines.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const px = box.fontSize * zoom
    const { width, lines } = measureText(
      displayText,
      {
        fontFamily: FONT_CSS[box.font],
        fontWeight: box.bold ? 'bold' : undefined,
        fontStyle: box.italic ? 'italic' : undefined,
      },
      px,
    )
    el.style.width = `${Math.max(40, Math.ceil(width) + 10 + Math.ceil(px * 0.2))}px`
    el.style.height = `${Math.ceil(lines * px * LINE_HEIGHT) + 6}px`
  }, [displayText, box.font, box.bold, box.italic, box.fontSize, zoom])

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
      style={{
        left,
        top,
        ...fontCss,
        textDecoration: box.underline ? 'underline' : undefined,
        fontSize: box.fontSize * zoom,
      }}
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
          <button
            type="button"
            className="style-toggle"
            aria-label="Fett"
            aria-pressed={box.bold}
            title="Fett"
            onClick={() => store.dispatch(updateTextbox(box.id, { bold: box.bold }, { bold: !box.bold }))}
          >
            <b>B</b>
          </button>
          <button
            type="button"
            className="style-toggle"
            aria-label="Kursiv"
            aria-pressed={box.italic}
            title="Kursiv"
            onClick={() => store.dispatch(updateTextbox(box.id, { italic: box.italic }, { italic: !box.italic }))}
          >
            <i>I</i>
          </button>
          <button
            type="button"
            className="style-toggle"
            aria-label="Unterstrichen"
            aria-pressed={box.underline}
            title="Unterstrichen"
            onClick={() => store.dispatch(updateTextbox(box.id, { underline: box.underline }, { underline: !box.underline }))}
          >
            <u>U</u>
          </button>
          <FontSizePicker
            value={box.fontSize}
            onCommit={(size) => {
              if (size !== box.fontSize) {
                store.dispatch(updateTextbox(box.id, { fontSize: box.fontSize }, { fontSize: size }))
              }
            }}
          />
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
        value={displayText}
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
