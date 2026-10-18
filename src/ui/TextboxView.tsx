import './fonts.css'
import { fontSupportsItalic } from '../core/fonts'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { moveTextbox, removeTextbox, updateTextbox } from '../core/commands'
import type { EditorStore } from '../core/editorStore'
import { isTextbox, patchOverlay, type OverlayFont, type Textbox } from '../core/model'
import { TEXT_LINE_HEIGHT as LINE_HEIGHT } from '../core/textLayout'
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
  'noto-sans': "'Noto Sans', sans-serif",
  'noto-serif': "'Noto Serif', serif",
  'carlito': "'Carlito', sans-serif",
  'lato': "'Lato', sans-serif",
  'eb-garamond': "'EB Garamond', serif",
  'roboto-mono': "'Roboto Mono', monospace",
  'caveat': "'Caveat', cursive",
  // Browsers have no ZapfDingbats; the box stores Unicode symbols anyway,
  // so the editor renders them with system fonts. Export maps to the font.
  zapfdingbats: 'system-ui, sans-serif',
}

const FONT_OPTIONS: Array<{ value: OverlayFont; label: string }> = [
  { value: 'helvetica', label: 'Helvetica' },
  { value: 'times', label: 'Times' },
  { value: 'courier', label: 'Courier' },
  { value: 'noto-sans', label: 'Noto Sans' },
  { value: 'noto-serif', label: 'Noto Serif' },
  { value: 'carlito', label: 'Carlito' },
  { value: 'lato', label: 'Lato' },
  { value: 'eb-garamond', label: 'EB Garamond' },
  { value: 'roboto-mono', label: 'Roboto Mono' },
  { value: 'caveat', label: 'Caveat' },
]

