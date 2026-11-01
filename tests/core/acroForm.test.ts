import { expect, test, vi } from 'vitest'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { inspectPages, exportPageDocument } from '../../src/core/pdf/pageOperations'

test('editing a native text value exports a live editable field without changing original bytes', async () => {
  const doc = await PDFDocument.create(), page = doc.addPage([400, 600])
  const field = doc.getForm().createTextField('name'); field.setText('Ada'); field.addToPage(page, { x: 40, y: 480, width: 160, height: 26 })
  const bytes = await doc.save(), original = bytes.slice(), pages = await inspectPages(bytes, 'form')
  const result = await exportPageDocument(bytes, [], pages, [], { formValues: { [JSON.stringify(['original', 'name'])]: 'Grace' } })
  const exported = await PDFDocument.load(result)
  expect(exported.getForm().getTextField('name').getText()).toBe('Grace')
  exported.getForm().getTextField('name').setText('Further edit')
  expect((await PDFDocument.load(await exported.save())).getForm().getTextField('name').getText()).toBe('Further edit')
  expect(bytes).toEqual(original)
})

import { EditorStore } from '../../src/core/editorStore'
import { formKey, setNativeFieldValue } from '../../src/core/forms'
import { inspectNativeForms } from '../../src/core/pdf/acroForm'
import { preparePages } from '../../src/core/pdf/pageOperations'
import { rotatePage, replacePageDocument } from '../../src/core/pages'
import { normalizeA4 } from '../../src/core/pdf/normalizeA4'
async function fixture() {
  const doc = await PDFDocument.create(), first = doc.addPage([400, 600]), second = doc.addPage([400, 600]), f = doc.getForm()
  const text = f.createTextField('name'); text.setText('Ada'); text.setMaxLength(40)
  text.addToPage(first, { x: 40, y: 480, width: 160, height: 26, borderWidth: 0 }); text.addToPage(second, { x: 40, y: 480, width: 160, height: 26, borderWidth: 0 })
  const box = f.createCheckBox('agree'); box.addToPage(first, { x: 40, y: 400, width: 18, height: 18 })
  const radio = f.createRadioGroup('contact'); radio.addOptionToPage('Email', first, { x: 40, y: 350, width: 18, height: 18 }); radio.addOptionToPage('Phone', first, { x: 100, y: 350, width: 18, height: 18 }); radio.select('Email')
  const select = f.createDropdown('choice'); select.addOptions(['A', 'B']); select.select('A'); select.addToPage(first, { x: 40, y: 300, width: 160, height: 26 })
  const list = f.createOptionList('list'); list.addOptions(['One', 'Two', 'Three']); list.enableMultiselect(); list.select('One'); list.addToPage(first, { x: 240, y: 400, width: 100, height: 70 })
  const lock = f.createTextField('reference'); lock.setText('LOCK'); lock.enableReadOnly(); lock.addToPage(first, { x: 40, y: 250, width: 160, height: 26 })
  const button = f.createButton('unsupported'); button.addToPage('No scripts', first, { x: 40, y: 200, width: 80, height: 26 })
  const bytes = await doc.save(), pages = await inspectPages(bytes, 'form')
  return { bytes, pages, info: await inspectNativeForms(bytes, [], pages) }
}
test('detects shared widgets, field types, read-only fields and unsupported buttons', async () => {
  const { info } = await fixture()
  expect(info.widgets.filter(w => w.name === 'name').map(w => [w.pageIndex, w.value])).toEqual([[0, 'Ada'], [1, 'Ada']])
  expect(info.widgets.find(w => w.name === 'reference')?.readOnly).toBe(true)
  expect(info.widgets.filter(w => w.kind === 'radio').map(w => w.option)).toEqual(['Email', 'Phone'])
  expect(info.widgets.find(w => w.name === 'list')?.multiple).toBe(true)
  expect(info.unsupported).toEqual(['unsupported'])
})
test('native edits share values across widgets, coalesce one typing session and undo independently of page operations', async () => {
  const { info, pages } = await fixture(), field = info.widgets.find(w => w.name === 'name')!, store = new EditorStore()
  store.restore({ overlays: [], pages: pages })
  store.dispatch(setNativeFieldValue(store.state, field, 'G', 'focus-1')); store.dispatch(setNativeFieldValue(store.state, field, 'Grace', 'focus-1'))
  store.dispatch(rotatePage(store.state, pages[0].id, true)); store.undo()
  expect(store.state.formValues?.[field.key]).toBe('Grace'); store.undo(); expect(store.state.formValues).toBeUndefined()
  store.redo(); expect(store.state.formValues?.[field.key]).toBe('Grace')
  expect(() => store.dispatch(setNativeFieldValue(store.state, info.widgets.find(w => w.name === 'reference')!, 'changed'))).toThrow(/schreibgeschützt/)
  expect(() => store.dispatch(setNativeFieldValue(store.state, field, 'x'.repeat(41)))).toThrow(/Feldlänge/)
  expect(() => store.dispatch(setNativeFieldValue(store.state, info.widgets.find(w => w.name === 'choice')!, ['invalid']))).toThrow(/auswahl/)
})
test('exports text, checkbox, radio and multiple choices as live values, including subset extraction', async () => {
  const { bytes, pages } = await fixture()
  const values = { [formKey('original', 'name')]: 'Grace', [formKey('original', 'agree')]: true, [formKey('original', 'contact')]: 'Phone', [formKey('original', 'choice')]: ['B'], [formKey('original', 'list')]: ['Two', 'Three'] }
  const full = (await PDFDocument.load(await exportPageDocument(bytes, [], pages, [], { formValues: values }))).getForm()
  expect(full.getTextField('name').getText()).toBe('Grace'); expect(full.getCheckBox('agree').isChecked()).toBe(true)
  expect(full.getRadioGroup('contact').getSelected()).toBe('Phone'); expect(full.getDropdown('choice').getSelected()).toEqual(['B']); expect(full.getOptionList('list').getSelected()).toEqual(['Two', 'Three'])
  expect(full.getTextField('reference').getText()).toBe('LOCK')
  const subset = await PDFDocument.load(await exportPageDocument(bytes, [], pages, [], { pageId: pages[1].id, formValues: values }))
  expect(subset.getForm().getTextField('name').getText()).toBe('Grace'); expect(subset.getForm().getTextField('name').acroField.getWidgets()).toHaveLength(1)
})
test('maps widgets through crop origin, rotation and UserUnit with literal expected display coordinates', async () => {
  const { bytes, pages } = await fixture(); const p = { ...pages[0], box: { x: 20, y: 50, width: 350, height: 500 }, unit: 2, rotation: 90 }
  const info = await inspectNativeForms(bytes, [], [p]); const widget = info.widgets.find(w => w.name === 'name')!
  expect([widget.x, widget.y, widget.width, widget.height, widget.rotation, widget.inputWidth, widget.inputHeight]).toEqual([860, 40, 52, 320, 90, 320, 52])
})
test('identical names in an attached PDF use separate stable source keys', async () => {
  const { bytes, pages } = await fixture(), imported = await preparePages(bytes, 'attachment')
  const result = await PDFDocument.load(await exportPageDocument(bytes, [imported.source], [...pages, ...imported.pages], [], { formValues: { [formKey(imported.source.id, 'name')]: 'Attached' } }))
  expect(result.getForm().getTextField('name').getText()).toBe('Ada')
  expect(result.getForm().getFields().filter(f => f.constructor.name === 'PDFTextField').map(f => (f as import('pdf-lib').PDFTextField).getText())).toContain('Attached')
})
test('A4 bakes values into a new editable source and undo restores the original source keys', async () => {
  const { bytes, pages, info } = await fixture(), store = new EditorStore(); store.restore({ overlays: [], pages: pages })
  const field = info.widgets.find(w => w.name === 'name')!; store.dispatch(setNativeFieldValue(store.state, field, 'Grace'))
  const normalized = await normalizeA4({ original: bytes, state: { pages: pages, overlays: [], formValues: store.state.formValues } })
  store.dispatch(replacePageDocument(store.state, normalized.pages, normalized.source, [])); expect(store.state.formValues).toBeUndefined()
  expect((await PDFDocument.load(normalized.source.bytes)).getForm().getTextField('name').getText()).toBe('Grace')
  store.undo(); expect(store.state.formValues?.[field.key]).toBe('Grace')
  const after = await inspectNativeForms(bytes, [normalized.source], normalized.pages); expect(after.widgets.find(w => w.name === 'name')?.key).toBe(formKey(normalized.source.id, 'name'))
})

