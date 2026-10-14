import type { FormValues } from '../forms'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString,
  clip, concatTransformationMatrix, endPath, popGraphicsState, pushGraphicsState, rectangle,
} from 'pdf-lib'
import { a4Size, pageSize, type DocumentPage, type PageSource } from '../pages'
import { cloneOverlay, isShape, isStroke, isTextbox, type Overlay } from '../model'
import { capturePageClip } from '../overlayClipping'
import { clipAnnotation } from './clipAnnotation'
import { composePages, preparePages } from './pageOperations'

/** Normalize a derived source, never the user's original bytes or live state. */
export async function normalizeA4(original: Uint8Array, sources: PageSource[], pages: DocumentPage[], overlays: Overlay[], formValues: FormValues = {}) {
  if (pages.some(page => page.hasXfa)) throw new Error('XFA-Formulare werden bei Seitenoperationen noch nicht unterstützt.')
  const bytes = await composePages(original, sources, pages, formValues)
  const doc = await PDFDocument.load(bytes)
  if (doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.has(PDFName.of('XFA')))
    throw new Error('XFA-Formulare werden bei Seitenoperationen noch nicht unterstützt.')
  const factors = new Map<PDFDict, number>()
  const mapped = overlays.map(cloneOverlay)
  for (let index = 0; index < pages.length; index++) {
    const page = doc.getPage(index), plan = pages[index], size = pageSize(plan), target = a4Size(size)
    const factor = Math.min(target.width / size.width, target.height / size.height)
    const dx = (target.width - size.width * factor) / 2, dy = (target.height - size.height * factor) / 2
    const rotated = plan.rotation % 180 !== 0
    const width = rotated ? target.height : target.width, height = rotated ? target.width : target.height
    const pdfScale = factor * plan.unit
    const x = (width - plan.box.width * pdfScale) / 2 - plan.box.x * pdfScale
    const y = (height - plan.box.height * pdfScale) / 2 - plan.box.y * pdfScale
    // Clip BEFORE enlarging MediaBox: old cropped content must not reappear in margins.
    page.node.normalize()
    const start = doc.context.register(doc.context.contentStream([
      pushGraphicsState(), concatTransformationMatrix(pdfScale, 0, 0, pdfScale, x, y),
      rectangle(plan.box.x, plan.box.y, plan.box.width, plan.box.height), clip(), endPath(),
    ]))
    const end = doc.context.register(doc.context.contentStream([popGraphicsState()]))
    page.node.wrapContentStreams(start, end)
    const annots = page.node.Annots()
    if (annots) for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i)
      if (!(annot instanceof PDFDict)) continue
      clipAnnotation(doc, annot, plan.box)
      factors.set(annot, pdfScale)
      // Rect, quad points, ink, lines and vertices use source-page coordinates.
      for (const key of ['Rect', 'QuadPoints', 'L', 'Vertices', 'CL']) transformArray(annot.lookup(PDFName.of(key)), pdfScale, x, y)
      const ink = annot.lookup(PDFName.of('InkList'))
      if (ink instanceof PDFArray) for (let j = 0; j < ink.size(); j++) transformArray(ink.lookup(j), pdfScale, x, y)
    }
    page.setMediaBox(0, 0, width, height)
    page.setCropBox(0, 0, width, height)
    page.setBleedBox(0, 0, width, height); page.setTrimBox(0, 0, width, height); page.setArtBox(0, 0, width, height)
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(1))
    for (const overlay of mapped.filter(o => o.pageIndex === index)) {
      capturePageClip(overlay, size)
      if (isStroke(overlay)) {
        overlay.points = overlay.points.map(p => ({ x: p.x * factor + dx, y: p.y * factor + dy }))
        overlay.width *= factor
        overlay.clips = overlay.clips?.map(polygon => polygon.map(p => ({ x: p.x * factor + dx, y: p.y * factor + dy })))
      } else {
        overlay.x = overlay.x * factor + dx; overlay.y = overlay.y * factor + dy
        if (isTextbox(overlay)) overlay.fontSize *= factor
        else { overlay.width *= factor; overlay.height *= factor; if (isShape(overlay)) overlay.strokeWidth *= factor }
      }
    }
  }
  // Existing appearance streams scale with Rect. Future field edits need matching DA sizes.
  for (const field of doc.getForm().getFields()) {
    const scales = field.acroField.getWidgets().map(w => factors.get(w.dict)).filter((x): x is number => x !== undefined)
    if (!scales.length) continue
    const appearance = field.acroField.getDefaultAppearance() ?? doc.getForm().acroForm.dict.lookup(PDFName.of('DA'))
    const text = typeof appearance === 'string' ? appearance : appearance instanceof PDFString || appearance instanceof PDFHexString ? appearance.decodeText() : undefined
    if (text) field.acroField.setDefaultAppearance(text.replace(/([\d.+-]+)\s+Tf\b/g, (_, value) => `${scales.every(s => Math.abs(s - scales[0]) < 1e-8) ? Number(value) * scales[0] : 0} Tf`))
  }
  const prepared = await preparePages(await doc.save({ updateFieldAppearances: false }), 'A4')
  return { ...prepared, pages: prepared.pages.map((p, i) => ({ ...p, id: pages[i].id, name: pages[i].name })), overlays: mapped }
}
function transformArray(value: unknown, factor: number, x: number, y: number) {
  if (!(value instanceof PDFArray)) return
  for (let i = 0; i + 1 < value.size(); i += 2) {
    const a = value.lookup(i), b = value.lookup(i + 1)
    if (a instanceof PDFNumber && b instanceof PDFNumber) {
      value.set(i, PDFNumber.of(a.asNumber() * factor + x)); value.set(i + 1, PDFNumber.of(b.asNumber() * factor + y))
    }
  }
}
