// Kern-Modul: PDF laden, rendern und freigeben (PDF.js).
// Die UI kennt nur das PdfHandle, niemals pdfjs-dist direkt (Kern/UI-Grenze, ADR-004).
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
  /** Rendert eine Seite (1-basiert) in das Canvas; löst einen laufenden Render auf demselben Canvas ab. */
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, zoom: number): Promise<void>
  /** Exportiert das Dokument unverändert (T1: reiner Roundtrip). */
  exportBytes(): Promise<Uint8Array>
  /** Gibt Worker-Ressourcen frei; beim Wechsel oder Schließen aufrufen. */
  destroy(): Promise<void>
}

export async function loadPdf(fileName: string, bytes: Uint8Array): Promise<PdfHandle> {
  // getDocument transferiert den Buffer in den Worker und „detached“ ihn dabei —
  // deshalb bekommt PDF.js eine Kopie, das Original bleibt für den Export nutzbar.
  const loadingTask = getDocument({ data: bytes.slice() })
  const document = await loadingTask.promise
  const activeRenders = new Map<HTMLCanvasElement, RenderTask>()

  return {
    fileName,
    pageCount: document.numPages,

    async renderPage(pageNumber, canvas, zoom) {
      activeRenders.get(canvas)?.cancel()
      const page = await document.getPage(pageNumber)
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
        // Abgebrochene Renders (neuer Zoom/Wischeffekt) sind kein Fehler.
        if (!(error instanceof RenderingCancelledException)) throw error
      } finally {
        if (activeRenders.get(canvas) === task) activeRenders.delete(canvas)
      }
    },

    exportBytes: () => exportPdf(bytes),
    destroy: () => loadingTask.destroy(),
  }
}
