import { expect, test } from 'vitest'
import { decodePDFRawStream, PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describeDocument, optimizePdfStructure } from '../../src/core/pdf/optimizePdf'
import { inspectStructures } from '../../src/core/pdf/preflight'
import { PNG_DATA_URL } from '../imageFixtures.js'

const key = PDFName.of

async function readable(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice() })
  const pdf = await task.promise
  const pages = []
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number)
    const text = (await page.getTextContent()).items.map(item => ('str' in item ? item.str : '')).join('|')
    const operators = await page.getOperatorList()
    pages.push({
      text,
      images: operators.fnArray.filter(op => op === OPS.paintImageXObject).length,
      paths: operators.fnArray.filter(op => op === OPS.constructPath).length,
      view: page.view,
      rotate: page.rotate,
    })
  }
  const metadata = await pdf.getMetadata()
  await task.destroy()
  return { pages, title: (metadata.info as { Title?: string }).Title }
}

/** Unfiltered content, an abandoned object and two identical stream copies: all removable. */
async function bloated() {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  doc.setTitle('Größenprobe')
  const first = doc.addPage([300, 300]), second = doc.addPage([300, 300])
  first.drawText('Erste Seite mit Äpfeln', { x: 20, y: 250, size: 12, font })
  first.drawRectangle({ x: 20, y: 20, width: 100, height: 60 })
  second.drawText('Zweite Seite', { x: 20, y: 250, size: 12, font })
  const payload = new TextEncoder().encode('q 1 0 0 1 0 0 cm Q\n'.repeat(4000))
  const contents = [first, second].map(page => {
    const stream = doc.context.register(PDFRawStream.of(doc.context.obj({}), payload))
    page.node.addContentStream(stream)
    return stream
  })
  doc.context.register(PDFRawStream.of(doc.context.obj({}), new Uint8Array(20_000).fill(65)))
  expect(contents).toHaveLength(2)
  return doc.save({ useObjectStreams: false })
}

test('makes a wasteful PDF smaller and keeps text, vectors, pages and metadata', async () => {
  const input = await bloated(), result = await optimizePdfStructure(input)
  expect(result.outcome).toBe('smaller')
  expect(result.bytes.length).toBeLessThan(input.length / 3)
  const before = await readable(input)
  expect(before.pages[0].text).toContain('Äpfeln')
  expect(before.title).toBe('Größenprobe')
  expect(await readable(result.bytes)).toEqual(before)
})

test('removes objects nothing refers to', async () => {
  const result = await optimizePdfStructure(await bloated())
  const doc = await PDFDocument.load(result.bytes)
  const leftovers = doc.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream && object.contents.length === 20_000)
  expect(leftovers).toEqual([])
})

test('identical streams become one object and still draw on both pages', async () => {
  const input = await bloated(), result = await optimizePdfStructure(input)
  const count = (doc: PDFDocument) => doc.context.enumerateIndirectObjects().filter(([, object]) => {
    if (!(object instanceof PDFRawStream)) return false
    return decodePDFRawStream(object).decode().length === 19 * 4000
  }).length
  expect(count(await PDFDocument.load(input))).toBe(2)
  expect(count(await PDFDocument.load(result.bytes))).toBe(1)
  expect((await readable(result.bytes)).pages[1].text).toContain('Zweite Seite')
})

test('image pixels are byte-identical after optimizing', async () => {
  const doc = await PDFDocument.create(), image = await doc.embedPng(PNG_DATA_URL)
  doc.addPage([300, 300]).drawImage(image, { x: 10, y: 10, width: 200, height: 200 })
  doc.context.register(PDFRawStream.of(doc.context.obj({}), new Uint8Array(60_000).fill(66)))
  const input = await doc.save({ useObjectStreams: false })
  const images = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).context.enumerateIndirectObjects().flatMap(([, object]) =>
    object instanceof PDFRawStream && object.dict.get(key('Subtype'))?.toString() === '/Image' ? [{ width: object.dict.get(key('Width'))?.toString(), height: object.dict.get(key('Height'))?.toString(), pixels: Array.from(decodePDFRawStream(object).decode()) }] : [])
  const result = await optimizePdfStructure(input)
  expect(result.outcome).toBe('smaller')
  expect(await images(result.bytes)).toEqual(await images(input))
  expect((await readable(result.bytes)).pages[0].images).toBe(1)
})

test('an already optimized file comes back unchanged, as the same bytes', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([300, 300])
  const input = await doc.save({ useObjectStreams: true })
  const again = (await optimizePdfStructure(input)).bytes
  const result = await optimizePdfStructure(again)
  expect(result.outcome).toBe('not-smaller')
  expect(result.bytes).toBe(again)
})

test('forms, outline, tags and attachments survive', async () => {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 300])
  doc.getForm().createTextField('kunde').addToPage(page, { x: 20, y: 20, width: 100, height: 20 })
  doc.getForm().getTextField('kunde').setText('Müller')
  const item = doc.context.register(doc.context.obj({ Title: PDFString.of('Kapitel'), Dest: doc.context.obj([page.ref, key('Fit')]) }))
  doc.catalog.set(key('Outlines'), doc.context.register(doc.context.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 })))
  doc.catalog.set(key('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: 'StructTreeRoot' })))
  await doc.attach(new Uint8Array(40_000).fill(7), 'daten.bin', { mimeType: 'application/octet-stream' })
  doc.context.register(PDFRawStream.of(doc.context.obj({}), new Uint8Array(40_000).fill(1)))
  const input = await doc.save({ useObjectStreams: false })
  const result = await optimizePdfStructure(input)
  expect(result.outcome).toBe('smaller')
  const states = async (bytes: Uint8Array) => (await inspectStructures(bytes)).map(item => [item.kind, item.state, item.count])
  expect(await states(result.bytes)).toEqual(await states(input))
  expect((await PDFDocument.load(result.bytes)).getForm().getTextField('kunde').getText()).toBe('Müller')
})

test('the description notices changed text content, even when only compression differs elsewhere', async () => {
  const make = async (text: string) => {
    const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
    doc.addPage([200, 200]).drawText(text, { x: 10, y: 100, size: 12, font })
    return PDFDocument.load(await doc.save())
  }
  expect(describeDocument(await make('gleich'))).toBe(describeDocument(await make('gleich')))
  expect(describeDocument(await make('gleich'))).not.toBe(describeDocument(await make('anders')))
})

test('a candidate that differs after saving is thrown away', async () => {
  const input = await bloated()
  const describe = PDFDocument.prototype.save
  // The candidate loses a page while saving, standing in for any writer defect.
  PDFDocument.prototype.save = async function (options) {
    this.removePage(1)
    return describe.call(this, options)
  }
  try {
    const result = await optimizePdfStructure(input)
    expect(result.outcome).toBe('not-verified')
    expect(result.bytes).toBe(input)
  } finally {
    PDFDocument.prototype.save = describe
  }
})

test('cancelling ends with an AbortError and no output', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(optimizePdfStructure(await bloated(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
})

test('leaves its input bytes alone', async () => {
  const input = await bloated(), copy = input.slice()
  await optimizePdfStructure(input)
  expect(input).toEqual(copy)
})
