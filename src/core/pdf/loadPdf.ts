// Core module: load, render and release PDFs (PDF.js).
// The UI only ever talks to the PdfHandle, never to pdfjs-dist directly
// (core/UI boundary, ADR-004).
import {
  getDocument,
  GlobalWorkerOptions,
  RenderingCancelledException,
  type RenderTask,
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { exportPdf } from './exportPdf'

GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfHandle {
  readonly fileName: string
  readonly pageCount: number
  /** Renders a page (1-based) into the canvas; supersedes any render still running on the same canvas. */
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
  const activeRenders = new Map<HTMLCanvasElement, RenderTask>()

  return {
    fileName,
    pageCount: pdfDocument.numPages,

    async renderPage(pageNumber, canvas, zoom) {
      activeRenders.get(canvas)?.cancel()
      const page = await pdfDocument.getPage(pageNumber)
      const pixelRatio = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: zoom * pixelRatio })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`
      canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`
      const task = page.render({ canvas, viewport })
      activeRenders.set(canvas, task)
      try {
        await task.promise
      } catch (error) {
        // Cancelled renders (new zoom level / page switch) are not errors.
        if (!(error instanceof RenderingCancelledException)) throw error
      } finally {
        if (activeRenders.get(canvas) === task) activeRenders.delete(canvas)
      }
    },

    exportBytes: () => exportPdf(bytes),
    destroy: () => loadingTask.destroy(),
  }
}
