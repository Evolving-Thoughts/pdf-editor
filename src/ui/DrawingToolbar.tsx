import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Tool } from './tools'

interface DrawingToolbarProps {
  workspaceRef: RefObject<HTMLDivElement | null>
  tool: Tool
  color: string
  width: number
  eraserRadius: number
  onColor: (color: string) => void
  onWidth: (width: number) => void
  onEraserRadius: (radius: number) => void
}

const COLORS = [
  { value: '#111111', label: 'Schwarz' },
  { value: '#2455c7', label: 'Blau' },
  { value: '#c72b32', label: 'Rot' },
]
const HOME = { x: 16, y: 16 }

/** Context options stay outside the scrolling PDF surface; only the grip moves them. */
export function DrawingToolbar({
  workspaceRef, tool, color, width, eraserRadius, onColor, onWidth, onEraserRadius,
}: DrawingToolbarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number; from: typeof HOME } | null>(null)
  const [position, setPosition] = useState(HOME)
  const active = tool === 'pen' || tool === 'eraser'

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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div ref={barRef} className="drawing-toolbar" role="group" aria-label="Zeichenoptionen"
      hidden={!active} style={{ left: position.x, top: position.y }}>
      <button type="button" className="drawing-grip" aria-label="Kontextleiste verschieben"
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
          setPosition(bounded({ x: drag.from.x + event.clientX - drag.x, y: drag.from.y + event.clientY - drag.y }))
        }}
        onPointerUp={(event) => stopDrag(event)}
        onPointerCancel={(event) => stopDrag(event, true)}
        onLostPointerCapture={(event) => stopDrag(event, true)}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          const step = event.shiftKey ? 40 : 10
          setPosition(bounded(event.key === 'Home' ? HOME : {
            x: position.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
            y: position.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
          }))
        }}>
        <svg width="18" height="22" viewBox="0 0 18 22" fill="currentColor" aria-hidden="true">
          {[5, 11, 17].flatMap((y) => [5, 13].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.7" />))}
        </svg>
        Leiste ziehen
      </button>
      <div className="drawing-options">
        <span className="drawing-label">{tool === 'pen' ? 'Stift:' : 'Radierer'}</span>
        {tool === 'pen' && (
          <div className="drawing-colors" role="group" aria-label="Stiftfarbe">
            {COLORS.map((option) => (
              <button key={option.value} type="button" aria-label={option.label} title={option.label}
                aria-pressed={color === option.value} onClick={() => onColor(option.value)}>
                <span className="color-dot" style={{ background: option.value }}>
                  {color === option.value ? '✓' : ''}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="drawing-line-controls">
          {tool === 'pen' ? (
            <div className="drawing-widths" role="group" aria-label="Strichstärke">
              {[1, 3, 6].map((value, index) => (
                <button key={value} type="button" aria-label={`${value} pt Strichstärke`}
                  title={`${['Dünn', 'Mittel', 'Dick'][index]} · ${value} pt`}
                  aria-pressed={width === value} onClick={() => onWidth(value)}>
                  <svg width="30" height="18" viewBox="0 0 30 18" fill="none" aria-hidden="true">
                    <path d={`M 4 ${value % 2 ? 9.5 : 9} H 26`}
                      stroke={width === value ? 'var(--accent)' : 'currentColor'}
                      strokeWidth={value} strokeLinecap="round" />
                  </svg>
                </button>
              ))}
            </div>
          ) : (
            <div className="drawing-eraser-sizes" role="group" aria-label="Radierergröße">
              {[8, 16, 24].map((radius, index) => (
                <button key={radius} type="button" aria-label={`${radius * 2} pt Radierergröße`}
                  title={`${['Klein', 'Mittel', 'Groß'][index]} · ${radius * 2} pt Durchmesser`}
                  aria-pressed={eraserRadius === radius} onClick={() => onEraserRadius(radius)}>
                  <svg width="32" height="32" viewBox="0 0 54 54" fill="none" aria-hidden="true">
                    <circle cx="27" cy="27" r={radius} strokeWidth="2.4"
                      stroke={eraserRadius === radius ? 'var(--accent)' : 'currentColor'} />
                  </svg>
                </button>
              ))}
            </div>
          )}
          <button type="button" aria-label="Position zurücksetzen" title="Position zurücksetzen"
            onClick={() => setPosition(bounded(HOME))}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M 4 10 A 8 8 0 1 1 5 17 M 4 4 V 10 H 10" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}