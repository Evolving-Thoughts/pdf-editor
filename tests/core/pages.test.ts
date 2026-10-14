import { expect, test } from 'vitest'
import { EditorStore } from '../../src/core/editorStore'
import {
  movePage,
  deletePage,
  insertPages,
  insertionPageSize,
  rotatePage,
  cropPage,
  pageSize,
  type DocumentPage,
} from '../../src/core/pages'
import { addTextbox } from '../../src/core/commands'
import type { Textbox } from '../../src/core/model'
const pages = (): DocumentPage[] =>
  ['a', 'b', 'c'].map((id) => ({
    id,
    name: id,
    sourceId: 'original',
    sourceIndex: 0,
    box: { x: 0, y: 0, width: 200, height: 300 },
    unit: 1,
    rotation: 0,
  }))
const textbox = (id: string, pageIndex: number): Textbox => ({
  id,
  pageIndex,
  x: 30,
  y: 250,
  text: id,
  font: 'helvetica',
  fontSize: 12,
  bold: false,
  italic: false,
  underline: false,
})
test('reordering keeps overlays attached to their page across undo and later text edits', () => {
  const store = new EditorStore()
  store.state.pages = pages()
  store.state.overlays = [textbox('on-a', 0), textbox('on-c', 2)]
  store.dispatch(movePage(store.state, 'a', 2))
  expect(store.state.pages?.map((p) => p.id)).toEqual(['b', 'c', 'a'])
  expect(store.state.overlays.map((o) => o.pageIndex)).toEqual([2, 1])
  store.dispatch(addTextbox(textbox('new', 2)))
  store.undo()
  store.undo()
  expect(store.state.pages?.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  expect(store.state.overlays.map((o) => o.pageIndex)).toEqual([0, 2])
  store.redo()
  store.redo()
  expect(store.state.overlays.map((o) => o.pageIndex)).toEqual([2, 1, 2])
})

test('deleting a page removes only its overlays and undo restores exact paint order', () => {
  const store = new EditorStore()
  store.state.pages = pages()
  store.state.overlays = [textbox('c1', 2), textbox('b1', 1), textbox('a1', 0), textbox('b2', 1)]
  store.dispatch(deletePage(store.state, 'b'))
  expect(store.state.pages?.map((p) => p.id)).toEqual(['a', 'c'])
  expect(store.state.overlays.map((o) => [o.id, o.pageIndex])).toEqual([
    ['c1', 1],
    ['a1', 0],
  ])
  store.undo()
  expect(store.state.overlays.map((o) => [o.id, o.pageIndex])).toEqual([
    ['c1', 2],
    ['b1', 1],
    ['a1', 0],
    ['b2', 1],
  ])
})
test('inserting multiple pages at a gap shifts overlays and is one undo step', () => {
  const store = new EditorStore()
  store.state.pages = pages()
  store.state.overlays = [textbox('c1', 2)]
  store.dispatch(
    insertPages(store.state, 1, [{ ...pages()[0], id: 'new', sourceId: 'extra' }], {
      id: 'extra',
      bytes: new ArrayBuffer(3),
    }),
  )
  expect(store.state.pages?.map((p) => p.id)).toEqual(['a', 'new', 'b', 'c'])
  expect(store.state.overlays[0].pageIndex).toBe(3)
  store.undo()
  expect(store.state.pageSources).toEqual([])
  expect(store.state.overlays[0].pageIndex).toBe(2)
  store.redo()
  expect(store.state.pageSources?.[0].bytes.byteLength).toBe(3)
})
test('clockwise page rotation rotates textbox baselines, shape centers and strokes; undo is exact', () => {
  const store = new EditorStore()
  store.state.pages = pages()
  store.state.overlays = [
    textbox('text', 0),
    {
      kind: 'image',
      id: 'im',
      pageIndex: 0,
      x: 20,
      y: 40,
      width: 60,
      height: 30,
      rotation: 10,
      lockAspectRatio: true,
      name: 'x',
      dataUrl: 'x',
      pixelWidth: 60,
      pixelHeight: 30,
    },
    {
      id: 'stroke',
      pageIndex: 0,
      points: [
        { x: 10, y: 20 },
        { x: 80, y: 50 },
      ],
      width: 2,
      color: '#000000',
    },
  ]
  const before = structuredClone(store.state.overlays)
  store.dispatch(rotatePage(store.state, 'a', true))
  expect(pageSize(store.state.pages![0])).toEqual({ width: 300, height: 200 })
  expect(store.state.overlays[0]).toMatchObject({ x: 250, y: 170, rotation: 90 })
  expect(store.state.overlays[1]).toMatchObject({ x: 25, y: 135, rotation: 100, width: 60, height: 30 })
  expect(store.state.overlays[2]).toMatchObject({
    points: [
      { x: 20, y: 190 },
      { x: 50, y: 120 },
    ],
  })
  store.undo()
  expect(store.state.overlays).toEqual(before)
  for (let i = 0; i < 4; i++) store.dispatch(rotatePage(store.state, 'a', true))
  expect(store.state.overlays).toEqual(before.map((o) => ('text' in o ? { ...o, rotation: 0 } : o)))
})
test('crop translates overlay origins and maps margins into rotated, offset, scaled PDF space', () => {
  const store = new EditorStore()
  store.state.pages = [
    { ...pages()[0], box: { x: 10, y: 20, width: 100, height: 150 }, unit: 2, rotation: 90 },
  ]
  store.state.overlays = [textbox('t', 0)]
  store.dispatch(cropPage(store.state, 'a', { left: 20, top: 40, right: 60, bottom: 10 }))
  expect(store.state.pages![0].box).toEqual({ x: 30, y: 30, width: 75, height: 110 })
  expect(pageSize(store.state.pages![0])).toEqual({ width: 220, height: 150 })
  expect(store.state.overlays[0]).toMatchObject({ x: 10, y: 240 })
  store.undo()
  expect(store.state.pages![0].box).toEqual({ x: 10, y: 20, width: 100, height: 150 })
  expect(() => cropPage(store.state, 'a', { left: 300, top: 0, right: 0, bottom: 0 })).toThrow()
})

test('image page insertion adds editable overlays atomically and undo/redo preserves their geometry', () => {
  const store = new EditorStore()
  store.state.pages = pages()
  store.state.overlays = [textbox('existing', 2)]
  const image = { kind: 'image' as const, id: 'photo', pageIndex: 0, x: 20, y: 50, width: 100, height: 80,
    lockAspectRatio: true, name: 'photo.png', dataUrl: 'png', pixelWidth: 100, pixelHeight: 80 }
  store.dispatch(insertPages(store.state, 1, [{ ...pages()[0], id: 'photo-page', sourceId: 'photo-source' }],
    { id: 'photo-source', bytes: new ArrayBuffer(1) }, [image]))
  expect(store.state.overlays).toEqual([{ ...textbox('existing', 2), pageIndex: 3 }, { ...image, pageIndex: 1 }])
  store.undo()
  expect(store.state.overlays).toEqual([textbox('existing', 2)])
  store.redo()
  expect(store.state.overlays[1]).toEqual({ ...image, pageIndex: 1 })
})

test('page insertion references displayed rotation/crop/UserUnit and defaults to A4 only when empty', () => {
  const plan = pages()
  plan[1] = { ...plan[1], box: { x: 20, y: 30, width: 250, height: 400 }, rotation: 90, unit: 2 }
  expect(insertionPageSize(plan, 0)).toEqual({ width: 200, height: 300 })
  expect(insertionPageSize(plan, 2)).toEqual({ width: 800, height: 500 })
  expect(insertionPageSize([], 0)).toEqual({ width: 595.28, height: 841.89 })
})

test('unsupported XFA page edits fail before changing editor state', () => {
  const store = new EditorStore()
  store.state.pages = pages().map(p => ({ ...p, hasXfa: true }))
  const before = structuredClone(store.state)
  expect(() => rotatePage(store.state, 'a', true)).toThrow('XFA-Formulare')
  expect(() => deletePage(store.state, 'a')).toThrow('XFA-Formulare')
  expect(store.state).toEqual(before)
})
