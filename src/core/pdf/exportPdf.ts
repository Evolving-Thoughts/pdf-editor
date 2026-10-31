// Core module: export a PDF (pdf-lib). Overlays are written as real,
// selectable PDF text objects (see ADR-001 and the spec).
import {
  BlendMode, LineCapStyle, LineJoinStyle, PDFDocument, PDFName, PDFNumber, popGraphicsState, pushGraphicsState,
  clip, endPath, moveTo, lineTo, closePath, degrees, rgb, setLineJoin, StandardFonts, type Color, type PDFFont, type PDFImage, type PDFPage,
} from 'pdf-lib'
import { bundledFontUrl, isBundledFont, loadBundledFont, type BundledFont } from '../fonts'
import { resolvedOverlayClips } from '../overlayClipping'
import { TEXT_LINE_HEIGHT } from '../textLayout'
import { strokeToSvgPath } from '../drawing'
import { MARKER_OPACITY, shapeToSvgPath } from '../shapes'
import { isImage, isShape, isStroke, type Overlay, type OverlayFont, type ShapeOverlay, type Stroke, type Textbox } from '../model'

// Bold/italic map to the matching PDF standard font; underline has no font
// variant and is drawn as a line below the text.
const FONT_VARIANTS: Record<Exclude<OverlayFont, BundledFont>, { plain: StandardFonts; bold: StandardFonts; italic: StandardFonts; boldItalic: StandardFonts }> = {
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

/** Characters without a glyph, in text order and once each. The preflight shows these before export. */
export function unsupportedCharacters(font: PDFFont, text: string): string[] {
  const supported = new Set(font.getCharacterSet()), missing = new Set<string>()
  for (const char of text.replace(/\r\n?/g, '\n'))
    // A line break is layout, not a font glyph.
    if (char !== '\n' && !supported.has(char.codePointAt(0)!)) missing.add(char)
  return [...missing]
}

/**
 * Keeps only characters the embedded font has, so one bad box can never abort
 * the whole export: others become '?' in text fonts and are dropped in
 * ZapfDingbats (e.g. a letter typed into a symbol box). The export dialog
 * lists them first and asks before anything is replaced.
 */
function sanitizeFor(font: PDFFont, text: string, fontKey: OverlayFont): string {
  const fallback = fontKey === 'zapfdingbats' ? '' : '?'
  const missing = new Set(unsupportedCharacters(font, text))
  let out = ''
  for (const char of text.replace(/\r\n?/g, '\n')) out += missing.has(char) ? fallback : char
  return out
}

function variantFor(overlay: Textbox): StandardFonts {
  if (isBundledFont(overlay.font)) throw new Error('Gebündelte Schrift separat einbetten.')
  const variants = FONT_VARIANTS[overlay.font]
  if (overlay.bold && overlay.italic) return variants.boldItalic
  if (overlay.bold) return variants.bold
  if (overlay.italic) return variants.italic
  return variants.plain
}

/** The one place that picks an overlay's font, shared by export and preflight. */
export async function embedOverlayFont(doc: PDFDocument, overlay: Textbox, fonts: Map<string, PDFFont>): Promise<PDFFont> {
  const custom = isBundledFont(overlay.font)
  const variant = custom ? bundledFontUrl(overlay) : variantFor(overlay)
  let font = fonts.get(variant)
  if (!font) {
    if (custom) {
      const { default: fontkit } = await import('@pdf-lib/fontkit')
      doc.registerFontkit(fontkit)
      font = await doc.embedFont(await loadBundledFont(variant), { subset: true })
    } else font = await doc.embedFont(variant)
    fonts.set(variant, font)
  }
  return font
}

/** `pageIds` names the pages of `bytes` in file order, so overlays find their page. */
export async function exportPdf(bytes: Uint8Array, overlays: Overlay[], pageIds: readonly string[]): Promise<Uint8Array> {
  // No library entries: metadata is decided in T24 and must not come back by itself.
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const fonts = new Map<string, PDFFont>()
  const images = new Map<string, PDFImage>()
  for (const overlay of overlays) {
    const page = doc.getPage(pageIds.indexOf(overlay.pageId))
    const polygons = resolvedOverlayClips(overlay)
    if (polygons.length) {
      page.pushOperators(pushGraphicsState())
      const space = displayedPageSpace(page)
      for (const polygon of polygons) {
        const points = polygon.map(p => space.toPdf(p.x, p.y))
        page.pushOperators(moveTo(points[0].x, points[0].y), ...points.slice(1).map(p => lineTo(p.x, p.y)), closePath(), clip(), endPath())
      }
    }
    try {
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
      const font = await embedOverlayFont(doc, overlay, fonts)
      const text = sanitizeFor(font, overlay.text, overlay.font)
      if (text.length === 0) continue
      const space = displayedPageSpace(page)
      page.drawText(text, {
        ...space.toPdf(overlay.x, overlay.y),
        size: overlay.fontSize / space.unit,
        lineHeight: overlay.fontSize * TEXT_LINE_HEIGHT / space.unit,
        rotate: degrees(space.rotation - (overlay.rotation ?? 0)),
        font,
      })
      if (overlay.underline && overlay.font !== 'zapfdingbats') {
        const underlineFont = font
        text.split('\n').forEach((line, index) => {
          if (!line) return
          const width = underlineFont.widthOfTextAtSize(line, overlay.fontSize)
          const localY = -index * overlay.fontSize * TEXT_LINE_HEIGHT - overlay.fontSize * 0.12
          const angle = -(overlay.rotation ?? 0) * Math.PI / 180
          const point = (x: number) => space.toPdf(overlay.x + Math.cos(angle) * x - Math.sin(angle) * localY,
            overlay.y + Math.sin(angle) * x + Math.cos(angle) * localY)
          page.drawLine({
            start: point(0),
            end: point(width),
            thickness: Math.max(0.5, overlay.fontSize * 0.05) / space.unit,
          })
        })
      }
    } finally { if (polygons.length) page.pushOperators(popGraphicsState()) }
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
  // Match SVG round joins without leaking stroke state to later elements.
  page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round))
  page.drawSvgPath(path, { ...origin, scale: 1 / space.unit, rotate: degrees(space.rotation - shape.rotation),
    color: shape.fill ? colorFromHex(shape.fill) : undefined,
    borderColor: shape.strokeColor ? colorFromHex(shape.strokeColor) : undefined,
    borderWidth: shape.strokeColor ? shape.strokeWidth / space.unit : 0,
    borderLineCap: LineCapStyle.Round,
    ...(shape.shape === 'marker' ? { borderOpacity: MARKER_OPACITY, blendMode: BlendMode.Multiply } : {}),
  })
  page.pushOperators(popGraphicsState())
}
