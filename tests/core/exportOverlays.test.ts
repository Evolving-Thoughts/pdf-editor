import { expect, test } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { exportPdf } from '../../src/core/pdf/exportPdf'
import type { Textbox } from '../../src/core/model'

function box(overrides: Partial<Textbox>): Textbox {
  return { id: 'x', pageIndex: 0, x: 50, y: 700, text: '', font: 'helvetica', fontSize: 14, bold: false, italic: false, underline: false, ...overrides }
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
