// Kern-Modul: PDF laden und rendern (PDF.js). Die UI ruft nur diese API auf,
// niemals pdfjs-dist direkt (Kern/UI-Grenze, ADR-004).
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export interface LoadedPdf {
  readonly fileName: string
  readonly pageCount: number
  /** Original-Bytes, bleiben für den Export erhalten. */
  readonly bytes: Uint8Array
  readonly document: PDFDocumentProxy
}

export async function loadPdf(fileName: string, bytes: Uint8Array): Promise<LoadedPdf> {
  // getDocument transferiert den Buffer in den Worker und „detached" ihn dabei —
  // deshalb bekommt PDF.js eine Kopie, das Original bleibt nutzbar.
  const document = await getDocument({ data: bytes.slice() }).promise
  return { fileName, pageCount: document.numPages, bytes, document }
}

export async function renderPage(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  zoom: number,
): Promise<void> {
  const page = await pdf.getPage(pageNumber)
  const pixelRatio = window.devicePixelRatio || 1
  const viewport = page.getViewport({ scale: zoom * pixelRatio })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`
  canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`
  await page.render({ canvas, viewport }).promise
}
