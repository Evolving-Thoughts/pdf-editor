import { useEffect, useRef, useState } from 'react'

// Verified against pdf-lib's ZapfDingbats encoding (scripts: dingbats check).
const SYMBOLS = [
  '✓',
  '✔',
  '✕',
  '✖',
  '✗',
  '✘',
  '■',
  '❑',
  '●',
  '◆',
  '★',
  '✦',
  '➔',
  '✎',
  '✉',
  '☎',
]

interface SymbolPickerProps {
  value: string
  active: boolean
  onPick: (symbol: string) => void
}

/** Toolbar picker: choosing a symbol arms the symbol placement tool. */
export function SymbolPicker({ value, active, onPick }: SymbolPickerProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <span className="symbol-picker" ref={wrapRef}>
      <button
        type="button"
        className="tool"
        aria-label="Symbol auswählen"
        aria-expanded={open}
        aria-pressed={active}
        title="Symbol auswählen und per Klick platzieren"
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        <span aria-hidden="true">{value}</span> Symbol
        <span className="toolbar-chevron" aria-hidden="true" />
      </button>
      {open && (
        <span className="symbol-popover">
          {SYMBOLS.map((symbol) => (
            <button
              key={symbol}
              type="button"
              aria-label={`Symbol ${symbol}`}
              onPointerDown={(event) => {
                event.preventDefault()
                setOpen(false)
                onPick(symbol)
              }}
            >
              {symbol}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