const SIZE_PRESETS = [8, 10, 12, 14, 18, 24, 36]
const MIN_FONT_SIZE = 4
const MAX_FONT_SIZE = 200

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
  const baselineLineRef = useRef<HTMLSpanElement>(null)
  const baselineMarkerRef = useRef<HTMLSpanElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const dragFrom = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null)

  const displayText = focused ? draft : box.text
  const isSymbol = box.font === 'zapfdingbats'

  const fontCss: FontCss = {
    fontFamily: FONT_CSS[box.font],
    fontWeight: box.bold ? 'bold' : undefined,
    fontStyle: box.italic && fontSupportsItalic(box.font) ? 'italic' : undefined,
  }

  const [fontRevision, setFontRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    void document.fonts.load(`${box.italic && fontSupportsItalic(box.font) ? 'italic' : 'normal'} ${box.bold ? 700 : 400} 16px ${FONT_CSS[box.font]}`).then(() => {
      if (!cancelled) setFontRevision(value => value + 1)
    }).catch(console.warn)
    return () => { cancelled = true }
  }, [box.font, box.bold, box.italic])

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
        fontStyle: box.italic && fontSupportsItalic(box.font) ? 'italic' : undefined,
      },
      px,
    )
    el.style.width = `${Math.max(40, Math.ceil(width) + 10 + Math.ceil(px * 0.2))}px`
    el.style.height = `${Math.ceil(lines * px * LINE_HEIGHT) + 6}px`
    // CSS padding/border must not move glyphs away from the stored PDF origin.
    // Canvas font bounds are not the CSS line-box baseline: their metrics and
    // leading are rounded differently. Measure a zero-height inline baseline
    // marker in the same inherited font/line-height as the textarea instead.
    const line = baselineLineRef.current
    const marker = baselineMarkerRef.current
    if (!line || !marker) return
    if (anchorRef.current) anchorRef.current.style.transform = 'none'
    const baseline = marker.getBoundingClientRect().top - line.getBoundingClientRect().top
    const chrome = getComputedStyle(el)
    const insetX = parseFloat(chrome.paddingLeft) + parseFloat(chrome.borderLeftWidth)
    const insetY = parseFloat(chrome.paddingTop) + parseFloat(chrome.borderTopWidth)
    if (anchorRef.current) {
      anchorRef.current.style.left = `${box.x * zoom - insetX}px`
      anchorRef.current.style.top = `${(pageHeightPts - box.y) * zoom - baseline - insetY}px`
      anchorRef.current.style.transformOrigin = `${insetX}px ${baseline + insetY}px`
      anchorRef.current.style.transform = `rotate(${box.rotation ?? 0}deg)`
    }
  }, [fontRevision, displayText, box.font, box.bold, box.italic, box.fontSize, box.x, box.y, box.rotation, pageHeightPts, zoom])

  // Focus the textarea when a new (still empty) box gets selected.
  useEffect(() => {
    if (selected && box.text === '' && textareaRef.current && document.activeElement !== textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [selected, box.text])

  const commitText = (removeIfEmpty: boolean) => {
    if (isSymbol) return
    // Empty check before the no-change return: a freshly created box is
    // auto-focused with empty text, so draft === beforeEdit ('' === '')
    // would early-return and leave an invisible orphan box on the page.
    if (draft.trim().length === 0) {
      // …but only when focus truly leaves the box: blurring into the
      // minibar (e.g. to set the font size first) must keep the empty box.
      if (removeIfEmpty) {
        store.dispatch(removeTextbox(box))
        onSelect(null)
      }
      return
    }
    if (draft === beforeEdit.current) return
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
    if (!current || !isTextbox(current) || (current.x === drag.x && current.y === drag.y)) return
    store.dispatch(moveTextbox(box.id, { x: drag.x, y: drag.y }, { x: current.x, y: current.y }))
  }

  const left = box.x * zoom
  const top = (pageHeightPts - box.y) * zoom - box.fontSize * zoom

  return (
    <div
      ref={anchorRef}
      className={`textbox${selected ? ' selected' : ''}`}
      style={{ left, top, ...fontCss, fontSize: box.fontSize * zoom }}
      onPointerDown={(event) => {
        event.stopPropagation()
        onSelect(box.id)
      }}
    >
      <span
        ref={baselineLineRef}
        aria-hidden="true"
        style={{
          position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
          whiteSpace: 'pre', lineHeight: LINE_HEIGHT,
        }}
      >
        Mg<span
          ref={baselineMarkerRef}
          style={{ display: 'inline-block', width: 0, height: 0, verticalAlign: 'baseline' }}
        />
      </span>
      {selected && (
        <div className="minibar">
          {!isSymbol && (
            <select
              aria-label="Schriftart"
              value={box.font}
              onChange={(event) => {
                const font = event.target.value as OverlayFont
                store.dispatch(updateTextbox(box.id, { font: box.font, italic: box.italic }, { font, italic: box.italic && fontSupportsItalic(font) }))
              }}
            >
              {FONT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          {isSymbol && <span className="symbol-kind">Symbol</span>}
          {!isSymbol && (
            <>
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
                aria-pressed={box.italic && fontSupportsItalic(box.font)}
                disabled={!fontSupportsItalic(box.font)}
                title={fontSupportsItalic(box.font) ? 'Kursiv' : 'Caveat bietet keinen kursiven Schnitt'}
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
                onClick={() =>
                  store.dispatch(updateTextbox(box.id, { underline: box.underline }, { underline: !box.underline }))
                }
              >
                <u>U</u>
              </button>
            </>
          )}
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
        // text-decoration does not propagate into the textarea's text (it is
        // a replaced element), so underline must be set on the element itself.
        style={{ lineHeight: LINE_HEIGHT, textDecoration: box.underline ? 'underline' : undefined }}
        value={displayText}
        rows={1}
        placeholder={isSymbol ? undefined : 'Text …'}
        aria-label={isSymbol ? 'Symbol' : 'Textbox-Inhalt'}
        readOnly={isSymbol}
        tabIndex={isSymbol ? -1 : undefined}
        onFocus={(event) => {
          if (isSymbol) {
            event.currentTarget.blur()
            return
          }
          beforeEdit.current = box.text
          setDraft(box.text)
          setFocused(true)
        }}
        onChange={(event) => {
          if (!isSymbol) setDraft(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
        onBlur={(event) => {
          setFocused(false)
          const staysInside =
            event.relatedTarget instanceof Node &&
            event.currentTarget.closest('.textbox')?.contains(event.relatedTarget) === true
          commitText(!staysInside)
        }}
      />
      {tool === 'select' && !focused && (
        <div
          className="drag-surface"
          title="Ziehen zum Verschieben, Doppelklick zum Bearbeiten"
          onPointerDown={onSurfacePointerDown}
          onPointerMove={onSurfacePointerMove}
          onPointerUp={onSurfacePointerUp}
          onDoubleClick={() => {
            if (!isSymbol) textareaRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}
