import { expect, test } from 'vitest'
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib'
import { composePages, inspectPages, pageSize, textPageBytes } from '../../src/core/pdf/pageOperations'
import { exportPdf } from '../../src/core/pdf/exportPdf'
const original = async () => {
  const doc = await PDFDocument.create()
  doc.addPage([200, 300])
  const p = doc.addPage([400, 250])
  p.setRotation(degrees(90))
  p.setCropBox(20, 30, 300, 200)
  p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))
  return doc.save()
}
test('compose preserves mixed source sizes, crop offsets, UserUnit and rotation in requested order', async () => {
  const bytes = await original(),
    pages = await inspectPages(bytes, 'original')
  expect(pageSize(pages[1])).toEqual({ width: 400, height: 600 })
  const extra = await textPageBytes('Anlage')
  const sourcePages = await inspectPages(extra, 'extra', 'extra')
  const composed = await composePages(
    bytes,
    [{ id: 'extra', bytes: extra.slice().buffer }],
    [pages[1], sourcePages[0], pages[0]],
  )
  const reread = await inspectPages(composed, 'out')
  expect(reread.map(pageSize)).toEqual([
    { width: 400, height: 600 },
    { width: 595.28, height: 841.89 },
    { width: 200, height: 300 },
  ])
  expect(reread[0].box).toEqual({ x: 20, y: 30, width: 300, height: 200 })
})
test('single-page extraction is a valid PDF with text overlays and does not modify source bytes', async () => {
  const bytes = await original(),
    copy = bytes.slice(),
    pages = await inspectPages(bytes, 'x')
  const single = await composePages(bytes, [], [pages[1]])
  const exported = await exportPdf(single, [
    {
      id: 't',
      pageIndex: 0,
      x: 30,
      y: 60,
      text: 'Korrektur',
      font: 'helvetica',
      fontSize: 12,
      bold: false,
      italic: false,
      underline: false,
    },
  ])
  const doc = await PDFDocument.load(exported)
  expect(doc.getPageCount()).toBe(1)
  expect(doc.getPage(0).getRotation().angle).toBe(90)
  expect(doc.getPage(0).node.Resources()?.toString()).toContain('Helvetica')
  expect(bytes).toEqual(copy)
})
test('long text paginates on A4 rather than clipping; unsupported font glyphs do not break import', async () => {
  const bytes = await textPageBytes('Eine Notiz 😃\n'.repeat(100)),
    doc = await PDFDocument.load(bytes)
  expect(doc.getPageCount()).toBe(3)
  expect(doc.getPage(0).getWidth()).toBe(595.28)
  await expect(textPageBytes('  ')).rejects.toThrow('Text eingeben')
  await expect(composePages(bytes, [], [])).rejects.toThrow('mindestens eine')
  await expect(
    composePages(bytes, [], [{ ...(await inspectPages(bytes, 'x'))[0], sourceId: 'missing' }]),
  ).rejects.toThrow('Quelldaten')
})

test('unchanged page plans preserve original document metadata and existing AcroForm fields', async () => {
  const doc = await PDFDocument.create(),
    page = doc.addPage([200, 300])
  doc.setTitle('Original metadata')
  const field = doc.getForm().createTextField('name')
  field.setText('Ada')
  field.addToPage(page, { x: 20, y: 100, width: 120, height: 20 })
  const bytes = await doc.save(),
    plan = await inspectPages(bytes, 'original')
  const out = await PDFDocument.load(await composePages(bytes, [], plan))
  expect(out.getTitle()).toBe('Original metadata')
  expect(out.getForm().getTextField('name').getText()).toBe('Ada')
})

test('assembled form pages keep appearances without dangling widget references or losing links', async () => {
  const doc = await PDFDocument.create(),
    page = doc.addPage([200, 300])
  const field = doc.getForm().createTextField('name')
  field.setText('Ada')
  field.addToPage(page, { x: 20, y: 150, width: 120, height: 20 })
  const link = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [20, 20, 100, 40],
      A: { S: 'URI', URI: 'https://example.com' },
    }),
  )
  page.node.addAnnot(link)
  const bytes = await doc.save(),
    plan = await inspectPages(bytes, 'form')
  const result = await PDFDocument.load(await composePages(bytes, [], [{ ...plan[0], rotation: 90 }]))
  expect(result.getForm().getFields()).toHaveLength(0)
  const annots = result.getPage(0).node.Annots()!
  expect(annots.size()).toBe(1)
  expect(result.context.lookup(annots.get(0)).toString()).toContain('/Link')
  expect(result.getPage(0).node.Resources()?.toString()).toContain('FlatWidget')
})
