// Core module: export a PDF (pdf-lib). Overlays are written as real,
// selectable PDF text objects (see ADR-001 and the spec).
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'
import type { OverlayFont, Textbox } from '../model'

const FONT_MAP: Record<OverlayFont, StandardFonts> = {
  helvetica: StandardFonts.Helvetica,
  times: StandardFonts.TimesRoman,
  courier: StandardFonts.Courier,
}

export async function exportPdf(bytes: Uint8Array, overlays: Textbox[] = []): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const visible = overlays.filter((overlay) => overlay.text.trim().length > 0)
  if (visible.length > 0) {
    const fonts = new Map<OverlayFont, PDFFont>()
    for (const overlay of visible) {
      let font = fonts.get(overlay.font)
      if (!font) {
        font = await doc.embedFont(FONT_MAP[overlay.font])
        fonts.set(overlay.font, font)
      }
      doc.getPage(overlay.pageIndex).drawText(overlay.text, {
        x: overlay.x,
        y: overlay.y,
        size: overlay.fontSize,
        font,
      })
    }
  }
  return doc.save()
}
