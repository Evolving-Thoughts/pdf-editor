import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from 'pdf-lib'
import { cloneOverlay, createId, type Overlay } from '../model'
import { exportPdf } from './exportPdf'
import { pageSize, type DocumentPage, type PageSource } from '../pages'
import { importImage } from '../images/importImage'

export async function inspectPages(
  bytes: Uint8Array,
  name: string,
  sourceId = 'original',
): Promise<DocumentPage[]> {
  const doc = await PDFDocument.load(bytes)
  const hasForms = doc.getForm().getFields().length > 0
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
      name: `${name} · ${index + 1}`,
      sourceId,
      sourceIndex: index,
      box,
      unit,
      rotation,
    }
  })
}

/** Base content only. Overlays remain editable and are applied by exportPdf afterwards. */
export async function composePages(
  original: Uint8Array,
  sources: PageSource[],
  pages: DocumentPage[],
): Promise<Uint8Array> {
  if (!pages.length) throw new Error('Ein PDF muss mindestens eine Seite enthalten.')
  // An ordinary overlay edit must not rebuild the page tree: preserve forms,
  // metadata, outlines and other document-level structures when no page changed.
  if (pages.every((page, index) => page.sourceId === 'original' && page.sourceIndex === index)) {
    const initial = await inspectPages(original, 'original')
    if (
      initial.length === pages.length &&
      initial.every(
        (page, index) =>
          JSON.stringify(page.box) === JSON.stringify(pages[index].box) &&
          page.unit === pages[index].unit &&
          page.rotation === pages[index].rotation,
      )
    )
      return original.slice()
  }

  const output = await PDFDocument.create(),
    loaded = new Map<string, PDFDocument>()
  for (const page of pages) {
    let source = loaded.get(page.sourceId)
    if (!source) {
      const bytes =
        page.sourceId === 'original' ? original : sources.find((s) => s.id === page.sourceId)?.bytes
      if (!bytes) throw new Error('Quelldaten einer Seite fehlen.')
      source = await PDFDocument.load(bytes)
      const form = source.getForm(),
        fields = form.getFields()
      if (fields.length) {
        // pdf-lib 1.17.1 removes appearance refs, not the actual widget refs,
        // from Annots during flatten(). Capture and remove those widgets too.
        const widgets = fields.flatMap((field) =>
          field.acroField.getWidgets().map((widget) => source!.context.getObjectRef(widget.dict)),
        )
        form.flatten({ updateFieldAppearances: false })
        for (const page of source.getPages()) for (const ref of widgets) if (ref) page.node.removeAnnot(ref)
      }
      loaded.set(page.sourceId, source)
    }
    const [copied] = await output.copyPages(source, [page.sourceIndex])
    copied.setRotation(degrees(page.rotation))
    copied.setCropBox(page.box.x, page.box.y, page.box.width, page.box.height)
    copied.node.set(PDFName.of('UserUnit'), PDFNumber.of(page.unit))
    output.addPage(copied)
  }
  return output.save()
}
export async function imagePageBytes(image: {
  dataUrl: string
  pixelWidth: number
  pixelHeight: number
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create(),
    embedded = await doc.embedPng(image.dataUrl)
  // Local images have no dependable physical size; use 96 CSS pixels per inch.
  const width = image.pixelWidth * 0.75,
    height = image.pixelHeight * 0.75
  const page = doc.addPage([width, height])
  page.drawImage(embedded, { x: 0, y: 0, width, height })
  return doc.save()
}
export async function textPageBytes(text: string): Promise<Uint8Array> {
  if (!text.trim()) throw new Error('Bitte zuerst Text eingeben.')
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica)
  let page = doc.addPage([595.28, 841.89]),
    y = 790
  const line = (value: string) => {
    if (y < 50) {
      page = doc.addPage([595.28, 841.89])
      y = 790
    }
    page.drawText(value, { x: 50, y, size: 12, font })
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
      if (font.widthOfTextAtSize(current + safe, 12) > 495) {
        line(current)
        current = ''
      }
      current += safe
    }
    line(current)
  }
  return doc.save()
}
export async function importPageFile(file: File): Promise<{ pages: DocumentPage[]; source: PageSource }> {
  let bytes: Uint8Array
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf')
    bytes = new Uint8Array(await file.arrayBuffer())
  else bytes = await imagePageBytes(await importImage(file))
  return preparePages(bytes, file.name)
}
export async function preparePages(bytes: Uint8Array, name: string) {
  const id = createId(),
    pages = await inspectPages(bytes, name, id)
  if (!pages.length) throw new Error('Die Datei enthält keine Seiten.')
  return { pages, source: { id, bytes: bytes.slice().buffer as ArrayBuffer } }
}
export { pageSize }

export async function exportPageDocument(
  original: Uint8Array,
  sources: PageSource[],
  pages: DocumentPage[],
  overlays: Overlay[],
  pageId?: string,
) {
  if (pageId) {
    const index = pages.findIndex((p) => p.id === pageId)
    if (index < 0) throw new Error('Seite nicht gefunden.')
    return exportPdf(
      await composePages(original, sources, [pages[index]]),
      overlays.filter((o) => o.pageIndex === index).map((o) => ({ ...cloneOverlay(o), pageIndex: 0 })),
    )
  }
  return exportPdf(await composePages(original, sources, pages), overlays)
}
