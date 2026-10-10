// Core module: load, render and release PDFs (PDF.js).
// The UI only ever talks to the PdfHandle, never to pdfjs-dist directly
// (core/UI boundary, ADR-004).
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { exportPdf } from './exportPdf'

GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfHandle {
  readonly fileName: string
  readonly pageCount: number
  /** Renders a page (1-based) into the canvas; renders per canvas are serialized internally. */
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, zoom: number): Promise<void>
  /** Exports the document unchanged (T1: pure roundtrip). */
  exportBytes(): Promise<Uint8Array>
  /** Releases worker resources; call when switching or closing documents. */
  destroy(): Promise<void>
}

export async function loadPdf(fileName: string, bytes: Uint8Array): Promise<PdfHandle> {
  // getDocument transfers the buffer to the worker, which detaches it —
  // so PDF.js gets a copy and the original stays usable for export.
  const loadingTask = getDocument({ data: bytes.slice() })
  const pdfDocument = await loadingTask.promise

  // Per-canvas promise chain: PDF.js throws when a canvas is rendered
  // concurrently, and cancel-then-register leaves a race window across the
  // getPage await (triggered e.g. by StrictMode double effects). Registering
  // the chain synchronously serializes all renders on the same canvas.
  const renderQueues = new Map<HTMLCanvasElement, Promise<void>>()

  return {
    fileName,
    pageCount: pdfDocument.numPages,

    renderPage(pageNumber, canvas, zoom) {
      const queued = renderQueues.get(canvas) ?? Promise.resolve()
      const run = queued.catch(() => undefined).then(async () => {
        const page = await pdfDocument.getPage(pageNumber)
        const pixelRatio = window.devicePixelRatio || 1
        const viewport = page.getViewport({ scale: zoom * pixelRatio })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`
        canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`
        await page.render({ canvas, viewport }).promise
      })
      renderQueues.set(canvas, run)
      return run
    },

    exportBytes: () => exportPdf(bytes),
    destroy: () => loadingTask.destroy(),
  }
}
