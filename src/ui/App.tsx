import { useCallback, useEffect, useRef, useState } from 'react'
import { loadPdf, type PdfHandle } from '../core/pdf/loadPdf'
import { zoomIn, zoomOut } from '../core/viewerState'
import './app.css'

export default function App() {
  const [pdf, setPdf] = useState<PdfHandle | null>(null)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  // Current handle in a ref so destroy() runs outside React state updaters
  // (updaters must stay pure; StrictMode double-invokes them in dev).
  const pdfRef = useRef<PdfHandle | null>(null)

  const onOpenFile = useCallback(async (file: File) => {
    setError(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const next = await loadPdf(file.name, bytes)
      void pdfRef.current?.destroy()
      pdfRef.current = next
      setPdf(next)
    } catch {
      setError(`„${file.name}“ konnte nicht geöffnet werden (beschädigt oder passwortgeschützt?).`)
    }
  }, [])

  useEffect(() => {
    if (!pdf || !pagesRef.current) return
    const canvases = pagesRef.current.querySelectorAll('canvas')
    canvases.forEach((canvas, index) => {
      void pdf.renderPage(index + 1, canvas, zoom)
    })
  }, [pdf, zoom])

  // Release the worker document when the app unmounts.
  useEffect(() => () => void pdfRef.current?.destroy(), [])

  const onExport = useCallback(async () => {
    if (!pdf) return
    const bytes = await pdf.exportBytes()
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }))
    const link = document.createElement('a')
    link.href = url
    link.download = pdf.fileName
    link.click()
    // Defer revocation: Firefox/Safari may abort the download if the URL
    // is revoked in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [pdf])

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
      <div className="pages" ref={pagesRef}>
        {pdf && Array.from({ length: pdf.pageCount }, (_, i) => <canvas key={i} />)}
      </div>
    </div>
  )
}
