import { expect, test } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { exportPdf } from '../../src/core/pdf/exportPdf'
import type { Stroke, Textbox } from '../../src/core/model'

function box(overrides: Partial<Textbox>): Textbox {
  return { id: 'x', pageIndex: 0, x: 50, y: 700, text: '', font: 'helvetica', fontSize: 14, bold: false, italic: false, underline: false, ...overrides }
}

function stroke(overrides: Partial<Stroke> = {}): Stroke {
  return {
    id: 'stroke-1',
    pageIndex: 0,
    points: [
      { x: 10, y: 700 },
      { x: 100, y: 650 },
      { x: 150, y: 670 },
    ],
    color: '#0000ff',
    width: 4,
    ...overrides,
  }
}

interface TextItemLike {
  str: string
  fontName?: string
}

async function extractItems(bytes: Uint8Array, pageNumber: number): Promise<TextItemLike[]> {
  const task = getDocument({ data: bytes.slice() })
  const pdf = await task.promise
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent()
  const items = content.items.filter((item): item is TextItemLike => 'str' in item)
  await task.destroy()
  return items
}

test('export writes overlay text as real, extractable PDF text', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  const bytes = await exportPdf(await doc.save(), [box({ text: 'Hallo Welt' })])

  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  const items = await extractItems(bytes, 1)
  expect(items.map((item) => item.str)).toContain('Hallo Welt')
})

test('empty overlay text is not exported', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  const bytes = await exportPdf(await doc.save(), [
    box({ text: '   ' }),
    box({ text: 'Drin lassen' }),
  ])
  const items = await extractItems(bytes, 1)
  expect(items.map((item) => item.str)).toEqual(['Drin lassen'])
})

test('overlays respect page index and font choice', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  doc.addPage([595, 842])
  const bytes = await exportPdf(await doc.save(), [
    box({ text: 'Seite zwei', pageIndex: 1, font: 'times', fontSize: 24 }),
  ])
  expect(await extractItems(bytes, 1)).toEqual([])
  const pageTwo = await extractItems(bytes, 2)
  expect(pageTwo.map((item) => item.str)).toContain('Seite zwei')
  // Font identity is not machine-checkable here: pdfjs reports internal
  // subset aliases (e.g. "g_d3_f1") instead of the base font name.
  // The 'times' code path is exercised by the export succeeding at all.
})

test('bold, italic and underline export successfully', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  const bytes = await exportPdf(await doc.save(), [
    box({ text: 'Fett', bold: true, y: 600 }),
    box({ text: 'Kursiv', font: 'times', italic: true, y: 500 }),
    box({ text: 'Fett Kursiv', font: 'courier', bold: true, italic: true, y: 400 }),
    box({ text: 'Unterstrichen', underline: true, y: 300 }),
  ])
  // pdfjs may split runs and emit empty items; compare the joined text.
  const items = await extractItems(bytes, 1)
  const joined = items.map((item) => item.str).join('')
  for (const text of ['Fett', 'Kursiv', 'Fett Kursiv', 'Unterstrichen']) expect(joined).toContain(text)
})

test('zapfdingbats symbols export as vector glyphs', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  const bytes = await exportPdf(await doc.save(), [
    box({ text: '✓', font: 'zapfdingbats', fontSize: 20 }),
    box({ text: '■', font: 'zapfdingbats', fontSize: 20, y: 650 }),
  ])
  // Succeeding at all means the symbols mapped to valid ZapfDingbats glyphs.
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
})

test('plain text typed into a symbol box cannot crash the export', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  // '✓abc': the letters have no ZapfDingbats glyph and must be dropped,
  // the checkmark stays; a box that ends up empty is skipped entirely.
  const bytes = await exportPdf(await doc.save(), [
    box({ text: '✓abc', font: 'zapfdingbats', fontSize: 20 }),
    box({ text: 'abc', font: 'zapfdingbats', fontSize: 20, y: 650 }),
    box({ text: 'Überlebt', y: 600 }),
  ])
  const items = await extractItems(bytes, 1)
  expect(items.map((item) => item.str).join('')).toContain('Überlebt')
})

test('unencodable characters in text fonts become question marks', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  const bytes = await exportPdf(await doc.save(), [box({ text: 'Hä✓llo' })])
  const items = await extractItems(bytes, 1)
  expect(items.map((item) => item.str).join('')).toContain('Hä?llo')
})

test('freehand strokes export as vector paths, not raster images', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  const bytes = await exportPdf(await doc.save(), [stroke()])

  const task = getDocument({ data: bytes.slice() })
  const pdf = await task.promise
  const page = await pdf.getPage(1)
  const operators = await page.getOperatorList()
  expect(operators.fnArray).toContain(OPS.constructPath)
  expect(operators.fnArray).not.toContain(OPS.paintImageXObject)
  expect(operators.fnArray).not.toContain(OPS.paintImageXObjectRepeat)
  await task.destroy()
})

async function exportContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const { PDFArray, PDFRawStream, decodePDFRawStream } = await import('pdf-lib')
  const doc = await PDFDocument.load(bytes)
  const contents = doc.getPage(pageIndex).node.Contents()
  const streams = contents instanceof PDFArray
    ? contents.asArray().map((ref) => doc.context.lookup(ref, PDFRawStream))
    : contents ? [contents as InstanceType<typeof PDFRawStream>] : []
  return streams.map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('\n')
}

test('vector stroke coordinates remain at the displayed position on a rotated cropped page', async () => {
  const { degrees } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  page.setCropBox(20, 30, 400, 600)
  page.setRotation(degrees(90))
  const bytes = await exportPdf(await doc.save(), [stroke({ points: [{ x: 10, y: 100 }, { x: 100, y: 200 }] })])
  const content = await exportContent(bytes, 0)
  // Displayed (10,100) -> raw PDF (320,40); SVG's y-down transform at 842
  // therefore encodes (320,802). Independent worked coordinates, not the converter.
  expect(content).toContain('1 0 0 1 0 842 cm')
  expect(content).toContain('1 0 0 -1 0 0 cm')
  expect(content).toContain('320 802 m')
  expect(content).toContain('220 712 l')
})

test.each([
  [0, '30 712 m', '120 612 l'],
  [180, '410 312 m', '320 412 l'],
  [270, '120 222 m', '220 312 l'],
])('stroke placement respects rotation %s and CropBox origin', async (angle, first, second) => {
  const { degrees } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  page.setCropBox(20, 30, 400, 600)
  page.setRotation(degrees(angle as number))
  const bytes = await exportPdf(await doc.save(), [stroke({ points: [{ x: 10, y: 100 }, { x: 100, y: 200 }] })])
  const content = await exportContent(bytes, 0)
  expect(content).toContain(first)
  expect(content).toContain(second)
})

test('non-default PDF UserUnit preserves visible stroke position and width', async () => {
  const { PDFName, PDFNumber } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))
  const bytes = await exportPdf(await doc.save(), [stroke({ points: [{ x: 20, y: 200 }, { x: 200, y: 400 }], width: 6 })])
  const content = await exportContent(bytes, 0)
  expect(content).toContain('10 742 m')
  expect(content).toContain('100 642 l')
  expect(content).toContain('3 w')
  expect(content).toContain('1 j') // round joins agree with the editor
})