test('checkbox changes are separate undo steps even while focus stays on the control', async () => {
  const { info } = await fixture(), store = new EditorStore(), field = info.widgets.find(w => w.name === 'agree')!
  store.dispatch(setNativeFieldValue(store.state, field, true, 'same-focus')); store.dispatch(setNativeFieldValue(store.state, field, false, 'same-focus'))
  store.undo(); expect(store.state.formValues?.[field.key]).toBe(true); store.undo(); expect(store.state.formValues).toBeUndefined()
})
test('unsupported export glyphs fail clearly and never change the source or stored value', async () => {
  const { bytes, pages } = await fixture(), copy = bytes.slice(), value = { [formKey('original', 'name')]: 'Unsupported 🙂' }
  await expect(exportPageDocument(bytes, [], pages, [], { formValues: value })).rejects.toThrow(/Standardschrift/)
  expect(value[formKey('original', 'name')]).toBe('Unsupported 🙂'); expect(bytes).toEqual(copy)
})

test('automatic native text font size follows the generated editable field appearance', async () => {
  const { bytes, pages } = await fixture(), doc = await PDFDocument.load(bytes)
  doc.getForm().getTextField('name').removeMaxLength(); doc.getForm().getTextField('name').setFontSize(0)
  const auto = await doc.save({ updateFieldAppearances: false }), widget = (await inspectNativeForms(auto, [], pages)).widgets.find(w => w.name === 'name')!
  const value = 'A long native name fitting its original field'
  const { nativeDisplayFontSize } = await import('../../src/core/pdf/acroForm')
  const result = await PDFDocument.load(await exportPageDocument(auto, [], pages, [], { formValues: { [widget.key]: value } }))
  const actual = Number(/([\d.]+)\s+Tf/.exec(result.getForm().getTextField('name').acroField.getDefaultAppearance()!)![1])
  expect(widget.autoFont).toBe(true); expect(nativeDisplayFontSize(widget, value)).toBe(actual)
})


