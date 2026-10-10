import { expect, test } from 'vitest'
import { PDFDocument } from 'pdf-lib'

test('PDF laden und unverändert exportieren', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842]) // A4 in Punkten
  const bytes = await doc.save()
  const reloaded = await PDFDocument.load(bytes)
  expect(reloaded.getPageCount()).toBe(1)
})
