import type { RefObject } from 'react'
import { BarGrip } from './BarGrip'
import { useMovableBar } from './useMovableBar'
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

/** Context options stay outside the scrolling PDF surface; only the grip moves them. */
export function DrawingToolbar({
  workspaceRef, tool, color, width, eraserRadius, onColor, onWidth, onEraserRadius,
}: DrawingToolbarProps) {
  const { barRef, position, grip, reset } = useMovableBar(workspaceRef)
  const active = tool === 'pen' || tool === 'eraser'

  return (
    <div ref={barRef} className="drawing-toolbar" role="group" aria-label="Zeichenoptionen"
      hidden={!active} style={{ left: position.x, top: position.y }}>
      <BarGrip label="Kontextleiste verschieben" handlers={grip} />
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
            onClick={reset}>
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