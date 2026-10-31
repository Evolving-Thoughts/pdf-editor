import { test, expect } from 'vitest'
import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib'
import { normalizeA4 } from '../../src/core/pdf/normalizeA4'
import { inspectPages, pageSize } from '../../src/core/pdf/pageOperations'
import { A4_WIDTH, A4_HEIGHT, commonPreviewScale, replacePageDocument, rotatePage } from '../../src/core/pages'
import { EditorStore } from '../../src/core/editorStore'
import { capturePageClip, resolvedOverlayClips } from '../../src/core/overlayClipping'
import { createShape } from '../../src/core/shapes'
import { eraseStrokes } from '../../src/core/drawing'
import { PNG_DATA_URL } from '../imageFixtures.js'

test('A4 fits all visible page orientations, retains live fields and maps displayed overlays', async () => {
  const source = await PDFDocument.create(), first = source.addPage([612, 792])
  source.addPage([700, 400])
  const rotated = source.addPage([400, 600]); rotated.setRotation(degrees(90))
  rotated.setCropBox(20, 30, 300, 500); rotated.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))
  const field = source.getForm().createTextField('name'); field.setText('Ada')
  field.addToPage(first, { x: 40, y: 600, width: 180, height: 25 })
  const bytes = await source.save(), pages = await inspectPages(bytes, 'base')
  const textbox = { id: 'text', pageIndex: 0, text: 'Correction', x: 100, y: 300, font: 'helvetica' as const, fontSize: 12, bold: false, italic: false, underline: false }
  const untouched = bytes.slice()
  const normalized = await normalizeA4(bytes, [], pages, [textbox])
  expect(normalized.pages.map(pageSize)).toEqual([{ width: A4_WIDTH, height: A4_HEIGHT }, { width: A4_HEIGHT, height: A4_WIDTH }, { width: A4_HEIGHT, height: A4_WIDTH }])
  expect(normalized.pages.map(p => p.id)).toEqual(pages.map(p => p.id))
  const output = await PDFDocument.load(normalized.source.bytes)
  const editable = output.getForm().getTextField('name')
  expect(editable.getText()).toBe('Ada'); editable.setText('Grace')
  expect((await PDFDocument.load(await output.save())).getForm().getTextField('name').getText()).toBe('Grace')
  const factor = A4_WIDTH / 612
  expect(normalized.overlays[0]).toMatchObject({ x: 100 * factor, y: 300 * factor + (A4_HEIGHT - 792 * factor) / 2, fontSize: 12 * factor })
  const rect = editable.acroField.getWidgets()[0].getRectangle()
  expect(rect.width).toBeCloseTo(181 * factor) // pdf-lib widget border expands the rectangle by 1pt
  expect(bytes).toEqual(untouched)
})


test('A4 keeps cropped native widgets hidden or clipped, without flattening field values', async () => {
  const source = await PDFDocument.create(), page = source.addPage([400, 600])
  const partial = source.getForm().createTextField('partial'); partial.setText('Visible part')
  partial.addToPage(page, { x: 30, y: 300, width: 100, height: 25 })
  const hidden = source.getForm().createTextField('hidden'); hidden.setText('Outside crop')
  hidden.addToPage(page, { x: 10, y: 50, width: 100, height: 25 })
  page.setCropBox(80, 100, 300, 450)
  const bytes = await source.save(), pages = await inspectPages(bytes, 'base')
  const result = await normalizeA4(bytes, [], pages, [])
  const doc = await PDFDocument.load(result.source.bytes), form = doc.getForm()
  const clipped = form.getTextField('partial').acroField.getWidgets()[0]
  expect(clipped.getRectangle().x).toBeCloseTo((A4_WIDTH - 300 * (A4_HEIGHT / 450)) / 2)
  expect(clipped.getRectangle().width).toBeCloseTo(50.5 * (A4_HEIGHT / 450))
  expect(form.getTextField('hidden').acroField.getWidgets()[0].getFlags() & 2).toBe(2)
  expect(form.getTextField('hidden').getText()).toBe('Outside crop')
  form.getTextField('partial').setText('Edited')
  expect((await PDFDocument.load(await doc.save())).getForm().getTextField('partial').getText()).toBe('Edited')
})

