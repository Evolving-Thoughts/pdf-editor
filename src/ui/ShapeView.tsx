import { useRef } from 'react'
import { nudgeOverlay, updateOverlay, type ShapeKeyboardAction } from '../core/commands'
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
import { arrowStep, arrowTurn, pointerAngle, type GestureStep } from '../core/overlayGesture'
import type { Tool } from './tools'
import { useOverlayGesture } from './useOverlayGesture'

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
  before: ShapeChanges
  endpoint?: 'start' | 'end'
  corner?: Corner
  rotating: boolean
  center: { x: number; y: number }
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
  const active = selected && (tool === 'select' || tool === shape.shape)
  const commit = (next: ShapeChanges, keyboardAction?: ShapeKeyboardAction) => {
    const before = shapeGeometry(shape)
    if (JSON.stringify(before) !== JSON.stringify(next))
      store.dispatch(
        keyboardAction
          ? nudgeOverlay(shape.id, before, next, keyboardAction)
          : updateOverlay(shape.id, before, next),
      )
  }
  const nextGeometry = ({ data, dx, dy, sample }: GestureStep<Gesture>) => {
    if (data.rotating)
      return rotateShape(
        data.before,
        (data.before.rotation ?? 0) + pointerAngle(data.center, sample) - data.startAngle,
        pageSize,
        sample.shiftKey,
      )
    if (data.endpoint) {
      const initial = shapeWorldPoints(shape)[data.endpoint === 'start' ? 0 : 1]
      return setShapeEndpoint(shape, data.endpoint, { x: initial.x + dx, y: initial.y + dy }, pageSize)
    }
    return data.corner
      ? resizeShape(data.before, data.corner, dx, dy, pageSize)
      : moveShape(data.before, dx, dy, pageSize)
  }
  const gesture = useOverlayGesture<Gesture, ShapeChanges>(
    () => ({ zoom, version: store.getVersion(), tool, active }),
    nextGeometry,
    (next) => commit(next),
  )
  const geometry = gesture.shown ?? shapeGeometry(shape)
  const onShapePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const corner = event.currentTarget.dataset.corner as Corner | undefined
    const endpoint = event.currentTarget.dataset.endpoint as 'start' | 'end' | undefined
    const rotating = event.currentTarget.dataset.rotate === 'true'
    // Creation stays active on the page; only explicit grips edit the selected source.
    if (tool !== 'select' && !(active && (corner || endpoint || rotating))) return
    const rect = anchor.current!.getBoundingClientRect()
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    if (!gesture.begin(event, { before: shapeGeometry(shape), corner, endpoint, rotating, center, startAngle: pointerAngle(center, event) })) return
    onSelect(shape.id)
    ;(corner || endpoint || rotating ? event.currentTarget : anchor.current)?.focus({ preventScroll: true })
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
        {...gesture.pointer}
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
                  const step = arrowStep(event)
                  if (!step) return
                  event.preventDefault()
                  event.stopPropagation()
                  const point = shapeWorldPoints(shape)[first ? 0 : 1]
                  commit(setShapeEndpoint(shape, end, { x: point.x + step.dx, y: point.y + step.dy }, pageSize), `endpoint:${end}`)
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
                const step = arrowStep(event)
                if (!step) return
                event.preventDefault()
                event.stopPropagation()
                commit(resizeShape(shapeGeometry(shape), corner, step.dx, step.dy, pageSize), `resize:${corner}`)
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
              const turn = arrowTurn(event)
              if (turn === null) return
              event.preventDefault()
              event.stopPropagation()
              commit(rotateShape(shapeGeometry(shape), (shape.rotation ?? 0) + turn, pageSize), 'rotate')
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
