import { expect, test } from 'vitest'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { CommandStack, replaceOverlays } from '../../src/core/commands'
import { labelCollisions, labelOverlays, labelPosition, labelText, parsePageRange, planLabels, withoutLabelGroup, type LabelConfig, type MeasureText } from '../../src/core/pageLabels'
import { exportPageDocument, inspectPages } from '../../src/core/pdf/pageOperations'
import { cropPage, deletePages, movePage, rotatePages, type DocumentPage } from '../../src/core/pages'
import type { EditorState, Textbox } from '../../src/core/model'

const fixedWidth: MeasureText = text => text.length * 6
const config = (overrides: Partial<LabelConfig> = {}): LabelConfig => ({ template: 'Seite {n} von {gesamt}', range: '', start: 1, position: 'bottom-center', margin: 30, font: 'helvetica', fontSize: 10, ...overrides })
const page = (id: string, width = 600, height = 800, rotation = 0): DocumentPage => ({ id, name: id, sourceId: 'original', sourceIndex: 0, box: { x: 0, y: 0, width, height }, unit: 1, rotation })

test('a page range accepts lists and spans, sorted and without duplicates', () => {
  expect(parsePageRange('5, 2-3, 3', 9)).toEqual([1, 2, 4])
  expect(parsePageRange('2–3', 3)).toEqual([1, 2])
  expect(parsePageRange('  ', 3)).toEqual([0, 1, 2])
})

test('a page range refuses what it cannot read or what does not exist', () => {
  expect(() => parsePageRange('2-', 5)).toThrow(/nicht lesbar/)
  expect(() => parsePageRange('abc', 5)).toThrow(/nicht lesbar/)
  expect(() => parsePageRange('4-9', 5)).toThrow(/außerhalb von 1 bis 5/)
  expect(() => parsePageRange('0', 5)).toThrow(/außerhalb/)
  expect(() => parsePageRange('4-2', 5)).toThrow(/außerhalb/)
})

test('placeholders are filled and plain text stays', () => {
  expect(labelText('Seite {n} von {gesamt}', 3, 10)).toBe('Seite 3 von 10')
  expect(labelText('Entwurf', 3, 10)).toBe('Entwurf')
})

test('positions sit at the margin of the given page size', () => {
  const size = { width: 600, height: 800 }, base = { margin: 30, fontSize: 10 }
  expect(labelPosition(size, 100, { ...base, position: 'bottom-left' })).toEqual({ x: 30, y: 30 })
  expect(labelPosition(size, 100, { ...base, position: 'bottom-right' })).toEqual({ x: 470, y: 30 })
  expect(labelPosition(size, 100, { ...base, position: 'bottom-center' })).toEqual({ x: 250, y: 30 })
  expect(labelPosition(size, 100, { ...base, position: 'top-left' })).toEqual({ x: 30, y: 762 })
})

test('numbers follow the chosen pages in document order, from the chosen start', () => {
  const pages = ['a', 'b', 'c', 'd'].map(id => page(id))
  const labels = planLabels(pages, config({ range: '2-4', start: 5 }), fixedWidth)
  expect(labels.map(label => [label.pageIndex, label.text])).toEqual([[1, 'Seite 5 von 7'], [2, 'Seite 6 von 7'], [3, 'Seite 7 von 7']])
})

test('each page uses its own format: a landscape page centers on its own width', () => {
  const labels = planLabels([page('a', 600, 800), page('b', 800, 600)], config({ template: 'x', range: '' }), fixedWidth)
  expect(labels[0].x).toBe(297)
  expect(labels[1].x).toBe(397)
})

test('a rotated page uses its displayed width', () => {
  const [label] = planLabels([page('a', 600, 800, 90)], config({ template: 'x' }), fixedWidth)
  expect(label.x).toBe(397)
})

test('text that does not fit is refused instead of hanging off the page', () => {
  expect(() => planLabels([page('a', 100, 800)], config({ template: 'Sehr langer Text in der Fußzeile' }), fixedWidth)).toThrow(/passt auf Seite 1 nicht/)
})

test('invalid settings are refused', () => {
  expect(() => planLabels([page('a')], config({ template: '  ' }), fixedWidth)).toThrow(/Text/)
  expect(() => planLabels([page('a')], config({ start: -1 }), fixedWidth)).toThrow(/Nummer/)
  expect(() => planLabels([page('a')], config({ fontSize: 2 }), fixedWidth)).toThrow(/Schriftgröße/)
})

