// Core module: export a PDF (pdf-lib). T1 = plain roundtrip without changes.
import { PDFDocument } from 'pdf-lib'

export async function exportPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  return doc.save()
}
