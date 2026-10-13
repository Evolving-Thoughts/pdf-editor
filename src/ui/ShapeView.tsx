import { useRef, useState } from 'react'
import { nudgeShape, updateShape, type ShapeKeyboardAction } from '../core/commands'
import type { EditorStore } from '../core/editorStore'
import type { Bounds, Corner } from '../core/images/geometry'
import {
  MARKER_OPACITY,
  shapeGeometry,
  moveShape,
  resizeShape,
  rotateShape,
  setShapeEndpoint,
  shapeWorldPoints,
  shapeToSvgPath,
  type ShapeChanges,
} from '../core/shapes'
import { strokeToSvgPath } from '../core/drawing'
import { RotationIcon } from './ImageView'
import type { ShapeOverlay } from '../core/model'
import type { Tool } from './tools'

interface Props {
  shape: ShapeOverlay
  zoom: number
  pageSize: Bounds
  selected: boolean
  tool: Tool
  store: EditorStore
  onSelect: (id: string | null) => void
}
interface Gesture {
  pointerId: number
  x: number
  y: number
  zoom: number
  version: number
  before: ShapeChanges
  endpoint?: 'start' | 'end'
  corner?: Corner
  rotating: boolean
  centerX: number
  centerY: number
  startAngle: number
}
const cornerNames: Record<Corner, string> = {
  nw: 'oben links',
  ne: 'oben rechts',
  sw: 'unten links',
  se: 'unten rechts',
}