test('a label over page text or an overlay is reported with its page', () => {
  const pages = [page('a'), page('b'), page('c')]
  const labels = planLabels(pages, config({ template: 'xxxxxxxx' }), fixedWidth)
  const fragments = new Map([[0, [{ text: 'Fußnote', quad: [{ x: 250, y: 760 }, { x: 350, y: 760 }, { x: 350, y: 775 }, { x: 250, y: 775 }] }]]])
  const shape: Textbox = { id: 'o', pageIndex: 1, x: 280, y: 30, text: 'Bestand', font: 'helvetica', fontSize: 12, bold: false, italic: false, underline: false }
  expect(labelCollisions(labels, 10, pages, [shape], fragments)).toEqual([0, 1])
})

test('text elsewhere on the page is no collision', () => {
  const pages = [page('a')], labels = planLabels(pages, config(), fixedWidth)
  const fragments = new Map([[0, [{ text: 'Kopf', quad: [{ x: 50, y: 50 }, { x: 150, y: 50 }, { x: 150, y: 65 }, { x: 50, y: 65 }] }]]])
  expect(labelCollisions(labels, 10, pages, [], fragments)).toEqual([])
})

test('applying is one undo step, and applying the same position again replaces it', () => {
  const pages = ['a', 'b', 'c'].map(id => page(id))
  const state: EditorState = { overlays: [], pages }, stack = new CommandStack(state)
  const first = labelOverlays(planLabels(pages, config(), fixedWidth), config())
  stack.execute(replaceOverlays(state.overlays, [...state.overlays, ...first]))
  expect(state.overlays).toHaveLength(3)
  const second = labelOverlays(planLabels(pages, config({ template: 'Blatt {n}' }), fixedWidth), config())
  stack.execute(replaceOverlays(state.overlays, [...withoutLabelGroup(state.overlays, 'bottom-center'), ...second]))
  expect(state.overlays.map(overlay => (overlay as Textbox).text)).toEqual(['Blatt 1', 'Blatt 2', 'Blatt 3'])
  stack.undo()
  stack.undo()
  expect(state.overlays).toEqual([])
  stack.redo()
  expect(state.overlays).toHaveLength(3)
})

test('another position stays when one is replaced', () => {
  const pages = [page('a')]
  const foot = labelOverlays(planLabels(pages, config(), fixedWidth), config())
  const head = labelOverlays(planLabels(pages, config({ position: 'top-left', template: 'Kopf' }), fixedWidth), config({ position: 'top-left' }))
  expect(withoutLabelGroup([...foot, ...head], 'bottom-center')).toEqual(head)
})

async function mixedPdf() {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([400, 600]).drawText('hoch', { x: 50, y: 500, size: 12, font })
  doc.addPage([600, 400]).drawText('quer', { x: 50, y: 300, size: 12, font })
  const rotated = doc.addPage([400, 600])
  rotated.setRotation(degrees(90))
  doc.addPage([400, 600]).drawText('zugeschnitten', { x: 100, y: 300, size: 12, font })
  return doc.save()
}

/** Reads text and position in displayed coordinates from the finished PDF. */
async function positions(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice() })
  const pdf = await task.promise, result = []
  for (let number = 1; number <= pdf.numPages; number++) {
    const pdfPage = await pdf.getPage(number), viewport = pdfPage.getViewport({ scale: 1 })
    for (const item of (await pdfPage.getTextContent()).items) {
      if (!('str' in item) || !/^Seite/.test(item.str)) continue
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
      result.push({ page: number, text: item.str, x, fromBottom: viewport.height - y, width: viewport.width, height: viewport.height })
    }
  }
  await task.destroy()
  return result
}

test('the export has real text at the planned place on mixed, rotated and cropped pages', async () => {
  const bytes = await mixedPdf()
  let pages = await inspectPages(bytes, 'a.pdf')
  const state: EditorState = { overlays: [], pages }
  state.pages = (() => { const s = { ...state }; cropPage(s, pages[3].id, { left: 40, right: 40, top: 100, bottom: 100 }).apply(s); return s.pages! })()
  pages = state.pages
  const labels = planLabels(pages, config({ template: 'Seite {n}' }), (text, _font, size) => text.length * size * 0.5)
  const overlays = labelOverlays(labels, config())
  const found = await positions(await exportPageDocument(bytes, [], pages, overlays))
  expect(found.map(item => item.text)).toEqual(['Seite 1', 'Seite 2', 'Seite 3', 'Seite 4'])
  expect(found.map(item => [item.width, item.height])).toEqual([[400, 600], [600, 400], [600, 400], [320, 400]])
  for (const [index, item] of found.entries()) {
    expect(item.fromBottom).toBeCloseTo(30, 0)
    expect(item.x).toBeCloseTo(labels[index].x, 0)
  }
})