test('A4 replacement is one undoable operation and retains editable overlay types and clipping', async () => {
  const source = await PDFDocument.create(); source.addPage([612, 792])
  const bytes = await source.save(), pages = await inspectPages(bytes, 'base')
  const overlays = [
    { kind: 'image' as const, id: 'image', pageIndex: 0, x: -20, y: 100, width: 120, height: 60, rotation: 30, lockAspectRatio: true, name: 'photo', pixelWidth: 120, pixelHeight: 60, dataUrl: PNG_DATA_URL },
    { kind: 'shape' as const, shape: 'rect' as const, id: 'shape', pageIndex: 0, x: 30, y: 40, width: 100, height: 50, rotation: 30, fill: '#ffffff', strokeColor: '#111111', strokeWidth: 2 },
    { id: 'pen', pageIndex: 0, points: [{ x: 20, y: 50 }, { x: 200, y: 60 }], color: '#111111', width: 3 },
  ]
  const before = structuredClone(overlays), store = new EditorStore(); store.restore({ overlays: overlays, pages: pages, pageSources: [] })
  const prepared = await normalizeA4(bytes, [], pages, overlays)
  expect(overlays).toEqual(before)
  const factor = A4_WIDTH / 612, dy = (A4_HEIGHT - 792 * factor) / 2
  expect(prepared.overlays[0]).toMatchObject({ kind: 'image', rotation: 30, width: 120 * factor, height: 60 * factor, dataUrl: PNG_DATA_URL })
  expect(prepared.overlays[1]).toMatchObject({ kind: 'shape', strokeWidth: 2 * factor })
  expect(prepared.overlays[2]).toMatchObject({ points: [{ x: 20 * factor, y: 50 * factor + dy }, { x: 200 * factor, y: 60 * factor + dy }], width: 3 * factor })
  for (const overlay of prepared.overlays) {
    const polygon = resolvedOverlayClips(overlay)[0]
    expect(polygon[0].x).toBeCloseTo(0); expect(polygon[0].y).toBeCloseTo(dy)
    expect(polygon[2].x).toBeCloseTo(A4_WIDTH); expect(polygon[2].y).toBeCloseTo(792 * factor + dy)
  }
  store.dispatch(replacePageDocument(store.state, prepared.pages, prepared.source, prepared.overlays))
  expect(store.state.pageSources).toEqual([prepared.source])
  store.undo(); expect(store.state.overlays).toEqual(before); expect(store.state.pages).toEqual(pages); expect(store.state.pageSources).toEqual([])
  store.redo(); expect(store.state.overlays).toEqual(prepared.overlays)
  store.dispatch(rotatePage(store.state, pages[0].id, true))
  expect(pageSize(store.state.pages![0])).toEqual({ width: A4_HEIGHT, height: A4_WIDTH })
  const clip = resolvedOverlayClips(store.state.overlays[0])[0]
  expect(clip[0].x).toBeCloseTo(dy); expect(clip[0].y).toBeCloseTo(A4_WIDTH)
  const image = store.state.overlays[0]
  if ('x' in image) image.x += 10
  expect(resolvedOverlayClips(image)[0][0].x).toBeCloseTo(clip[0].x + 10)
})

test('portrait and landscape A4 previews share one physical scale, including narrow screens', async () => {
  const sizes = [{ width: A4_WIDTH, height: A4_HEIGHT }, { width: A4_HEIGHT, height: A4_WIDTH }]
  for (const available of [{ width: 800, height: 850 }, { width: 360, height: 440 }]) {
    const scale = commonPreviewScale(sizes, available)
    expect(sizes[0].height * scale).toBeCloseTo(sizes[1].width * scale)
    expect(sizes[0].width * scale).toBeCloseTo(sizes[1].height * scale)
    expect(sizes[1].width * scale).toBeLessThanOrEqual(available.width - 48)
  }
})