export function ShapeView({ shape, zoom, pageSize, selected, tool, store, onSelect }: Props) {
  const anchor = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [preview, setPreview] = useState<{ geometry: ShapeChanges; zoom: number; version: number } | null>(
    null,
  )
  const active = selected && tool === 'select'
  const validGesture = preview && preview.zoom === zoom && preview.version === store.getVersion() && active
  const geometry = validGesture && preview ? preview.geometry : shapeGeometry(shape)
  const commit = (next: ShapeChanges, keyboardAction?: ShapeKeyboardAction) => {
    const before = shapeGeometry(shape)
    if (JSON.stringify(before) !== JSON.stringify(next))
      store.dispatch(
        keyboardAction
          ? nudgeShape(shape.id, before, next, keyboardAction)
          : updateShape(shape.id, before, next),
      )
  }
  const cancel = () => {
    gesture.current = null
    setPreview(null)
  }
  const onShapePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const corner = event.currentTarget.dataset.corner as Corner | undefined
    const endpoint = event.currentTarget.dataset.endpoint as 'start' | 'end' | undefined
    const rotating = event.currentTarget.dataset.rotate === 'true'
    if (tool !== 'select' || !event.isPrimary || event.button !== 0 || gesture.current) return
    event.stopPropagation()
    event.preventDefault()
    onSelect(shape.id)
    ;(corner || endpoint || rotating ? event.currentTarget : anchor.current)?.focus({ preventScroll: true })
    const rect = anchor.current!.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      zoom,
      version: store.getVersion(),
      before: shapeGeometry(shape),
      corner,
      endpoint,
      rotating,
      centerX,
      centerY,
      startAngle: (Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180) / Math.PI,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const nextGeometry = (event: React.PointerEvent, current: Gesture) => {
    if (current.rotating) {
      const pointerAngle =
        (Math.atan2(event.clientY - current.centerY, event.clientX - current.centerX) * 180) / Math.PI
      return rotateShape(
        current.before,
        (current.before.rotation ?? 0) + pointerAngle - current.startAngle,
        pageSize,
        event.shiftKey,
      )
    }
    const dx = (event.clientX - current.x) / current.zoom
    const dy = (current.y - event.clientY) / current.zoom
    if (current.endpoint) {
      const initial = shapeWorldPoints(shape)[current.endpoint === 'start' ? 0 : 1]
      return setShapeEndpoint(shape, current.endpoint, { x: initial.x + dx, y: initial.y + dy }, pageSize)
    }
    return current.corner
      ? resizeShape(current.before, current.corner, dx, dy, pageSize)
      : moveShape(current.before, dx, dy, pageSize)
  }
  const move = (event: React.PointerEvent) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    event.stopPropagation()
    if (current.zoom !== zoom || current.version !== store.getVersion() || !active) {
      cancel()
      return
    }
    setPreview({ geometry: nextGeometry(event, current), zoom: current.zoom, version: current.version })
  }
  const finish = (event: React.PointerEvent) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    event.stopPropagation()
    const valid = current.zoom === zoom && current.version === store.getVersion() && active
    const next = nextGeometry(event, current)
    cancel()
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    if (valid) commit(next)
  }
  const display = { ...shape, ...geometry }
  const line = shape.shape === 'line' || shape.shape === 'arrow'
  return (
    <>
      {shape.shape === 'marker' && (
        <svg
          className="stroke-layer"
          viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}
          aria-hidden="true"
          style={{ mixBlendMode: 'multiply' }}
        >
          <path
            d={strokeToSvgPath(shapeWorldPoints(display), pageSize.height)}
            fill="none"
            stroke={shape.strokeColor ?? 'none'}
            strokeWidth={shape.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={MARKER_OPACITY}
          />
        </svg>
      )}
      <div
        ref={anchor}
        className={`shape-overlay${active ? ' selected' : ''}`}
        tabIndex={tool === 'select' ? 0 : -1}
        role="group"
        aria-label={`Form: ${shape.shape}`}
        data-shape-id={shape.id}
        style={{
          left: geometry.x * zoom,
          top: (pageSize.height - geometry.y - geometry.height) * zoom,
          width: geometry.width * zoom,
          height: geometry.height * zoom,
          transform: `rotate(${geometry.rotation ?? 0}deg)`,
        }}
        onFocus={() => {
          if (tool === 'select') onSelect(shape.id)
        }}
        onPointerDown={onShapePointerDown}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
      >
        {shape.shape !== 'marker' && (
          <svg
            className="shape-vector"
            width={Math.max(1, geometry.width * zoom)}
            height={Math.max(1, geometry.height * zoom)}
            overflow="visible"
            aria-hidden="true"
          >
            <g transform={`scale(${zoom})`}>
              <path
                d={shapeToSvgPath(display)}
                fill={shape.fill ?? 'none'}
                stroke={shape.strokeColor ?? 'none'}
                strokeWidth={shape.strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {line && (
                <path
                  className="shape-hit"
                  d={shapeToSvgPath(display)}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={Math.max(16, shape.strokeWidth)}
                />
              )}
            </g>
          </svg>
        )}
        {active &&
          line &&
          (['start', 'end'] as const).map((end) => {
            const first = end === 'start'
            const right = first ? geometry.flipX : !geometry.flipX
            const top = first ? geometry.flipY : !geometry.flipY
            return (
              <button
                key={end}
                type="button"
                className="image-handle shape-endpoint"
                data-endpoint={end}
                style={{
                  left: (right ? geometry.width * zoom : 0) - 22,
                  top: (top ? 0 : geometry.height * zoom) - 22,
                }}
                aria-label={`Form-Endpunkt: ${first ? 'Anfang' : 'Ende'}`}
                onPointerDown={onShapePointerDown}
                onKeyDown={(event) => {
                  if (!event.key.startsWith('Arrow')) return
                  event.preventDefault()
                  event.stopPropagation()
                  const step = event.shiftKey ? 10 : 1,
                    point = shapeWorldPoints(shape)[first ? 0 : 1]
                  commit(
                    setShapeEndpoint(
                      shape,
                      end,
                      {
                        x:
                          point.x +
                          (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
                        y: point.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0),
                      },
                      pageSize,
                    ),
                    `endpoint:${end}`,
                  )
                }}
              >
                <span />
              </button>
            )
          })}
        {active &&
          !line &&
          (Object.keys(cornerNames) as Corner[]).map((corner) => (
            <button
              key={corner}
              className={`image-handle ${corner}`}
              type="button"
              aria-label={`Form skalieren: ${cornerNames[corner]}`}
              title="Ziehen zum Skalieren · Pfeiltasten für Feinschritte"
              data-corner={corner}
              onPointerDown={onShapePointerDown}
              onKeyDown={(event) => {
                if (!event.key.startsWith('Arrow')) return
                event.preventDefault()
                event.stopPropagation()
                const step = event.shiftKey ? 10 : 1
                commit(
                  resizeShape(
                    shapeGeometry(shape),
                    corner,
                    event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
                    event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0,
                    pageSize,
                  ),
                  `resize:${corner}`,
                )
              }}
            >
              <span />
            </button>
          ))}
        {active && (
          <button
            type="button"
            className="image-rotate-handle"
            data-rotate="true"
            aria-label="Form frei drehen"
            title="Ziehen zum Drehen · Shift: 15°-Schritte · Pfeiltasten: 1°"
            onPointerDown={onShapePointerDown}
            onKeyDown={(event) => {
              if (!event.key.startsWith('Arrow')) return
              event.preventDefault()
              event.stopPropagation()
              const direction = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1
              commit(
                rotateShape(
                  shapeGeometry(shape),
                  (shape.rotation ?? 0) + direction * (event.shiftKey ? 15 : 1),
                  pageSize,
                ),
                'rotate',
              )
            }}
          >
            <span>
              <RotationIcon clockwise />
            </span>
          </button>
        )}
      </div>
    </>
  )
}