test('known form-less pages skip inspection without loading their PDFs', async () => {
  const doc = await PDFDocument.create(); doc.addPage([400, 600])
  const bytes = await doc.save(), pages = await inspectPages(bytes, 'plain')
  const load = vi.spyOn(PDFDocument, 'load')
  try {
    for (const plan of [pages, pages.map(page => ({ ...page, rotation: 90 }))]) {
      expect(await inspectNativeForms(bytes, [], plan)).toEqual({ widgets: [], unsupported: [] })
    }
    expect(load).not.toHaveBeenCalled()
  } finally { load.mockRestore() }
})
test('mixed documents inspect the form source but skip the form-less source', async () => {
  const form = await fixture(), imported = await preparePages(form.bytes, 'attachment')
  const doc = await PDFDocument.create(); doc.addPage([400, 600])
  const bytes = await doc.save(), plain = await inspectPages(bytes, 'plain')
  const load = vi.spyOn(PDFDocument, 'load')
  try {
    const info = await inspectNativeForms(bytes, [imported.source], [...plain, ...imported.pages])
    expect(load).toHaveBeenCalledTimes(1)
    expect(info.widgets.filter(widget => widget.name === 'name').map(widget => widget.pageIndex)).toEqual([1, 2])
  } finally { load.mockRestore() }
})
test('XFA warnings and unknown legacy form metadata still trigger inspection', async () => {
  const doc = await PDFDocument.create(); doc.addPage([400, 600])
  doc.getForm().acroForm.dict.set(PDFName.of('XFA'), PDFString.of('synthetic XFA'))
  const bytes = await doc.save(), pages = await inspectPages(bytes, 'xfa')
  expect(pages[0].hasForms).toBe(false); expect(pages[0].hasXfa).toBe(true)
  expect((await inspectNativeForms(bytes, [], pages)).unsupported).toEqual(['XFA-Formular'])
  const legacy = await fixture()
  const unknown = legacy.pages.map(page => ({ ...page, hasForms: undefined }))
  expect((await inspectNativeForms(legacy.bytes, [], unknown)).widgets.filter(widget => widget.name === 'name')).toHaveLength(2)
})
