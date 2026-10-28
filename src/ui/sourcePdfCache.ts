import { loadPdf } from '../core/pdf/loadPdf'
import type { PdfHandle } from '../core/pdf/loadPdf'

/** PDF.js documents of the correction panel, one per source buffer. Switching
 * pages reuses the parsed document instead of loading the file again. */
export interface PdfDocuments { get(bytes: ArrayBuffer): Promise<PdfHandle>; drop(bytes: ArrayBuffer): void; destroy(): void }
export function pdfDocuments(limit = 6): PdfDocuments {
  const docs = new Map<ArrayBuffer, Promise<PdfHandle>>()
  const close = (doc: Promise<PdfHandle>) => { void doc.then(d => d.destroy()).catch(() => undefined) }
  return {
    get(bytes) {
      let doc = docs.get(bytes)
      if (doc) { docs.delete(bytes); docs.set(bytes, doc); return doc } // most recently used last
      doc = loadPdf('Korrekturvorschau', new Uint8Array(bytes))
      docs.set(bytes, doc)
      doc.catch(() => { if (docs.get(bytes) === doc) docs.delete(bytes) })
      while (docs.size > limit) { const [key, old] = docs.entries().next().value!; docs.delete(key); close(old) }
      return doc
    },
    drop(bytes) { const doc = docs.get(bytes); if (doc) { docs.delete(bytes); close(doc) } },
    destroy() { for (const doc of docs.values()) close(doc); docs.clear() },
  }
}
