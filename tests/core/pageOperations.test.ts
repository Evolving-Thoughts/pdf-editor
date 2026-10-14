import { expect, test } from 'vitest'
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, degrees } from 'pdf-lib'
import { composePages, imagePageBytes, inspectPages, pageSize, preparePages, textPageBytes } from '../../src/core/pdf/pageOperations'
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

test('assembled form pages preserve editable fields, widget page references and links', async () => {
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
  expect(result.getForm().getTextField('name').getText()).toBe('Ada')
  result.getForm().getTextField('name').setText('Grace')
  const edited = await PDFDocument.load(await result.save())
  expect(edited.getForm().getTextField('name').getText()).toBe('Grace')
  expect(result.getForm().getTextField('name').acroField.getWidgets()[0].P()).toEqual(result.getPage(0).ref)
  const annots = result.getPage(0).node.Annots()!
  expect(annots.size()).toBe(2)
  expect(result.context.lookup(annots.get(1)).toString()).toContain('/Link')
  expect(result.getPage(0).getRotation().angle).toBe(90)
})

test('inserted text pages use reference dimensions on every paginated page', async () => {
  const doc = await PDFDocument.load(await textPageBytes('Notiz\n'.repeat(100), { width: 612, height: 792 }))
  expect(doc.getPageCount()).toBeGreaterThan(1)
  expect(doc.getPages().map(p => p.getSize())).toEqual(Array(doc.getPageCount()).fill({ width: 612, height: 792 }))
})

test('deletion and extraction remove only omitted widgets of a shared field, including widgets without P', async () => {
  const doc = await PDFDocument.create()
  const first = doc.addPage([612, 792]), second = doc.addPage([612, 792])
  const form = doc.getForm()
  const shared = form.createTextField('person.name')
  shared.setText('Ada')
  shared.addToPage(first, { x: 30, y: 100, width: 120, height: 20 })
  shared.addToPage(second, { x: 30, y: 150, width: 120, height: 20 })
  shared.acroField.getWidgets()[1].dict.delete(PDFName.of('P'))
  const removed = form.createTextField('only.first')
  removed.setText('removed'); removed.addToPage(first, { x: 30, y: 50, width: 120, height: 20 })
  const bytes = await doc.save(), plan = await inspectPages(bytes, 'forms')
  const out = await PDFDocument.load(await composePages(bytes, [], [{ ...plan[1], rotation: 90, box: { x: 20, y: 30, width: 550, height: 700 } }]))
  expect(out.getForm().getFields().map(f => f.getName())).toEqual(['person.name'])
  const field = out.getForm().getTextField('person.name')
  expect(field.acroField.getWidgets()).toHaveLength(1)
  expect(field.acroField.getWidgets()[0].P()).toEqual(out.getPage(0).ref)
  field.setText('Edited after crop')
  expect((await PDFDocument.load(await out.save())).getForm().getTextField('person.name').getText()).toBe('Edited after crop')
})

test('attached form PDFs keep distinct same-named fields and all widgets refer to the reordered output pages', async () => {
  const make = async (value: string) => {
    const doc = await PDFDocument.create(), page = doc.addPage([612, 792])
    const field = doc.getForm().createTextField('name')
    field.setText(value); field.addToPage(page, { x: 20, y: 100, width: 150, height: 25 })
    const check = doc.getForm().createCheckBox('accepted'); check.addToPage(page); check.check()
    const choice = doc.getForm().createDropdown('choice'); choice.addOptions(['A', 'B']); choice.select('B'); choice.addToPage(page)
    return doc.save()
  }
  const original = await make('Original'), extra = await make('Attached')
  const a = await inspectPages(original, 'base'), b = await inspectPages(extra, 'attached', 'extra')
  const out = await PDFDocument.load(await composePages(original, [{ id: 'extra', bytes: extra.slice().buffer }], [b[0], a[0]]))
  const names = out.getForm().getFields().map(f => f.getName())
  expect(new Set(names).size).toBe(6)
  expect(out.getForm().getTextField('name').getText()).toBe('Original')
  expect(out.getForm().getTextField('name_2').getText()).toBe('Attached')
  expect(out.getForm().getCheckBox('accepted').isChecked()).toBe(true)
  expect(out.getForm().getDropdown('choice').getSelected()).toEqual(['B'])
  expect(out.getForm().getTextField('name').acroField.getWidgets()[0].P()).toEqual(out.getPage(1).ref)
  expect(out.getForm().getTextField('name_2').acroField.getWidgets()[0].P()).toEqual(out.getPage(0).ref)
  out.getForm().getTextField('name').setText('New original')
  out.getForm().getTextField('name_2').setText('New attached')
  const reread = await PDFDocument.load(await out.save())
  expect(reread.getForm().getTextField('name').getText()).toBe('New original')
  expect(reread.getForm().getTextField('name_2').getText()).toBe('New attached')
})