test('numbers applied after reordering follow the new order', async () => {
  const bytes = await mixedPdf(), pages = await inspectPages(bytes, 'a.pdf')
  const state: EditorState = { overlays: [], pages }
  movePage(state, pages[3].id, 0).apply(state)
  const overlays = labelOverlays(planLabels(state.pages!, config({ template: 'Seite {n}' }), fixedWidth), config())
  const found = await positions(await exportPageDocument(bytes, [], state.pages!, overlays))
  expect(found[0]).toMatchObject({ page: 1, text: 'Seite 1', width: 400, height: 600 })
  expect(found).toHaveLength(4)
})

test('moving a page renumbers the labels in the new order, as one undo step', () => {
  const pages = ['a', 'b', 'c'].map(id => page(id))
  const state: EditorState = { pages, overlays: labelOverlays(planLabels(pages, config(), fixedWidth), config()) }, stack = new CommandStack(state)
  const onPage = (index: number) => (state.overlays.find(overlay => overlay.pageIndex === index) as Textbox).text
  stack.execute(movePage(state, 'c', 0))
  expect([onPage(0), onPage(1), onPage(2)]).toEqual(['Seite 1 von 3', 'Seite 2 von 3', 'Seite 3 von 3'])
  stack.undo()
  expect([onPage(0), onPage(1), onPage(2)]).toEqual(['Seite 1 von 3', 'Seite 2 von 3', 'Seite 3 von 3'])
  expect((state.overlays[2] as Textbox).pageIndex).toBe(2)
})

test('deleting a page closes the gap and updates the total', () => {
  const pages = ['a', 'b', 'c'].map(id => page(id))
  const state: EditorState = { pages, overlays: labelOverlays(planLabels(pages, config(), fixedWidth), config()) }
  deletePages(state, ['a']).apply(state)
  expect(state.overlays.map(overlay => (overlay as Textbox).text)).toEqual(['Seite 1 von 2', 'Seite 2 von 2'])
})

test('a label edited by hand stays, the others keep counting', () => {
  const pages = ['a', 'b', 'c'].map(id => page(id))
  const overlays = labelOverlays(planLabels(pages, config({ template: 'S. {n}' }), fixedWidth), config({ template: 'S. {n}' }))
  ;(overlays[1] as Textbox).text = 'Anhang'
  const state: EditorState = { pages, overlays }
  movePage(state, 'c', 0).apply(state)
  const text = (index: number) => (state.overlays.find(overlay => overlay.pageIndex === index) as Textbox).text
  expect(text(2)).toBe('Anhang')
  expect(text(0)).toBe('S. 1')
})

test('labels on chosen pages keep counting from their start', () => {
  const pages = ['a', 'b', 'c', 'd'].map(id => page(id))
  const settings = config({ template: '{n}', range: '2-4', start: 10 })
  const state: EditorState = { pages, overlays: labelOverlays(planLabels(pages, settings, fixedWidth), settings) }
  movePage(state, 'd', 1).apply(state)
  expect(state.overlays.map(overlay => [overlay.pageIndex, (overlay as Textbox).text]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([[1, '10'], [2, '11'], [3, '12']])
})

test('a centered label stays centered when its number gets a digit longer', () => {
  const pages = Array.from({ length: 12 }, (_, index) => page(`p${index}`))
  const settings = config({ template: '{n}', fontSize: 10 })
  const measure: MeasureText = (text, _font, size) => text.length * size * 0.556
  const state: EditorState = { pages, overlays: labelOverlays(planLabels(pages, settings, measure), settings) }
  const first = state.overlays[0] as Textbox
  const center = first.x + measure(first.text, 'helvetica', 10) / 2
  movePage(state, 'p0', 11).apply(state)
  const moved = state.overlays.find(overlay => overlay.pageIndex === 11) as Textbox
  expect(moved.text).toBe('12')
  expect(moved.x + measure(moved.text, 'helvetica', 10) / 2).toBeCloseTo(center, 5)
})

test('two label positions count independently', () => {
  const pages = ['a', 'b'].map(id => page(id))
  const foot = config({ template: 'F{n}' }), head = config({ template: 'K{n}', position: 'top-left', start: 5 })
  const state: EditorState = { pages, overlays: [...labelOverlays(planLabels(pages, foot, fixedWidth), foot), ...labelOverlays(planLabels(pages, head, fixedWidth), head)] }
  movePage(state, 'b', 0).apply(state)
  const on = (index: number) => state.overlays.filter(overlay => overlay.pageIndex === index).map(overlay => (overlay as Textbox).text).sort()
  expect(on(0)).toEqual(['F1', 'K5'])
  expect(on(1)).toEqual(['F2', 'K6'])
})

test('a page rotated in the editor keeps its label after rotation, in the same corner of the sheet', () => {
  const pages = [page('a')]
  const state: EditorState = { pages, overlays: labelOverlays(planLabels(pages, config(), fixedWidth), config()) }
  rotatePages(state, ['a'], true).apply(state)
  expect((state.overlays[0] as Textbox).rotation).toBe(90)
})
