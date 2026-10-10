// Core module: export a PDF (pdf-lib). Overlays are written as real,
// selectable PDF text objects (see ADR-001 and the spec).
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib'
import type { OverlayFont, Textbox } from '../model'

// Bold/italic map to the matching PDF standard font; underline has no font
// variant and is drawn as a line below the text.
const FONT_VARIANTS: Record<OverlayFont, { plain: StandardFonts; bold: StandardFonts; italic: StandardFonts; boldItalic: StandardFonts }> = {
  helvetica: {
    plain: StandardFonts.Helvetica,
    bold: StandardFonts.HelveticaBold,
    italic: StandardFonts.HelveticaOblique,
    boldItalic: StandardFonts.HelveticaBoldOblique,
  },
  times: {
    plain: StandardFonts.TimesRoman,
    bold: StandardFonts.TimesRomanBold,
    italic: StandardFonts.TimesRomanItalic,
    boldItalic: StandardFonts.TimesRomanBoldItalic,
  },
  courier: {
    plain: StandardFonts.Courier,
    bold: StandardFonts.CourierBold,
    italic: StandardFonts.CourierOblique,
    boldItalic: StandardFonts.CourierBoldOblique,
  },
}

function variantFor(overlay: Textbox): StandardFonts {
  const variants = FONT_VARIANTS[overlay.font]
  if (overlay.bold && overlay.italic) return variants.boldItalic
  if (overlay.bold) return variants.bold
  if (overlay.italic) return variants.italic
  return variants.plain
}

export async function exportPdf(bytes: Uint8Array, overlays: Textbox[] = []): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const visible = overlays.filter((overlay) => overlay.text.trim().length > 0)
  if (visible.length > 0) {
    const fonts = new Map<StandardFonts, PDFFont>()
    for (const overlay of visible) {
      const variant = variantFor(overlay)
      let font = fonts.get(variant)
      if (!font) {
        font = await doc.embedFont(variant)
        fonts.set(variant, font)
      }
      const page = doc.getPage(overlay.pageIndex)
      page.drawText(overlay.text, {
        x: overlay.x,
        y: overlay.y,
        size: overlay.fontSize,
        font,
      })
      if (overlay.underline) {
        const width = font.widthOfTextAtSize(overlay.text, overlay.fontSize)
        const lineY = overlay.y - overlay.fontSize * 0.12
        page.drawLine({
          start: { x: overlay.x, y: lineY },
          end: { x: overlay.x + width, y: lineY },
          thickness: Math.max(0.5, overlay.fontSize * 0.05),
        })
      }
    }
  }
  return doc.save()
}