test('white image-page background uses reference dimensions without baking image content into it', async () => {
  const out = await PDFDocument.load(await imagePageBytes({ width: 612, height: 792 }))
  expect(out.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
  expect(out.getPage(0).node.Contents()).toBeUndefined()
})

test('form default-resource renaming does not change shared page resources or native text', async () => {
  const doc = await PDFDocument.create(), page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  page.drawText('Native page text', { x: 30, y: 700, font })
  const fonts = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
  const key = fonts.keys()[0]
  const field = doc.getForm().createTextField('name')
  field.setText('Ada'); field.addToPage(page, { x: 30, y: 200, width: 150, height: 25 })
  const form = doc.getForm().acroForm.dict
  form.set(PDFName.of('DR'), page.node.Resources()!)
  form.set(PDFName.of('DA'), PDFString.of(`${key} 12 Tf 0 g`))
  field.acroField.dict.delete(PDFName.of('DA'))
  const bytes = await doc.save({ updateFieldAppearances: false }), plan = await inspectPages(bytes, 'shared-resources')
  const out = await PDFDocument.load(await composePages(bytes, [], [{ ...plan[0], rotation: 90 }]))
  expect(out.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict).has(key)).toBe(true)
  const appearance = out.getForm().getTextField('name').acroField.getDefaultAppearance()!
  expect(appearance).toBe(`/Source0_${key.decodeText()} 12 Tf 0 g`)
  const resources = out.getForm().acroForm.dict.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
  const reference = resources.lookup(PDFName.of(`Source0_${key.decodeText()}`), PDFDict)
  expect(reference.lookup(PDFName.of('BaseFont'), PDFName).decodeText()).toBe('Times-Roman')
})

test('page operations reject unsupported XFA instead of silently dropping its form data', async () => {
  const doc = await PDFDocument.create(); doc.addPage([612, 792])
  doc.getForm().acroForm.dict.set(PDFName.of('XFA'), PDFString.of('unsupported XFA data'))
  const bytes = await doc.save({ updateFieldAppearances: false })
  const plan = [{ id: 'page', name: 'XFA', sourceId: 'original', sourceIndex: 0, box: { x: 0, y: 0, width: 612, height: 792 }, unit: 1, rotation: 90 }]
  await expect(composePages(bytes, [], plan)).rejects.toThrow('XFA-Formulare')
  await expect(preparePages(bytes, 'XFA attachment')).rejects.toThrow('XFA-Formulare')
  expect((await inspectPages(bytes, 'original'))[0].hasXfa).toBe(true)
})

test('form fields with no visible widget retain their values during page operations', async () => {
  const doc = await PDFDocument.create(); doc.addPage([612, 792])
  doc.getForm().createTextField('hidden.total').setText('42')
  const bytes = await doc.save(), plan = await inspectPages(bytes, 'hidden')
  const out = await PDFDocument.load(await composePages(bytes, [], [{ ...plan[0], rotation: 90 }]))
  expect(out.getForm().getTextField('hidden.total').getText()).toBe('42')
})
