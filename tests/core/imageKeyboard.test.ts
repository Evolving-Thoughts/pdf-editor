import { afterEach, expect, test, vi } from 'vitest'
import { addOverlay, nudgeOverlay, updateOverlay } from '../../src/core/commands'
import { EditorStore } from '../../src/core/editorStore'
import { imageGeometry } from '../../src/core/images/geometry'
import type { ImageOverlay } from '../../src/core/model'
const image: ImageOverlay = { kind: 'image', id: 'img', pageIndex: 0, x: 100, y: 100, width: 200, height: 100,
  lockAspectRatio: true, dataUrl: 'data:image/png;base64,AQ==', name: 'logo.png', pixelWidth: 200, pixelHeight: 100 }
afterEach(() => vi.useRealTimers())
function setup() { const store = new EditorStore(); store.dispatch(addOverlay(image)); return store }
function geometry(store: EditorStore) { return imageGeometry(store.state.overlays[0] as ImageOverlay) }

test('rapid image movement keys merge into one undo/redo without losing the source', () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const store = setup()
  for (let i = 0; i < 3; i++) {
    const before = geometry(store)
    store.dispatch(nudgeOverlay(image.id, before, { ...before, x: before.x + 1 }))
    vi.advanceTimersByTime(100)
  }
  expect(geometry(store).x).toBe(103)
  store.undo(); expect(store.state.overlays[0]).toEqual(image)
  store.redo(); expect(geometry(store).x).toBe(103)
  expect((store.state.overlays[0] as ImageOverlay).dataUrl).toBe(image.dataUrl)
})

test('a pause, different image or action, and a normal edit break keyboard merging', () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const store = setup()
  let before = geometry(store)
  store.dispatch(nudgeOverlay(image.id, before, { ...before, x: 101 }))
  vi.advanceTimersByTime(1001)
  before = geometry(store)
  store.dispatch(nudgeOverlay(image.id, before, { ...before, x: 102 }))
  store.undo(); expect(geometry(store).x).toBe(101)
  before = geometry(store)
  store.dispatch(nudgeOverlay(image.id, before, { ...before, rotation: 1 }, 'rotate'))
  store.undo(); expect(geometry(store).rotation ?? 0).toBe(0)
  expect(geometry(store).x).toBe(101)
  before = geometry(store)
  store.dispatch(updateOverlay(image.id, before, { ...before, width: 220 }))
  before = geometry(store)
  store.dispatch(nudgeOverlay(image.id, before, { ...before, x: 102 }))
  store.undo(); expect(geometry(store)).toMatchObject({ x: 101, width: 220 })
  store.dispatch(addOverlay({ ...image, id: 'other' }))
  store.dispatch(nudgeOverlay('other', imageGeometry(image), { ...imageGeometry(image), x: 105 }))
  store.undo(); expect((store.state.overlays[1] as ImageOverlay).x).toBe(100)
  expect(geometry(store).x).toBe(101)
})

test('same-corner resizing and rotation merge separately, using immutable snapshots', () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const store = setup()
  let before = geometry(store)
  store.dispatch(nudgeOverlay(image.id, before, { ...before, width: 202 }, 'resize:ne'))
  before = geometry(store)
  const after = { ...before, width: 204 }
  store.dispatch(nudgeOverlay(image.id, before, after, 'resize:ne'))
  after.width = 999
  store.undo(); expect(geometry(store).width).toBe(200)
  store.redo(); expect(geometry(store).width).toBe(204)
  before = geometry(store)
  store.dispatch(nudgeOverlay(image.id, before, { ...before, rotation: 1 }, 'rotate'))
  before = geometry(store)
  store.dispatch(nudgeOverlay(image.id, before, { ...before, rotation: 2 }, 'rotate'))
  store.undo(); expect(geometry(store).rotation ?? 0).toBe(0)
  expect(geometry(store).width).toBe(204)
})
