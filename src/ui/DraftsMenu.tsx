import { useEffect, useRef, useState } from 'react'
import type { DraftSummary } from '../core/persistence/drafts'

interface DraftsMenuProps {
  drafts: DraftSummary[]
  activeDraftId: string | null
  loadingDraftId: string | null
  error: string | null
  onMenuOpen: () => void
  onOpenDraft: (id: string) => void
  onDeleteDraft: (id: string) => void
  onNewPdf: () => void
}

const dateFormatter = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatDraftMeta(draft: DraftSummary): string {
  const changes = draft.overlayCount === 1 ? '1 Änderung' : `${draft.overlayCount} Änderungen`
  return `${dateFormatter.format(new Date(draft.updatedAt))} · ${formatSize(draft.sizeBytes)} · ${changes}`
}

/** Toolbar menu for reopening and deleting locally stored drafts. */
export function DraftsMenu({
  drafts,
  activeDraftId,
  loadingDraftId,
  error,
  onMenuOpen,
  onOpenDraft,
  onDeleteDraft,
  onNewPdf,
}: DraftsMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const toggle = () => {
    const nextOpen = !open
    setOpen(nextOpen)
    if (nextOpen) onMenuOpen()
  }

  return (
    <div className="drafts-menu-wrap" ref={wrapRef}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        Entwürfe&nbsp;▾
      </button>
      {open && (
        <div className="drafts-menu" role="menu" aria-label="Gespeicherte Entwürfe">
          {error && (
            <p className="draft-menu-message" role="status">
              {error}
            </p>
          )}
          {!error && drafts.length === 0 && <p className="draft-menu-message">Keine Entwürfe vorhanden.</p>}
          {!error &&
            drafts.map((draft) => {
              const active = draft.id === activeDraftId
              const loading = draft.id === loadingDraftId
              return (
                <div
                  key={draft.id}
                  className={`draft-row${active ? ' active' : ''}`}
                  role="menuitemradio"
                  aria-checked={active}
                  tabIndex={0}
                  onClick={() => {
                    setOpen(false)
                    if (!active) onOpenDraft(draft.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    setOpen(false)
                    if (!active) onOpenDraft(draft.id)
                  }}
                >
                  <span className="draft-row-text">
                    <span className="draft-name">
                      {draft.name}
                      {active && <span className="draft-badge">Aktiv</span>}
                      {loading && <span className="draft-badge">Öffnet…</span>}
                    </span>
                    <span className="draft-meta">{formatDraftMeta(draft)}</span>
                  </span>
                  <button
                    type="button"
                    className="draft-delete"
                    title="Entwurf löschen"
                    aria-label={`Entwurf „${draft.name}“ löschen`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onDeleteDraft(draft.id)
                    }}
                  >
                    🗑
                  </button>
                </div>
              )
            })}
          <button
            type="button"
            className="draft-row draft-menu-footer"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onNewPdf()
            }}
          >
            ＋ Neue PDF öffnen…
          </button>
        </div>
      )}
    </div>
  )
}