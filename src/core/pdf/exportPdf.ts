// Kern-Modul: PDF exportieren (pdf-lib). T1 = reiner Roundtrip ohne Änderungen.
import { PDFDocument } from 'pdf-lib'

export async function exportPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  return doc.save()
}
