import { PDFDocument } from 'pdf-lib'
import { exportPdf as exportWithIds } from '../../src/core/pdf/exportPdf'
import type { Overlay } from '../../src/core/model'

/** Export for tests without a page list: the file's pages are named p0, p1, … */
export async function exportPdf(bytes: Uint8Array, overlays: Overlay[] = []) {
  const count = (await PDFDocument.load(bytes)).getPageCount()
  return exportWithIds(bytes, overlays, Array.from({ length: count }, (_, index) => `p${index}`))
}
