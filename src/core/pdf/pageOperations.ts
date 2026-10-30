import { sanitizeRedactedSource } from './redactionSafety'
import type { FormValues } from '../forms'
import { applyFormValues, updateFormAppearances } from './acroForm'
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFObjectCopier, PDFPage, PDFPageLeaf, StandardFonts, degrees } from 'pdf-lib'
import { cloneOverlay, createId, type Overlay } from '../model'
import { exportPdf } from './exportPdf'
import { pageSize, type DocumentPage, type PageSource } from '../pages'
import { importImage } from '../images/importImage'
import { initialImageGeometry } from '../images/geometry'
import { retainPageWidgets, namespaceFormResources, mergeAcroForm } from './preserveForms'
import { assertFileBudget, assertPageBudget } from './documentBudget'
import { writeOcrLayers } from '../ocr/ocrLayer'

export async function inspectPages(
  bytes: Uint8Array,
  name: string,
  sourceId = 'original',
): Promise<DocumentPage[]> {
  const doc = await PDFDocument.load(bytes)
  assertPageBudget(doc.getPageCount())
  const hasXfa = !!doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.has(PDFName.of('XFA'))
  if (hasXfa && sourceId !== 'original')
    throw new Error('XFA-Formulare werden bei Seitenoperationen noch nicht unterstützt.')
  const hasForms = !hasXfa && doc.getForm().getFields().length > 0
  return doc.getPages().map((page, index) => {
    const media = page.getMediaBox(),
      crop = page.getCropBox()
    const x = Math.max(media.x, crop.x),
      y = Math.max(media.y, crop.y)
    const right = Math.min(media.x + media.width, crop.x + crop.width),
      top = Math.min(media.y + media.height, crop.y + crop.height)
    const box = right > x && top > y ? { x, y, width: right - x, height: top - y } : media
    const raw = page.node.get(PDFName.of('UserUnit'))
    const unit = raw instanceof PDFNumber && raw.asNumber() > 0 ? raw.asNumber() : 1
    const rotation = ((page.getRotation().angle % 360) + 360) % 360
    if (![0, 90, 180, 270].includes(rotation)) throw new Error('Diese Seitendrehung wird nicht unterstützt.')
    return {
      id: createId(),
      hasForms,
      ...(hasXfa ? { hasXfa: true } : {}),
      name: `${name} · ${index + 1}`,
      sourceId,
      sourceIndex: index,
      box,
      unit,
      rotation,
    }
  })
}

/** True when an export keeps the original page tree, and so its document-level
 * structures (forms, metadata, outlines, tags). */
export async function keepsPageTree(original: Uint8Array, pages: DocumentPage[], secure: boolean): Promise<boolean> {
  if (secure || !pages.every((page, index) => page.sourceId === 'original' && page.sourceIndex === index)) return false
  const initial = await inspectPages(original, 'original')
  return initial.length === pages.length && initial.every((page, index) =>
    JSON.stringify(page.box) === JSON.stringify(pages[index].box) &&
    page.unit === pages[index].unit &&
    page.rotation === pages[index].rotation)
}

/** Base content only. Overlays remain editable and are applied by exportPdf afterwards. */
export async function composePages(
  original: Uint8Array,
  sources: PageSource[],
  pages: DocumentPage[],
  formValues: FormValues = {},
  secure = pages.some(page => page.redacted),
): Promise<Uint8Array> {
  return writeOcrLayers(await composeBase(original, sources, pages, formValues, secure), pages)
}

