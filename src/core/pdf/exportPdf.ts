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
  // Symbols live in ZapfDingbats; it has no bold/italic variants.
  zapfdingbats: {
    plain: StandardFonts.ZapfDingbats,
    bold: StandardFonts.ZapfDingbats,
    italic: StandardFonts.ZapfDingbats,
    boldItalic: StandardFonts.ZapfDingbats,
  },
}

// WinAnsi (the standard text fonts' encoding) covers Latin-1 plus these
// extras; anything else (e.g. a symbol pasted into a text font) becomes '?'.
const NOT_WINANSI = /[^\u0020-\u007E\u00A0-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201A\u201C-\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122\n\t]/g

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
      // ZapfDingbats takes the Unicode symbol directly; text fonts are
      // WinAnsi-encoded, so unencodable characters are replaced.
      const text = overlay.font === 'zapfdingbats' ? overlay.text : overlay.text.replace(NOT_WINANSI, '?')
      const page = doc.getPage(overlay.pageIndex)
      page.drawText(text, {
        x: overlay.x,
        y: overlay.y,
        size: overlay.fontSize,
        font,
      })
      if (overlay.underline && overlay.font !== 'zapfdingbats') {
        const width = font.widthOfTextAtSize(text, overlay.fontSize)
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
