import { expect, test } from 'vitest'
import { TEXT_LINE_HEIGHT } from '../../src/core/textLayout'
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { exportPdf } from '../../src/core/pdf/exportPdf'
import { EditorStore } from '../../src/core/editorStore'
import { addTextbox, nudgeTextbox } from '../../src/core/commands'
import type { Textbox } from '../../src/core/model'

test('editor and PDF text share 1.2× line spacing', () => {
  expect(TEXT_LINE_HEIGHT).toBe(1.2)
})
test('export retains keyboard-nudged baseline and uses the same multiline spacing as the editor', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([600, 800])
  const store = new EditorStore()
  const box: Textbox = {
    id: 'text',
    pageIndex: 0,
    x: 200,
    y: 400,
    text: 'Erste Zeile\nZweite Zeile',
    font: 'helvetica',
    fontSize: 14,
    bold: false,
    italic: false,
    underline: false,
  }
  store.dispatch(addTextbox(box))
  store.dispatch(nudgeTextbox(box.id, { x: 200, y: 400 }, { x: 210, y: 405 }))
  const exported = await PDFDocument.load(await exportPdf(await doc.save(), store.state.overlays)),
    value = exported.getPage(0).node.Contents()!
  const stream = (value instanceof PDFArray ? value.asArray() : [value])
    .map((ref) =>
      new TextDecoder().decode(decodePDFRawStream(exported.context.lookup(ref, PDFRawStream)).decode()),
    )
    .join('\n')
  expect(stream).toContain('1 0 0 1 210 405 Tm')
  expect(stream).toContain('16.8 TL')
  expect(stream.match(/ Tj/g)).toHaveLength(2)
  store.undo()
  expect(store.state.overlays[0]).toMatchObject({ x: 200, y: 400 })
})

test('each underline follows its own baseline for multiline correction text', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([600, 800])
  const box: Textbox = {
    id: 'text',
    pageIndex: 0,
    x: 210,
    y: 405,
    text: 'Erste\nZweite',
    font: 'helvetica',
    fontSize: 14,
    bold: false,
    italic: false,
    underline: true,
  }
  const result = await PDFDocument.load(await exportPdf(await doc.save(), [box])),
    value = result.getPage(0).node.Contents()!
  const stream = (value instanceof PDFArray ? value.asArray() : [value])
    .map((ref) =>
      new TextDecoder().decode(decodePDFRawStream(result.context.lookup(ref, PDFRawStream)).decode()),
    )
    .join('\n')
  expect(stream.match(/S\n/g)).toHaveLength(2)
  expect(stream).toContain('210 403.32 m')
  expect(stream).toContain('210 386.52 m')
})
