import { useEffect, useRef, useState, type RefObject } from 'react'
import { removeShape, updateShape } from '../core/commands'
import type { EditorStore } from '../core/editorStore'
import type { ShapeOverlay } from '../core/model'
import { shapeGeometry, rotateShape, type ShapeChanges } from '../core/shapes'
import type { Bounds } from '../core/images/geometry'
import { RotationIcon } from './ImageView'
import { SHAPE_TOOLS } from './tools'
const HOME = { x: 16, y: 16 }
const FILL = [
  { value: null, label: 'Keine Füllung' },
  { value: '#ffffff', label: 'Weiß' },
  { value: '#ffe34d', label: 'Gelb' },
  { value: '#2455c7', label: 'Blau' },
]
const STROKE = [
  { value: null, label: 'Keine Kontur' },
  { value: '#111111', label: 'Schwarz' },
  { value: '#2455c7', label: 'Blau' },
  { value: '#c72b32', label: 'Rot' },
]
const MARKER = [
  { value: '#ffe34d', label: 'Gelb' },
  { value: '#70d99a', label: 'Grün' },
  { value: '#ff88bd', label: 'Rosa' },
]
export function ShapeToolbar({
  workspaceRef,
  shape,
  pageSize,
  store,
  onSelect,
  onStyle,
}: {
  workspaceRef: RefObject<HTMLDivElement | null>
  shape: ShapeOverlay
  pageSize: Bounds
  store: EditorStore
  onSelect: (id: string | null) => void
  onStyle: (shape: ShapeOverlay) => void
}) {
  const commit = (next: ShapeChanges) => {
    const before = shapeGeometry(shape)
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      store.dispatch(updateShape(shape.id, before, next))
      onStyle({ ...shape, ...next })
    }
  }
  const marker = shape.shape === 'marker',
    closed = shape.shape === 'rect' || shape.shape === 'ellipse'
  const barRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number; from: typeof HOME } | null>(null)
  const [position, setPosition] = useState(HOME)

  const bounded = (next: typeof HOME): typeof HOME => {
    const workspace = workspaceRef.current
    const bar = barRef.current
    if (!workspace || !bar) return next
    return {
      x: Math.max(8, Math.min(next.x, Math.max(8, workspace.clientWidth - bar.offsetWidth - 8))),
      y: Math.max(8, Math.min(next.y, Math.max(8, workspace.clientHeight - bar.offsetHeight - 8))),
    }
  }

  // A smaller viewport or differently sized options must not strand the grip.
  useEffect(() => {
    const workspace = workspaceRef.current
    const bar = barRef.current
    if (!workspace || !bar) return
    const observer = new ResizeObserver(() => {
      if (bar.hidden) return
      setPosition((current) => {
        const next = {
          x: Math.max(8, Math.min(current.x, Math.max(8, workspace.clientWidth - bar.offsetWidth - 8))),
          y: Math.max(8, Math.min(current.y, Math.max(8, workspace.clientHeight - bar.offsetHeight - 8))),
        }
        return next.x === current.x && next.y === current.y ? current : next
      })
    })
    observer.observe(workspace)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [workspaceRef])

  const stopDrag = (event: React.PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (cancelled) setPosition(bounded(drag.from))
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div
      ref={barRef}
      className="drawing-toolbar shape-toolbar"
      role="group"
      aria-label="Formoptionen"
      style={{ left: position.x, top: position.y }}
    >
      <button
        type="button"
        className="drawing-grip"
        aria-label="Formleiste verschieben"
        title="Ziehen zum Verschieben · Pfeiltasten bewegen · Pos1 setzt zurück"
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return
          event.currentTarget.focus()
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, from: position }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          setPosition(
            bounded({ x: drag.from.x + event.clientX - drag.x, y: drag.from.y + event.clientY - drag.y }),
          )
        }}
        onPointerUp={(event) => stopDrag(event)}
        onPointerCancel={(event) => stopDrag(event, true)}
        onLostPointerCapture={(event) => stopDrag(event, true)}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          const step = event.shiftKey ? 40 : 10
          setPosition(
            bounded(
              event.key === 'Home'
                ? HOME
                : {
                    x:
                      position.x +
                      (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
                    y: position.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
                  },
            ),
          )
        }}
      >
        <svg width="18" height="22" viewBox="0 0 18 22" fill="currentColor" aria-hidden="true">
          {[5, 11, 17].flatMap((y) => [5, 13].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.7" />))}
        </svg>
        Leiste ziehen
      </button>
      <div
        className="shape-options"
        onKeyDown={(event) => {
          if (event.key.startsWith('Arrow')) event.stopPropagation()
        }}
      >
        <div className="shape-heading">
          <b>{marker ? 'Textmarker bearbeiten' : 'Form bearbeiten'}</b>
          <span>{SHAPE_TOOLS.find((o) => o.tool === shape.shape)?.label}</span>
        </div>
        {closed && (
          <ColorRow
            label="Füllung"
            options={FILL}
            value={shape.fill}
            onChange={(fill) => commit({ ...shapeGeometry(shape), fill })}
          />
        )}
        <ColorRow
          label={marker ? 'Farbe' : 'Kontur'}
          options={marker ? MARKER : STROKE}
          value={shape.strokeColor}
          onChange={(strokeColor) => commit({ ...shapeGeometry(shape), strokeColor })}
        />
        <div className="shape-row" role="group" aria-label={marker ? 'Textmarkerbreite' : 'Konturstärke'}>
          <span>{marker ? 'Breite' : 'Stärke'}</span>
          {(marker ? [12, 24, 36] : [1, 3, 6]).map((width, index) => (
            <button
              key={width}
              type="button"
              aria-pressed={shape.strokeWidth === width}
              aria-label={`${width} pt ${marker ? 'Textmarkerbreite' : 'Konturstärke'}`}
              title={`${['Dünn', 'Mittel', 'Dick'][index]} · ${width} pt`}
              onClick={() => commit({ ...shapeGeometry(shape), strokeWidth: width })}
            >
              <svg width="28" height="20" viewBox="0 0 28 20" aria-hidden="true">
                <path
                  d="M 4 10 H 24"
                  stroke={shape.strokeWidth === width ? 'var(--accent)' : 'currentColor'}
                  strokeWidth={marker ? width / 3 : width}
                  strokeLinecap="round"
                />
              </svg>
            </button>
          ))}
        </div>
        <div className="shape-row shape-angle">
          <span>Winkel</span>
          <AngleInput
            value={shape.rotation}
            onCommit={(angle) => commit(rotateShape(shapeGeometry(shape), angle, pageSize))}
          />
          <button
            type="button"
            aria-label="Form 90° gegen den Uhrzeigersinn drehen"
            title="90° gegen den Uhrzeigersinn drehen"
            onClick={() => commit(rotateShape(shapeGeometry(shape), shape.rotation - 90, pageSize))}
          >
            <RotationIcon />
          </button>
          <button
            type="button"
            aria-label="Form 90° im Uhrzeigersinn drehen"
            title="90° im Uhrzeigersinn drehen"
            onClick={() => commit(rotateShape(shapeGeometry(shape), shape.rotation + 90, pageSize))}
          >
            <RotationIcon clockwise />
          </button>
        </div>
        <div className="shape-actions">
          <button
            type="button"
            onClick={() => {
              store.dispatch(removeShape(shape))
              onSelect(null)
            }}
          >
            Element löschen
          </button>
          <button
            type="button"
            aria-label="Formleiste zurücksetzen"
            title="Position zurücksetzen"
            onClick={() => setPosition(bounded(HOME))}
          >
            <RotationIcon />
          </button>
        </div>
      </div>
    </div>
  )
}
function ColorRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: string | null; label: string }[]
  value: string | null
  onChange: (value: string | null) => void
}) {
  return (
    <div className="shape-row" role="group" aria-label={label}>
      <span>{label}</span>
      {options.map((option) => (
        <button
          key={option.value ?? 'none'}
          type="button"
          aria-label={`${label}: ${option.label}`}
          title={option.label}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          <span
            className={`shape-color${option.value === null ? ' no-color' : option.value === '#ffffff' ? ' light-color' : ''}`}
            style={option.value ? { background: option.value } : undefined}
          >
            {value === option.value && option.value !== null ? '✓' : ''}
          </span>
        </button>
      ))}
    </div>
  )
}
function AngleInput({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const cancelled = useRef(false)
  const [editing, setEditing] = useState(false),
    [text, setText] = useState('')
  const finish = () => {
    if (cancelled.current) {
      cancelled.current = false
      setEditing(false)
      return
    }
    const angle = Number(text.replace(',', '.'))
    setEditing(false)
    if (text.trim() && Number.isFinite(angle)) onCommit(angle)
  }
  return (
    <label className="shape-angle-input">
      <input
        aria-label="Formwinkel in Grad"
        type="text"
        inputMode="decimal"
        value={editing ? text : value.toFixed(1)}
        onFocus={() => {
          setText(value.toFixed(1))
          setEditing(true)
        }}
        onChange={(event) => setText(event.target.value)}
        onBlur={finish}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === 'Escape') {
            event.stopPropagation()
            cancelled.current = true
            setText(value.toFixed(1))
            setEditing(false)
            event.currentTarget.blur()
          }
        }}
      />
      <span>°</span>
    </label>
  )
}
