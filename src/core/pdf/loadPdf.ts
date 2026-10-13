// Core module: load, render and release PDFs (PDF.js).
// The UI only ever talks to the PdfHandle, never to pdfjs-dist directly
// (core/UI boundary, ADR-004).
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Overlay } from '../model'
import { exportPdf } from './exportPdf'

GlobalWorkerOptions.workerSrc = workerUrl

export interface PageSize {
  width: number
  height: number
}

export interface PdfHandle {
  readonly fileName: string
  readonly pageCount: number
  /** Renders a page (1-based) into the canvas; renders per canvas are serialized internally. */
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, zoom: number): Promise<void>
  /** Page size in PDF points (1-based page number), cached after first call. */
  getPageSize(pageNumber: number): Promise<PageSize>
  /** Exports the document with the given overlays baked in as real text. */
  exportBytes(overlays?: Overlay[]): Promise<Uint8Array>
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
  const sizeCache = new Map<number, PageSize>()

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

    async getPageSize(pageNumber) {
      const cached = sizeCache.get(pageNumber)
      if (cached) return cached
      const page = await pdfDocument.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const size = { width: viewport.width, height: viewport.height }
      sizeCache.set(pageNumber, size)
      return size
    },

    exportBytes: (overlays) => exportPdf(bytes, overlays),
    destroy: () => loadingTask.destroy(),
  }
}
