import { expect, test } from 'vitest'
import { addOverlay, clearDrawing, CommandStack, updateOverlay } from '../../src/core/commands'
import { isStroke, type EditorState, type Stroke, type Textbox } from '../../src/core/model'

const text: Textbox = {
  id: 'text', pageId: 'p0', x: 10, y: 700, text: 'Keep me', font: 'helvetica',
  fontSize: 14, bold: false, italic: false, underline: false,
}
const stroke: Stroke = {
  id: 'first', pageId: 'p0', color: '#111111', width: 3,
  points: [{ x: 10, y: 50 }, { x: 100, y: 50 }],
}
const second: Stroke = { ...stroke, id: 'second', pageId: 'p1', color: '#2455c7', width: 6 }

test('clearing a drawing removes strokes on every page, preserving texts and symbols in order', () => {
  const symbol = { ...text, id: 'symbol', pageId: 'p1', font: 'zapfdingbats' as const, text: '✓' }
  const state: EditorState = { overlays: [stroke, text, second, symbol] }
  const stack = new CommandStack(state)
  stack.execute(clearDrawing(state.overlays))
  expect(state.overlays).toEqual([text, symbol])
  stack.undo()
  expect(state.overlays).toEqual([stroke, text, second, symbol])
  stack.redo()
  expect(state.overlays).toEqual([text, symbol])
})

test('clear is a single history step and does not corrupt neighboring drawing or text commands', () => {
  const state: EditorState = { overlays: [{ ...text }] }
  const stack = new CommandStack(state)
  stack.execute(addOverlay(stroke))
  stack.execute(addOverlay(second))
  stack.execute(clearDrawing(state.overlays))
  stack.execute(updateOverlay('text', { text: 'Keep me' }, { text: 'Edited' }))
  stack.undo()
  expect(state.overlays).toEqual([text])
  stack.undo()
  expect(state.overlays).toEqual([text, stroke, second])
  stack.undo()
  expect(state.overlays).toEqual([text, stroke])
  stack.redo()
  stack.redo()
  expect(state.overlays).toEqual([text])
  stack.redo()
  expect(state.overlays).toEqual([{ ...text, text: 'Edited' }])
})

test('clearing snapshots are independent from mutable inputs and previous undo results', () => {
  const source: Stroke = { ...stroke, points: stroke.points.map(p => ({ ...p })) }
  const state: EditorState = { overlays: [source, { ...text }] }
  const stack = new CommandStack(state)
  const command = clearDrawing(state.overlays)
  source.points[0].x = 999
  stack.execute(command)
  stack.undo()
  expect(state.overlays.filter(isStroke)[0].points).toEqual([{ x: 10, y: 50 }, { x: 100, y: 50 }])
  state.overlays.filter(isStroke)[0].points[0].x = 888
  stack.redo()
  stack.undo()
  expect(state.overlays).toEqual([stroke, text])
})