test('A4 rejects XFA and empty documents without modifying original bytes', async () => {
  const source = await PDFDocument.create(); source.addPage([612, 792])
  source.getForm().acroForm.dict.set(PDFName.of('XFA'), source.context.obj('unsupported'))
  const bytes = await source.save({ updateFieldAppearances: false }), untouched = bytes.slice()
  const pages = await inspectPages(bytes, 'base')
  await expect(normalizeA4(bytes, [], pages, [])).rejects.toThrow(/XFA/)
  expect(bytes).toEqual(untouched)
  await expect(normalizeA4(bytes, [], [], [])).rejects.toThrow(/mindestens eine Seite/)
})

test('erasing a normalized textmarker preserves its visible-page clipping on all fragments', async () => {
  const marker = createShape('marker', [{ x: -10, y: 100 }, { x: 200, y: 100 }], 0, { fill: null, strokeColor: '#ffff00', strokeWidth: 12 })!
  capturePageClip(marker, { width: 612, height: 792 })
  const expected = resolvedOverlayClips(marker)
  const fragments = eraseStrokes([marker], 0, [{ x: 100, y: 100 }], 5)
  expect(fragments).toHaveLength(2)
  for (const fragment of fragments) {
    const polygons = resolvedOverlayClips(fragment)
    expect(polygons).toHaveLength(1)
    polygons[0].forEach((point, i) => { expect(point.x).toBeCloseTo(expected[0][i].x); expect(point.y).toBeCloseTo(expected[0][i].y) })
  }
})

test('A4 retains cropped checkbox appearance states and shared fields on differently sized pages', async () => {
  const source = await PDFDocument.create(), first = source.addPage([612, 792]), second = source.addPage([700, 400])
  const shared = source.getForm().createTextField('shared'); shared.setText('Ada')
  shared.addToPage(first, { x: 50, y: 600, width: 180, height: 24 })
  shared.addToPage(second, { x: 50, y: 300, width: 180, height: 24 })
  shared.setFontSize(12)
  const checkbox = source.getForm().createCheckBox('checked'); checkbox.addToPage(first, { x: 20, y: 300, width: 20, height: 20 }); checkbox.check()
  first.setCropBox(30, 0, 582, 792)
  const bytes = await source.save(), pages = await inspectPages(bytes, 'base')
  const normalized = await normalizeA4(bytes, [], pages, []), output = await PDFDocument.load(normalized.source.bytes)
  const field = output.getForm().getTextField('shared')
  expect(field.acroField.getWidgets()).toHaveLength(2)
  expect(field.acroField.getDefaultAppearance()).toMatch(/0 Tf/)
  expect(output.getForm().getCheckBox('checked').isChecked()).toBe(true)
  output.getForm().getCheckBox('checked').uncheck(); field.setText('Grace')
  const reopened = await PDFDocument.load(await output.save())
  expect(reopened.getForm().getCheckBox('checked').isChecked()).toBe(false)
  expect(reopened.getForm().getTextField('shared').getText()).toBe('Grace')
})

test('A4 clipping scales correctly for exactly horizontal and vertical lines', async () => {
  const source = await PDFDocument.create(); source.addPage([612, 792])
  const bytes = await source.save(), pages = await inspectPages(bytes, 'base')
  const style = { fill: null, strokeColor: '#111111', strokeWidth: 2 }
  const horizontal = createShape('line', [{ x: 20, y: 100 }, { x: 200, y: 100 }], 0, style)!
  const vertical = createShape('arrow', [{ x: 300, y: 50 }, { x: 300, y: 200 }], 0, style)!
  const prepared = await normalizeA4(bytes, [], pages, [horizontal, vertical])
  const factor = A4_WIDTH / 612, dy = (A4_HEIGHT - 792 * factor) / 2
  for (const overlay of prepared.overlays) {
    const clip = resolvedOverlayClips(overlay)[0]
    expect(clip[0].x).toBeCloseTo(0); expect(clip[0].y).toBeCloseTo(dy)
    expect(clip[2].x).toBeCloseTo(A4_WIDTH); expect(clip[2].y).toBeCloseTo(792 * factor + dy)
  }
})
