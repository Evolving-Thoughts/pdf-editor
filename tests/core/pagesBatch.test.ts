import { expect, test } from 'vitest'
import { EditorStore } from '../../src/core/editorStore'
import { deletePages, rotatePages, type DocumentPage } from '../../src/core/pages'
import { overlayPageIndex, type Textbox } from '../../src/core/model'
const pages = (): DocumentPage[] => ['a','b','c','d'].map(id => ({ id, name: id, sourceId: 'original', sourceIndex: 0, box: { x: 0, y: 0, width: 200, height: 300 }, unit: 1, rotation: 0 }))
const box = (index: number): Textbox => ({ id: 't'+index, pageId: 'abcd'[index], x: 20, y: 250, text: 'text', font: 'helvetica', fontSize: 12, bold: false, italic: false, underline: false })
test('batch deletion removes only selected pages and remaps overlays, atomically undoable', () => {
  const store = new EditorStore(); store.restore({ overlays: [box(0),box(1),box(2),box(3)], pages: pages(), pageSources: [] })
  const before = structuredClone(store.state)
  store.dispatch(deletePages(store.state, ['c','a','c']))
  expect(store.state.pages?.map(p=>p.id)).toEqual(['b','d'])
  expect(store.state.overlays.map(o=>[o.id,overlayPageIndex(store.state,o)])).toEqual([['t1',0],['t3',1]])
  store.undo(); expect(store.state).toEqual(before); expect(store.canUndo).toBe(false)
  store.redo(); expect(store.state.pages?.map(p=>p.id)).toEqual(['b','d'])
})
test('batch rotation maps only chosen page overlays and is one undo step', () => {
  const store = new EditorStore(); store.restore({ overlays: [box(0),box(1),box(2)], pages: pages(), pageSources: [] })
  const before = structuredClone(store.state)
  store.dispatch(rotatePages(store.state, ['a','c'], true))
  expect(store.state.pages?.map(p=>p.rotation)).toEqual([90,0,90,0])
  expect(store.state.overlays[0]).toMatchObject({ x: 250, y: 180, rotation: 90 })
  expect(store.state.overlays[1]).toEqual(before.overlays[1])
  store.undo(); expect(store.state).toEqual(before); expect(store.canUndo).toBe(false)
})
test('invalid or empty selections fail without any partial mutation; all pages may be deleted', () => {
  const store = new EditorStore(); store.restore({ overlays: [box(0)], pages: pages(), pageSources: [] }); const before = structuredClone(store.state)
  expect(()=>deletePages(store.state, [])).toThrow()
  expect(()=>rotatePages(store.state, ['a','missing'], true)).toThrow()
  expect(store.state).toEqual(before)
  store.dispatch(deletePages(store.state, ['a','b','c','d'])); expect(store.state.pages).toEqual([])
  store.undo(); expect(store.state).toEqual(before)
})
