import type { RefObject } from 'react'
import { SymbolPicker } from './SymbolPicker'
import { StampPicker, type ChosenStamp } from './StampPicker'
import { SHAPE_TOOLS, type Tool } from './tools'

/** The second toolbar row: tools for adding to the page. */
export function ToolbarTools({ tool, symbol, imageInputRef, onTool, onClearSelection, onSymbol, onStamp }: {
  tool: Tool
  symbol: string
  imageInputRef: RefObject<HTMLInputElement | null>
  onTool: (tool: Tool) => void
  onClearSelection: () => void
  onSymbol: (symbol: string) => void
  onStamp: (stamp: ChosenStamp) => void
}) {
  const shapeToolButton = (option: (typeof SHAPE_TOOLS)[number]) => (
    <button
      key={option.tool}
      type="button"
      className="tool"
      aria-label={option.label}
      aria-pressed={tool === option.tool}
      onClick={() => {
        onClearSelection()
        onTool(option.tool)
      }}
    >
      <svg
        className="tool-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <path d={option.path} />
      </svg>
      {option.label}
    </button>
  )

  return (
    <div
      className="toolbar-tools"
      role="group"
      aria-label="Bearbeitungswerkzeuge"
    >
      <div
        className="toolbar-tool-group"
        role="group"
        aria-label="Einfügen und Auswählen"
      >
        <span className="toolbar-group-label" aria-hidden="true">
          Einfügen und Auswählen
        </span>
        <div className="toolbar-group-actions">
          <button
            type="button"
            className="tool"
            aria-pressed={tool === 'select'}
            title="Auswahl-Werkzeug (Esc)"
            onClick={() => onTool('select')}
          >
            ⬚ Auswahl
          </button>
          <button
            type="button"
            className="tool"
            aria-pressed={tool === 'text'}
            title="Text-Werkzeug"
            onClick={() => onTool('text')}
          >
            T Text
          </button>
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            aria-label="Bild einfügen"
            title="PNG- oder JPG-Bild einfügen · auch per Drag & Drop"
          >
            + Bild<span className="compact-hide"> einfügen</span>
          </button>
          <SymbolPicker
            value={symbol}
            active={tool === 'symbol'}
            onPick={(nextSymbol) => {
              onSymbol(nextSymbol)
              onTool('symbol')
            }}
          />
          <StampPicker
            active={tool === 'stamp'}
            onPick={(chosen) => {
              onClearSelection()
              onStamp(chosen)
              onTool('stamp')
            }}
          />
        </div>
      </div>
      <div
        className="toolbar-tool-group"
        role="group"
        aria-label="Zeichnen"
      >
        <span className="toolbar-group-label" aria-hidden="true">
          Zeichnen
        </span>
        <div className="toolbar-group-actions">
          <button
            type="button"
            className="tool"
            aria-label="Stift"
            aria-pressed={tool === 'pen'}
            onClick={() => {
              onClearSelection()
              onTool('pen')
            }}
          >
            <svg
              className="tool-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m 4 16 12 -12 4 4 -12 12 -5 1 1 -5 M 13 7 l 4 4" />
            </svg>
            Stift
          </button>
          <button
            type="button"
            className="tool"
            aria-label="Radierer"
            aria-pressed={tool === 'eraser'}
            onClick={() => {
              onClearSelection()
              onTool('eraser')
            }}
          >
            <svg
              className="tool-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m 4 14 10 -10 7 7 -10 10 H 7 l -3 -3 Z M 9 9 l 7 7 M 11 21 h 10" />
            </svg>
            Radierer
          </button>
          {SHAPE_TOOLS.filter((option) => option.tool === 'marker').map(
            shapeToolButton,
          )}
        </div>
      </div>
      <div
        className="toolbar-tool-group toolbar-form-group"
        role="group"
        aria-label="Formen"
      >
        <span className="toolbar-group-label" aria-hidden="true">
          Formen
        </span>
        <div className="toolbar-group-actions">
          {SHAPE_TOOLS.filter((option) => option.tool !== 'marker').map(
            shapeToolButton,
          )}
        </div>
      </div>
      <div
        className="toolbar-tool-group toolbar-confidential-group"
        role="group"
        aria-label="Vertraulich"
      >
        <span className="toolbar-group-label" aria-hidden="true">
          Vertraulich
        </span>
        <div className="toolbar-group-actions">
          <button
            type="button"
            className="tool"
            aria-pressed={tool === 'redact'}
            onClick={() => {
              onClearSelection()
              onTool('redact')
            }}
          >
            Schwärzen
          </button>
        </div>
      </div>
    </div>
  )
}
