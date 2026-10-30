// Core module: writes recognized words as invisible PDF text. The page's pixels stay
// exactly as they are. Words are stored in source coordinates, so they follow the page
// through reordering, rotation and crop without any conversion.
import {
  beginText, endText, PDFDocument, popGraphicsState, pushGraphicsState, rotateAndSkewTextRadiansAndTranslate, setCharacterSqueeze,
  setFontAndSize, setTextRenderingMode, showText, StandardFonts, TextRenderingMode, type PDFFont,
} from 'pdf-lib'
import { pageSize, sourcePoint, type DocumentPage, type OcrSourceWord } from '../pages'
import type { OcrWord } from './recognize'

const FONT_NAME = 'OcrText'
/** Tesseract boxes end at the descender line; the baseline sits a little above it. */
const DESCENT_SHARE = 0.2

export function toSourceWords(page: DocumentPage, words: OcrWord[]): OcrSourceWord[] {
  const size = pageSize(page)
  return words.flatMap(word => {
    const height = word.bottom - word.top, baseline = word.bottom - height * DESCENT_SHARE
    if (!(height > 0) || !(word.right > word.left)) return []
    const start = sourcePoint(page, word.left, size.height - baseline), end = sourcePoint(page, word.right, size.height - baseline)
    return [{ text: word.text, x: start.x, y: start.y, dx: end.x - start.x, dy: end.y - start.y, height: height / page.unit }]
  })
}

const encodable = (font: PDFFont, text: string) => {
  const supported = new Set(font.getCharacterSet())
  return [...text].filter(character => supported.has(character.codePointAt(0)!)).join('')
}

export async function writeOcrLayers(bytes: Uint8Array, pages: DocumentPage[]): Promise<Uint8Array> {
  if (!pages.some(page => page.ocr?.length)) return bytes
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const [index, entry] of pages.entries()) {
    if (!entry.ocr?.length) continue
    const page = doc.getPage(index)
    const name = page.node.newFontDictionary(FONT_NAME, font.ref)
    page.pushOperators(pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible))
    for (const word of entry.ocr) {
      const text = encodable(font, word.text), width = Math.hypot(word.dx, word.dy)
      if (!text || !(width > 0) || !(word.height > 0)) continue
      const natural = font.widthOfTextAtSize(text, word.height)
      page.pushOperators(
        setFontAndSize(name, word.height),
        setCharacterSqueeze(natural > 0 ? (width / natural) * 100 : 100),
        rotateAndSkewTextRadiansAndTranslate(Math.atan2(word.dy, word.dx), 0, 0, word.x, word.y),
        showText(font.encodeText(`${text} `)),
      )
    }
    page.pushOperators(endText(), popGraphicsState())
  }
  return doc.save({ updateFieldAppearances: false, addDefaultPage: false })
}
