import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { nudgeTextbox, removeTextbox } from '../core/commands'
import { EditorStore } from '../core/editorStore'
import { loadPdf, type PdfHandle } from '../core/pdf/loadPdf'
import { zoomIn, zoomOut } from '../core/viewerState'
import { PageView } from './PageView'
import type { Tool } from './tools'
import './app.css'

export default function App() {
  const [pdf, setPdf] = useState<PdfHandle | null>(null)
  const [zoom, setZoom] = useState(1)
  const [tool, setTool] = useState<Tool>('select')
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Current handle in a ref so destroy() runs outside React state updaters
  // (updaters must stay pure; StrictMode double-invokes them in dev).
  const pdfRef = useRef<PdfHandle | null>(null)

  // Editor state lives in the framework-free store (ADR-002/ADR-004);
  // React re-renders on store notifications.
  const [store] = useState(() => new EditorStore())
  useSyncExternalStore(store.subscribe, store.getVersion)
  const overlays = store.state.overlays

  const onOpenFile = useCallback(
    async (file: File) => {
      setError(null)
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const next = await loadPdf(file.name, bytes)
        void pdfRef.current?.destroy()
        pdfRef.current = next
        store.reset()
        setSelectedId(null)
        setPdf(next)
      } catch {
        setError(`„${file.name}“ konnte nicht geöffnet werden (beschädigt oder passwortgeschützt?).`)
      }
    },
    [store],
  )

  // Release the worker document when the app unmounts.
  useEffect(() => () => void pdfRef.current?.destroy(), [])

  // Global shortcuts. While a textarea is focused, it keeps its own editing
  // keys (Escape blurs there, see TextboxView).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('textarea, input, select, [contenteditable]')) return
      if (event.key === 'Escape') {
        setSelectedId(null)
        setTool('select')
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        const box = store.state.overlays.find((o) => o.id === selectedId)
        if (box) {
          store.dispatch(removeTextbox(box))
          setSelectedId(null)
        }
        return
      }
      if (selectedId && event.key.startsWith('Arrow')) {
        const box = store.state.overlays.find((o) => o.id === selectedId)
        if (!box) return
        event.preventDefault()
        const step = event.shiftKey ? 10 : 1
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
        const dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
        store.dispatch(
          nudgeTextbox(box.id, { x: box.x, y: box.y }, { x: Math.max(0, box.x + dx), y: Math.max(0, box.y + dy) }),
        )
        return
      }
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 'z' && event.shiftKey) {
        event.preventDefault()
        store.redo()
      } else if (key === 'z') {
        event.preventDefault()
        store.undo()
      } else if (key === 'y') {
        event.preventDefault()
        store.redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [store, selectedId])

  const onExport = useCallback(async () => {
    if (!pdf) return
    const bytes = await pdf.exportBytes(store.state.overlays)
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }))
    const link = document.createElement('a')
    link.href = url
    link.download = pdf.fileName
    link.click()
    // Defer revocation: Firefox/Safari may abort the download if the URL
    // is revoked in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [pdf, store])

  return (
    <div className="app">
      <header className="toolbar">
        <label className="button">
          PDF öffnen
          <input
            type="file"
            accept="application/pdf"
            className="visually-hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void onOpenFile(file)
            }}
          />
        </label>
        {pdf && (
          <>
            <span className="file-info">
              {pdf.fileName} · {pdf.pageCount} {pdf.pageCount === 1 ? 'Seite' : 'Seiten'}
            </span>
            <button type="button" onClick={() => setZoom((z) => zoomOut(z))}>
              −
            </button>
            <span className="zoom-label">{Math.round(zoom * 100)} %</span>
            <button type="button" onClick={() => setZoom((z) => zoomIn(z))}>
              +
            </button>
            <span className="separator" />
            <button
              type="button"
              className="tool"
              aria-pressed={tool === 'select'}
              title="Auswahl-Werkzeug (Esc)"
              onClick={() => setTool('select')}
            >
              ⬚ Auswahl
            </button>
            <button
              type="button"
              className="tool"
              aria-pressed={tool === 'text'}
              title="Text-Werkzeug"
              onClick={() => setTool('text')}
            >
              T Text
            </button>
            <span className="separator" />
            <button type="button" disabled={!store.canUndo} onClick={() => store.undo()} title="Rückgängig (Strg+Z)">
              ↩︎
            </button>
            <button type="button" disabled={!store.canRedo} onClick={() => store.redo()} title="Wiederholen (Strg+Y)">
              ↪︎
            </button>
            <button type="button" onClick={() => void onExport()}>
              Exportieren
            </button>
          </>
        )}
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!pdf && !error && <p className="hint">Wähle eine PDF-Datei, um sie anzuzeigen.</p>}
      <div className="pages">
        {pdf &&
          Array.from({ length: pdf.pageCount }, (_, index) => (
            <PageView
              key={index}
              pdf={pdf}
              pageIndex={index}
              zoom={zoom}
              tool={tool}
              overlays={overlays}
              store={store}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ))}
      </div>
    </div>
  )
}
