import { useEffect, useRef, useState } from 'react'

export interface DocumentMenuItem { label: string; onSelect: () => void }

/** Toolbar menu for document-wide functions (variant A of the T17 to T26 sheet). */
export function DocumentMenu({ items, disabled }: { items: DocumentMenuItem[]; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div
      className="document-menu"
      ref={wrapRef}
      onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false) } }}
    >
      <button type="button" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)}>
        Dokument
        <span className="toolbar-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="document-menu-popover" role="menu">
          {items.map(item => (
            <button key={item.label} type="button" role="menuitem" onClick={() => { setOpen(false); item.onSelect() }}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
