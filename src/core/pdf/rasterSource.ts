import { PDFDocument } from 'pdf-lib'
import { createId } from '../model'
import { pageSize, type DocumentPage, type PageSource } from '../pages'
export interface RasterPage { page: DocumentPage; png: Uint8Array }
export async function writeRasterSource(rows: RasterPage[]): Promise<{ source: PageSource; replacements: DocumentPage[] }> {
  if (!rows.length) throw new Error('Keine Rasterseiten vorhanden.')
  const doc = await PDFDocument.create(), id = `redacted-${createId()}`, replacements: DocumentPage[] = []
  for (const [index, row] of rows.entries()) {
    const size = pageSize(row.page), page = doc.addPage([size.width, size.height]), image = await doc.embedPng(row.png)
    page.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height })
    replacements.push({ ...row.page, sourceId: id, sourceIndex: index, box: { x: 0, y: 0, width: size.width, height: size.height }, unit: 1, rotation: 0, hasForms: false, hasXfa: false, cropped: false, redacted: true })
  }
  return { source: { id, bytes: (await doc.save()).slice().buffer }, replacements }
}
