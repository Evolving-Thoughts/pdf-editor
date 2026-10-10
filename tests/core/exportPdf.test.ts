import { expect, test } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { exportPdf } from '../../src/core/pdf/exportPdf'

test('exportPdf preserves page count and page sizes', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  doc.addPage([420, 595])
  const bytes = await exportPdf(await doc.save())
  const reloaded = await PDFDocument.load(bytes)
  expect(reloaded.getPageCount()).toBe(2)
  expect(reloaded.getPage(1).getSize()).toEqual({ width: 420, height: 595 })
})
