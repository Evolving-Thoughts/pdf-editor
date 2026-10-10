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

/**
 * Keeps only characters the embedded font can encode, so one bad box can
 * never abort the whole export: unencodable characters become '?' in text
 * fonts (WinAnsi) and are dropped in ZapfDingbats (e.g. a letter typed into
 * a symbol box). Checked per character against the font itself.
 */
function sanitizeFor(font: PDFFont, text: string, fontKey: OverlayFont): string {
  const fallback = fontKey === 'zapfdingbats' ? '' : '?'
  let out = ''
  for (const char of text) {
    try {
      font.encodeText(char)
      out += char
    } catch {
      out += fallback
    }
  }
  return out
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
      const text = sanitizeFor(font, overlay.text, overlay.font)
      if (text.length === 0) continue
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
