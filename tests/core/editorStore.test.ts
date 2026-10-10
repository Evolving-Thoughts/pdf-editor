import { expect, test, vi } from 'vitest'
import { addTextbox, updateTextbox } from '../../src/core/commands'
import { EditorStore } from '../../src/core/editorStore'
import type { Textbox } from '../../src/core/model'

function makeBox(id: string, text = ''): Textbox {
  return { id, pageIndex: 0, x: 50, y: 700, text, font: 'helvetica', fontSize: 14, bold: false, italic: false, underline: false }
}

test('preview mutates state and notifies without recording history', () => {
  const store = new EditorStore()
  store.dispatch(addTextbox(makeBox('a', 'Hallo')))
  const notify = vi.fn()
  store.subscribe(notify)

  store.preview((state) => {
    state.overlays[0].text = 'Live-Drag'
  })
  expect(store.state.overlays[0].text).toBe('Live-Drag')
  expect(notify).toHaveBeenCalledTimes(1)

  // Not in history: undo reverts the add, not the preview.
  store.undo()
  expect(store.state.overlays).toHaveLength(0)
  expect(store.canRedo).toBe(true)
})

test('reset clears overlays and history', () => {
  const store = new EditorStore()
  store.dispatch(addTextbox(makeBox('a')))
  expect(store.canUndo).toBe(true)

  store.reset()
  expect(store.state.overlays).toHaveLength(0)
  expect(store.canUndo).toBe(false)
  expect(store.canRedo).toBe(false)

  // The store keeps working after a reset (fresh stack on the same state).
  store.dispatch(addTextbox(makeBox('b')))
  expect(store.state.overlays.map((o) => o.id)).toEqual(['b'])
  store.undo()
  expect(store.state.overlays).toHaveLength(0)
})

test('undo/redo notify only when the stack actually changes', () => {
  const store = new EditorStore()
  const notify = vi.fn()
  store.subscribe(notify)

  store.undo() // nothing to undo -> no notification
  store.redo()
  expect(notify).not.toHaveBeenCalled()

  store.dispatch(addTextbox(makeBox('a')))
  notify.mockClear()
  store.undo()
  store.redo()
  expect(notify).toHaveBeenCalledTimes(2)
})

test('subscribers can unsubscribe and dispatch updates via commands', () => {
  const store = new EditorStore()
  const notify = vi.fn()
  const unsubscribe = store.subscribe(notify)

  store.dispatch(addTextbox(makeBox('a')))
  expect(notify).toHaveBeenCalledTimes(1)
  unsubscribe()
  store.dispatch(updateTextbox('a', { text: '' }, { text: 'neu' }))
  expect(notify).toHaveBeenCalledTimes(1)
  expect(store.state.overlays[0].text).toBe('neu')
})