async function composeBase(
  original: Uint8Array,
  sources: PageSource[],
  pages: DocumentPage[],
  formValues: FormValues,
  secure: boolean,
): Promise<Uint8Array> {
  if (!pages.length) throw new Error('Ein PDF muss mindestens eine Seite enthalten.')
  // An ordinary overlay edit must not rebuild the page tree: preserve forms,
  // metadata, outlines and other document-level structures when no page changed.
  if (await keepsPageTree(original, pages, secure)) {
    if (!Object.keys(formValues).length) return original.slice()
    const doc = await PDFDocument.load(original)
    if (doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.has(PDFName.of('XFA'))) throw new Error('XFA-Formulare werden noch nicht unterstützt.')
    if (applyFormValues(doc, 'original', formValues)) { await updateFormAppearances(doc); return doc.save({ updateFieldAppearances: false }) }
    return original.slice()
  }

  const output = await PDFDocument.create({ updateMetadata: false })
  const loaded = new Map<string, { doc: PDFDocument; copier: PDFObjectCopier }>()
  for (const page of pages) {
    let source = loaded.get(page.sourceId)
    if (!source) {
      const bytes = page.sourceId === 'original' ? original : sources.find(s => s.id === page.sourceId)?.bytes
      if (!bytes) throw new Error('Quelldaten einer Seite fehlen.')
      const doc = await PDFDocument.load(bytes)
      if (doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.has(PDFName.of('XFA')))
        throw new Error('XFA-Formulare werden bei Seitenoperationen noch nicht unterstützt. Die Originaldatei bleibt unverändert.')
      if (applyFormValues(doc, page.sourceId, formValues)) await updateFormAppearances(doc)
      const indices = new Set(pages.filter(p => p.sourceId === page.sourceId).map(p => p.sourceIndex))
      retainPageWidgets(doc, indices)
      if (secure) sanitizeRedactedSource(doc, indices)
      namespaceFormResources(doc, `Source${loaded.size}`)
      source = { doc, copier: PDFObjectCopier.for(doc.context, output.context) }
      loaded.set(page.sourceId, source)
    }
    const sourcePage = source.doc.getPage(page.sourceIndex)
    const ref = source.copier.copy(sourcePage.ref)
    const copied = PDFPage.of(output.context.lookup(ref) as PDFPageLeaf, ref, output)
    copied.setRotation(degrees(page.rotation))
    copied.setCropBox(page.box.x, page.box.y, page.box.width, page.box.height)
    copied.node.set(PDFName.of('UserUnit'), PDFNumber.of(page.unit))
    output.addPage(copied)
  }
  // Stable names: preserve original field names even when attachments move before them.
  for (const id of ['original', ...sources.map(s => s.id)]) {
    const source = loaded.get(id)
    if (source) mergeAcroForm(source.doc, output, source.copier)
  }
  return output.save({ updateFieldAppearances: false })
}
/** A white sheet; the actual image is an editable overlay, not baked into the PDF. */
export async function imagePageBytes(size: { width: number; height: number }): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([size.width, size.height])
  return doc.save()
}
export async function textPageBytes(text: string, size = { width: 595.28, height: 841.89 }): Promise<Uint8Array> {
  if (!text.trim()) throw new Error('Bitte zuerst Text eingeben.')
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica)
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width < 36 || size.height < 36)
    throw new Error('Ungültige Seitengröße.')
  const margin = Math.min(50, size.width / 6, size.height / 6)
  let page = doc.addPage([size.width, size.height]),
    y = size.height - margin - 2
  const line = (value: string) => {
    if (y < margin) {
      page = doc.addPage([size.width, size.height])
      y = size.height - margin - 2
    }
    page.drawText(value, { x: margin, y, size: 12, font })
    y -= 17
  }
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    let current = ''
    for (const char of raw) {
      let safe = char
      try {
        font.encodeText(char)
      } catch {
        safe = '?'
      }
      if (font.widthOfTextAtSize(current + safe, 12) > size.width - 2 * margin) {
        line(current)
        current = ''
      }
      current += safe
    }
    line(current)
  }
  return doc.save()
}
export async function importPageFile(file: File, size = { width: 595.28, height: 841.89 }) {
  assertFileBudget(file.size)
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf')
    return preparePages(new Uint8Array(await file.arrayBuffer()), file.name)
  const image = await importImage(file)
  const imported = await preparePages(await imagePageBytes(size), file.name)
  const overlay: Overlay = { kind: 'image', id: createId(), pageIndex: 0, ...image,
    ...initialImageGeometry(image.pixelWidth, image.pixelHeight, size, { x: size.width / 2, y: size.height / 2 }) }
  return { ...imported, overlays: [overlay] }
}
export async function preparePages(bytes: Uint8Array, name: string) {
  const id = createId(),
    pages = await inspectPages(bytes, name, id)
  if (!pages.length) throw new Error('Die Datei enthält keine Seiten.')
  return { pages, source: { id, bytes: bytes.slice().buffer as ArrayBuffer }, overlays: [] as Overlay[] }
}
export { pageSize }

export async function exportPageDocument(
  original: Uint8Array,
  sources: PageSource[],
  pages: DocumentPage[],
  overlays: Overlay[],
  pageId?: string | readonly string[],
  formValues: FormValues = {},
  secure = pages.some(page => page.redacted),
) {
  if (pageId !== undefined) {
    const ids = new Set(typeof pageId === 'string' ? [pageId] : pageId), available = new Set(pages.map(page => page.id))
    if (!ids.size || [...ids].some(id => !available.has(id)))
      throw new Error('Bitte gültige Seiten zum Extrahieren auswählen.')
    const chosen = pages.filter(page => ids.has(page.id))
    const indices = new Map(chosen.map((page, index) => [page.id, index]))
    const mapped = overlays.filter(overlay => indices.has(pages[overlay.pageIndex]?.id))
      .map(overlay => ({ ...cloneOverlay(overlay), pageIndex: indices.get(pages[overlay.pageIndex].id)! }))
    return exportPdf(await composePages(original, sources, chosen, formValues, secure), mapped)
  }
  return exportPdf(await composePages(original, sources, pages, formValues, secure), overlays)
}
