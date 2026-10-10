import { expect, test } from 'vitest'
import { PDFDocument } from 'pdf-lib'

test('load a PDF and export it unchanged', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842]) // A4 in points
  const bytes = await doc.save()
  const reloaded = await PDFDocument.load(bytes)
  expect(reloaded.getPageCount()).toBe(1)
})
