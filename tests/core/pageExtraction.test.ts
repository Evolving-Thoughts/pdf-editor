import { expect, test } from 'vitest'
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { exportPageDocument, inspectPages } from '../../src/core/pdf/pageOperations'
import type { Textbox } from '../../src/core/model'
test('multi-page extraction follows document order, remaps overlays and retains only selected field widgets', async () => {
  const doc = await PDFDocument.create(), sheets = [201,202,203].map(width=>doc.addPage([width,300]))
  const field = doc.getForm().createTextField('shared'); field.setText('Ada')
  sheets.forEach(page=>field.addToPage(page,{ x: 20, y: 200, width: 100, height: 20 }))
  const bytes = await doc.save(), pages = await inspectPages(bytes,'base')
  const overlays: Textbox[] = ['one','two','three'].map((text,pageIndex)=>({ id: text, text, pageIndex, x: 10, y: 100, font: 'helvetica', fontSize: 12, bold: false, italic: false, underline: false }))
  const before = structuredClone(overlays)
  const output = await PDFDocument.load(await exportPageDocument(bytes,[],pages,overlays,[pages[2].id,pages[0].id]))
  expect(output.getPages().map(p=>p.getWidth())).toEqual([201,203])
  const widgets = output.getForm().getTextField('shared').acroField.getWidgets()
  expect(widgets).toHaveLength(2); expect(widgets.map(w=>w.P())).toEqual(output.getPages().map(p=>p.ref))
  const contents = output.getPages().map(page=>{
    const value = page.node.Contents(), refs = value instanceof PDFArray ? value.asArray() : [value!]
    return refs.map(ref=>Buffer.from(decodePDFRawStream(output.context.lookup(ref,PDFRawStream)).decode()).toString()).join('\n')
  })
  expect(contents[0]).toMatch(/<6f6e65>/i); expect(contents[1]).toMatch(/<7468726565>/i)
  expect(overlays).toEqual(before)
  output.getForm().getTextField('shared').setText('Grace')
  expect((await PDFDocument.load(await output.save())).getForm().getTextField('shared').getText()).toBe('Grace')
})
test('empty and obsolete extraction selections fail rather than accidentally exporting all pages', async () => {
  const doc = await PDFDocument.create(); doc.addPage([200,300]); const bytes = await doc.save(), pages = await inspectPages(bytes,'base')
  await expect(exportPageDocument(bytes,[],pages,[],[])).rejects.toThrow()
  await expect(exportPageDocument(bytes,[],pages,[],[pages[0].id,'missing'])).rejects.toThrow()
})
