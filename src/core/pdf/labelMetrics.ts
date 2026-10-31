import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { MeasureText } from '../pageLabels'

/** Real metrics of the standard fonts, from the same library that writes the export. */
export async function createLabelMeasure(): Promise<MeasureText> {
  const doc = await PDFDocument.create()
  const fonts = {
    helvetica: await doc.embedFont(StandardFonts.Helvetica),
    times: await doc.embedFont(StandardFonts.TimesRoman),
    courier: await doc.embedFont(StandardFonts.Courier),
  }
  return (text, font, size) => {
    // A character outside the font still needs a width; the preflight reports it at export.
    try { return fonts[font].widthOfTextAtSize(text, size) } catch { return text.length * size * 0.6 }
  }
}
