import { useRef, useState, type RefObject } from 'react'
import { removeOverlay, updateOverlay } from '../core/commands'
import type { EditorStore } from '../core/editorStore'
import type { ShapeOverlay } from '../core/model'
import { shapeGeometry, rotateShape, type ShapeChanges } from '../core/shapes'
import type { Bounds } from '../core/images/geometry'
import { RotationIcon } from './ImageView'
import { BarGrip } from './BarGrip'
import { useMovableBar } from './useMovableBar'
import { SHAPE_TOOLS } from './tools'
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
      store.dispatch(updateOverlay(shape.id, before, next))
      onStyle({ ...shape, ...next })
    }
  }
  const marker = shape.shape === 'marker',
    closed = shape.shape === 'rect' || shape.shape === 'ellipse'
  const { barRef, position, grip, reset } = useMovableBar(workspaceRef)

  return (
    <div
      ref={barRef}
      className="drawing-toolbar shape-toolbar"
      role="group"
      aria-label="Formoptionen"
      style={{ left: position.x, top: position.y }}
    >
      <BarGrip label="Formleiste verschieben" handlers={grip} />
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
              store.dispatch(removeOverlay(shape))
              onSelect(null)
            }}
          >
            Element löschen
          </button>
          <button
            type="button"
            aria-label="Formleiste zurücksetzen"
            title="Position zurücksetzen"
            onClick={reset}
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
