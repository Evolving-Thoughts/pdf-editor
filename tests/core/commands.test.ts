import { expect, test, vi } from 'vitest'
import { addOverlay, CommandStack, updateOverlay, nudgeOverlay, removeOverlay } from '../../src/core/commands'
import type { EditorState, Textbox } from '../../src/core/model'

function makeBox(id: string, text = ''): Textbox {
  return { id, pageIndex: 0, x: 50, y: 700, text, font: 'helvetica', fontSize: 14, bold: false, italic: false, underline: false }
}

test('add, undo and redo a textbox', () => {
  const state: EditorState = { overlays: [] }
  const stack = new CommandStack(state)
  stack.execute(addOverlay(makeBox('a', 'Hallo')))
  expect(state.overlays).toHaveLength(1)
  expect(stack.canUndo).toBe(true)

  stack.undo()
  expect(state.overlays).toHaveLength(0)
  expect(stack.canRedo).toBe(true)

  stack.redo()
  expect(state.overlays[0].text).toBe('Hallo')
})

test('a new command clears the redo history', () => {
  const state: EditorState = { overlays: [] }
  const stack = new CommandStack(state)
  stack.execute(addOverlay(makeBox('a')))
  stack.undo()
  stack.execute(addOverlay(makeBox('b')))
  expect(stack.canRedo).toBe(false)
  expect(state.overlays.map((o) => o.id)).toEqual(['b'])
})

test('update and move revert to the exact previous values', () => {
  const state: EditorState = { overlays: [makeBox('a', 'alt')] }
  const stack = new CommandStack(state)
  stack.execute(updateOverlay('a', { text: 'alt' }, { text: 'neu' }))
  stack.execute(updateOverlay('a', { x: 50, y: 700 }, { x: 100, y: 600 }))
  expect(state.overlays[0]).toMatchObject({ text: 'neu', x: 100, y: 600 })

  stack.undo()
  expect(state.overlays[0]).toMatchObject({ text: 'neu', x: 50, y: 700 })
  stack.undo()
  expect(state.overlays[0].text).toBe('alt')
})

test('remove restores the full snapshot on undo', () => {
  const state: EditorState = { overlays: [makeBox('a', 'weg')] }
  const stack = new CommandStack(state)
  stack.execute(removeOverlay(state.overlays[0]))
  expect(state.overlays).toHaveLength(0)
  stack.undo()
  expect(state.overlays[0]).toEqual(makeBox('a', 'weg'))
})

test('25 mixed actions undo cleanly back to empty', () => {
  const state: EditorState = { overlays: [] }
  const stack = new CommandStack(state)
  for (let i = 0; i < 25; i++) stack.execute(addOverlay(makeBox(`b${i}`, `Text ${i}`)))
  expect(state.overlays).toHaveLength(25)
  for (let i = 0; i < 25; i++) stack.undo()
  expect(state.overlays).toHaveLength(0)
  expect(stack.canUndo).toBe(false)
  expect(stack.canRedo).toBe(true)
})

test('rapid nudges on the same box merge into one undo step', () => {
  const state: EditorState = { overlays: [makeBox('a')] }
  const stack = new CommandStack(state)
  for (let i = 1; i <= 5; i++) {
    const box = state.overlays[0]
    stack.execute(nudgeOverlay('a', { x: box.x, y: box.y }, { x: box.x + 1, y: box.y }))
  }
  expect(state.overlays[0].x).toBe(55)
  stack.undo()
  expect(state.overlays[0].x).toBe(50)
  expect(stack.canUndo).toBe(false)
  stack.redo()
  expect(state.overlays[0].x).toBe(55)
})

test('nudges on different boxes do not merge', () => {
  const state: EditorState = { overlays: [makeBox('a'), makeBox('b')] }
  const stack = new CommandStack(state)
  stack.execute(nudgeOverlay('a', { x: 50, y: 700 }, { x: 51, y: 700 }))
  stack.execute(nudgeOverlay('b', { x: 50, y: 700 }, { x: 51, y: 700 }))
  stack.undo()
  expect(state.overlays[1].x).toBe(50)
  expect(state.overlays[0].x).toBe(51)
  stack.undo()
  expect(state.overlays[0].x).toBe(50)
})

test('nudges do not merge across a time gap', () => {
  vi.useFakeTimers()
  try {
    const state: EditorState = { overlays: [makeBox('a')] }
    const stack = new CommandStack(state)
    stack.execute(nudgeOverlay('a', { x: 50, y: 700 }, { x: 51, y: 700 }))
    vi.advanceTimersByTime(2000)
    stack.execute(nudgeOverlay('a', { x: 51, y: 700 }, { x: 52, y: 700 }))
    stack.undo()
    expect(state.overlays[0].x).toBe(51)
  } finally {
    vi.useRealTimers()
  }
})

test('undoing a removal restores the original position in the overlay order', () => {
  const state: EditorState = { overlays: [makeBox('a'), makeBox('b'), makeBox('c')] }
  const stack = new CommandStack(state)
  stack.execute(removeOverlay(state.overlays[1]))
  expect(state.overlays.map((o) => o.id)).toEqual(['a', 'c'])
  stack.undo()
  expect(state.overlays.map((o) => o.id)).toEqual(['a', 'b', 'c'])
})
