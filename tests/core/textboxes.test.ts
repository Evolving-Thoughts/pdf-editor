import { expect, test } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { addOverlay, CommandStack, updateOverlay } from '../../src/core/commands'
import { floatingBarPosition } from '../../src/core/barPosition'
import type { EditorState, Textbox } from '../../src/core/model'
import { createSymbolBox, createTextbox, DEFAULT_TEXT_STYLE, PASTE_OFFSET, pastedTextbox, rotateTextbox, textStyleOf } from '../../src/core/textboxes'
import { exportPdf } from './exportFixture'

const page = { width: 600, height: 800 }

function box(overrides: Partial<Textbox> = {}): Textbox {
  return { id: 'b', pageId: 'p0', x: 100, y: 700, text: 'Hallo', font: 'times', fontSize: 18, bold: true, italic: true, underline: false, ...overrides }
}

test('a new textbox takes over the last chosen text settings, symbols do not change them', () => {
  const style = textStyleOf(box())!
  expect(style).toEqual({ font: 'times', fontSize: 18, bold: true, italic: true, underline: false })
  expect(createTextbox('p1', { x: 5, y: 6 }, style, 'n')).toEqual({ id: 'n', pageId: 'p1', x: 5, y: 6, text: '', ...style })
  expect(createTextbox('p1', { x: 5, y: 6 }, DEFAULT_TEXT_STYLE).font).toBe('helvetica')
  const symbol = createSymbolBox('p1', { x: 1, y: 2 }, '✓')
  expect(symbol).toMatchObject({ font: 'zapfdingbats', text: '✓', bold: false })
  expect(textStyleOf(symbol)).toBeNull()
})

test('rotation is clockwise around the baseline, normalized and snaps with Shift', () => {
  expect(rotateTextbox(370)).toBe(10)
  expect(rotateTextbox(-90)).toBe(270)
  expect(rotateTextbox(22, true)).toBe(15)
  expect(rotateTextbox(23, true)).toBe(30)
  expect(rotateTextbox(Number.NaN)).toBe(0)
  expect(rotateTextbox(12.34)).toBe(12.3)
})

test('rotating a textbox is one undo step', () => {
  const state: EditorState = { overlays: [] }
  const stack = new CommandStack(state)
  stack.execute(addOverlay(box()))
  stack.execute(updateOverlay('b', { x: 100, y: 700, rotation: undefined }, { x: 100, y: 700, rotation: 45 }))
  expect((state.overlays[0] as Textbox).rotation).toBe(45)
  stack.undo()
  expect((state.overlays[0] as Textbox).rotation).toBeUndefined()
})

test('a pasted copy gets a new id, moves down-right and stays plain text on the page', () => {
  const original = box({ rotation: 30, labelGroup: 'bottom-center', label: { kind: 'number' } as never, clips: [[{ x: 0, y: 0 }]] })
  const copy = pastedTextbox(original, page, 'p0', PASTE_OFFSET, 'copy')
  expect(copy).toEqual({ ...box({ rotation: 30 }), id: 'copy', x: 100 + PASTE_OFFSET, y: 700 - PASTE_OFFSET })
  expect(original.labelGroup).toBe('bottom-center')
  const atEdge = pastedTextbox(box({ x: 595, y: 5 }), page, 'p1')
  expect(atEdge).toMatchObject({ x: 600, y: 0, pageId: 'p1' })
  expect(atEdge.id).not.toBe('b')
})

test('a rotated textbox exports with the same rotation', async () => {
  const source = await PDFDocument.create()
  source.addPage([600, 800])
  const bytes = await exportPdf(await source.save(), [box({ text: 'Gedreht', bold: false, italic: false, font: 'helvetica', rotation: 90 })])
  const task = getDocument({ data: bytes.slice() })
  const pdf = await task.promise
  const content = await (await pdf.getPage(1)).getTextContent()
  const item = content.items.find(entry => 'str' in entry && entry.str === 'Gedreht') as { transform: number[] }
  await task.destroy()
  // Clockwise on screen is a negative angle in PDF space: [cos, sin, -sin, cos] = [0, -1, 1, 0].
  const [a, b, c, d, e, f] = item.transform
  expect([a, b, c, d].map(v => Math.round(v / 18))).toEqual([0, -1, 1, 0])
  expect([Math.round(e), Math.round(f)]).toEqual([100, 700])
})

test('the settings bar sits above its element, below when there is no room, and inside the visible area', () => {
  const area = { left: 0, top: 100, right: 800, bottom: 600 }
  const bar = { width: 300, height: 30 }
  expect(floatingBarPosition({ left: 50, top: 300, right: 150, bottom: 320 }, bar, area)).toEqual({ left: 50, top: 264, hidden: false })
  // Close to the top edge (where the save notice is): below the element instead of underneath the notice.
  expect(floatingBarPosition({ left: 50, top: 110, right: 150, bottom: 130 }, bar, area)).toEqual({ left: 50, top: 136, hidden: false })
  // Near the right edge: shifted left so all buttons stay reachable.
  expect(floatingBarPosition({ left: 700, top: 300, right: 760, bottom: 320 }, bar, area).left).toBe(500)
  // Element scrolled out of view: no floating bar over other content.
  expect(floatingBarPosition({ left: 50, top: 20, right: 150, bottom: 40 }, bar, area).hidden).toBe(true)
})

test('undoing a keyboard rotation of an unrotated box removes the rotation again', async () => {
  const { nudgeOverlay } = await import('../../src/core/commands')
  const state: EditorState = { overlays: [] }
  const stack = new CommandStack(state)
  stack.execute(addOverlay(box()))
  stack.execute(nudgeOverlay('b', { rotation: undefined }, { rotation: 1 }, 'rotate'))
  stack.execute(nudgeOverlay('b', { rotation: 1 }, { rotation: 2 }, 'rotate'))
  expect((state.overlays[0] as Textbox).rotation).toBe(2)
  stack.undo()
  expect('rotation' in state.overlays[0] && (state.overlays[0] as Textbox).rotation !== undefined).toBe(false)
})
