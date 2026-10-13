// Core module: export a PDF (pdf-lib). Overlays are written as real,
// selectable PDF text objects (see ADR-001 and the spec).
import {
  BlendMode, LineCapStyle, LineJoinStyle, PDFDocument, PDFName, PDFNumber, popGraphicsState, pushGraphicsState,
  degrees, rgb, setLineJoin, StandardFonts, type Color, type PDFFont, type PDFImage, type PDFPage,
} from 'pdf-lib'
import { strokeToSvgPath } from '../drawing'
import { MARKER_OPACITY, shapeToSvgPath } from '../shapes'
import { isImage, isShape, isStroke, type Overlay, type OverlayFont, type ShapeOverlay, type Stroke, type Textbox } from '../model'

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

export async function exportPdf(bytes: Uint8Array, overlays: Overlay[] = []): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  const fonts = new Map<StandardFonts, PDFFont>()
  const images = new Map<string, PDFImage>()
  for (const overlay of overlays) {
    const page = doc.getPage(overlay.pageIndex)
    if (isStroke(overlay)) {
      drawStroke(page, overlay)
      continue
    }
    if (isImage(overlay)) {
      let embedded = images.get(overlay.dataUrl)
      if (!embedded) {
        embedded = overlay.dataUrl.startsWith('data:image/jpeg')
          ? await doc.embedJpg(overlay.dataUrl) : await doc.embedPng(overlay.dataUrl)
        images.set(overlay.dataUrl, embedded)
      }
      const space = displayedPageSpace(page)
      // Browser clockwise rotation is negative in the PDF's y-up coordinates.
      const rotation = overlay.rotation ?? 0
      const angle = -rotation * Math.PI / 180
      const centerX = overlay.x + overlay.width / 2
      const centerY = overlay.y + overlay.height / 2
      const origin = rotation === 0 ? space.toPdf(overlay.x, overlay.y) : space.toPdf(
        centerX - Math.cos(angle) * overlay.width / 2 + Math.sin(angle) * overlay.height / 2,
        centerY - Math.sin(angle) * overlay.width / 2 - Math.cos(angle) * overlay.height / 2,
      )
      page.drawImage(embedded, { ...origin, width: overlay.width / space.unit,
        height: overlay.height / space.unit, rotate: degrees(space.rotation - rotation) })
      continue
    }
    if (isShape(overlay)) {
      drawShape(page, overlay)
      continue
    }
    if (overlay.text.trim().length === 0) continue
    const variant = variantFor(overlay)
    let font = fonts.get(variant)
    if (!font) {
      font = await doc.embedFont(variant)
      fonts.set(variant, font)
    }
    const text = sanitizeFor(font, overlay.text, overlay.font)
    if (text.length === 0) continue
    const space = displayedPageSpace(page)
    page.drawText(text, {
      ...space.toPdf(overlay.x, overlay.y),
      size: overlay.fontSize / space.unit,
      rotate: degrees(space.rotation),
      font,
    })
    if (overlay.underline && overlay.font !== 'zapfdingbats') {
      const width = font.widthOfTextAtSize(text, overlay.fontSize)
      const lineY = overlay.y - overlay.fontSize * 0.12
      page.drawLine({
        start: space.toPdf(overlay.x, lineY),
        end: space.toPdf(overlay.x + width, lineY),
        thickness: Math.max(0.5, overlay.fontSize * 0.05) / space.unit,
      })
    }
  }
  return doc.save()
}

function colorFromHex(hex: string): Color {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) return rgb(0, 0, 0)
  const value = Number.parseInt(match[1], 16)
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255)
}

function displayedPageSpace(page: PDFPage) {
  // PDF.js shows the MediaBox/CropBox intersection after page rotation and
  // UserUnit scaling. Stored stroke points use that displayed bottom-left
  // origin; convert back before writing PDF operators.
  const media = page.getMediaBox()
  const crop = page.getCropBox()
  const left = Math.max(media.x, crop.x)
  const bottom = Math.max(media.y, crop.y)
  const right = Math.min(media.x + media.width, crop.x + crop.width)
  const top = Math.min(media.y + media.height, crop.y + crop.height)
  const box = right > left && top > bottom
    ? { x: left, y: bottom, width: right - left, height: top - bottom }
    : media
  const unitValue = page.node.get(PDFName.of('UserUnit'))
  const rawUnit = unitValue instanceof PDFNumber ? unitValue.asNumber() : 1
  const unit = rawUnit > 0 ? rawUnit : 1
  const rotation = ((page.getRotation().angle % 360) + 360) % 360
  const toPdf = (displayX: number, displayY: number) => {
    const x = displayX / unit
    const y = displayY / unit
    if (rotation === 90) return { x: box.x + box.width - y, y: box.y + x }
    if (rotation === 180) return { x: box.x + box.width - x, y: box.y + box.height - y }
    if (rotation === 270) return { x: box.x + y, y: box.y + box.height - x }
    return { x: box.x + x, y: box.y + y }
  }
  return { unit, rotation, toPdf }
}

function drawStroke(page: PDFPage, stroke: Stroke): void {
  if (stroke.points.length === 0) return
  const { unit, toPdf } = displayedPageSpace(page)
  const points = stroke.points.map((point) => toPdf(point.x, point.y))
  page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round))
  page.drawSvgPath(strokeToSvgPath(points, page.getHeight()), {
    x: 0,
    y: page.getHeight(),
    borderColor: colorFromHex(stroke.color),
    borderWidth: stroke.width / unit,
    borderLineCap: LineCapStyle.Round,
  })
  page.pushOperators(popGraphicsState())
}

function drawShape(page: PDFPage, shape: ShapeOverlay): void {
  const path = shapeToSvgPath(shape)
  if (!path || (!shape.fill && !shape.strokeColor)) return
  const space = displayedPageSpace(page)
  const angle = shape.rotation * Math.PI / 180
  const cx = shape.x + shape.width / 2, cy = shape.y + shape.height / 2
  const origin = space.toPdf(cx - Math.cos(angle) * shape.width / 2 + Math.sin(angle) * shape.height / 2,
    cy + Math.sin(angle) * shape.width / 2 + Math.cos(angle) * shape.height / 2)
  page.drawSvgPath(path, { ...origin, scale: 1 / space.unit, rotate: degrees(space.rotation - shape.rotation),
    color: shape.fill ? colorFromHex(shape.fill) : undefined,
    borderColor: shape.strokeColor ? colorFromHex(shape.strokeColor) : undefined,
    borderWidth: shape.strokeColor ? shape.strokeWidth / space.unit : 0,
    borderLineCap: LineCapStyle.Round,
    ...(shape.shape === 'marker' ? { borderOpacity: MARKER_OPACITY, blendMode: BlendMode.Multiply } : {}),
  })
}
