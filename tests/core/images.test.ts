import { expect, test } from 'vitest'
import { clearDrawing } from '../../src/core/commands'
import { EditorStore } from '../../src/core/editorStore'
import { isTextbox, type Overlay } from '../../src/core/model'

const image = { kind: 'image', id: 'image', pageIndex: 0, x: 10, y: 20, width: 100, height: 50,
  lockAspectRatio: true, name: 'logo.png', dataUrl: 'data:image/png;base64,AQ==', pixelWidth: 200, pixelHeight: 100 } as unknown as Overlay

test('an image is not a textbox and clearing drawing preserves images', () => {
  expect(isTextbox(image)).toBe(false)
  const store = new EditorStore()
  store.restore({ overlays: [image, { id: 'stroke', pageIndex: 0, points: [{ x: 1, y: 2 }], color: '#111111', width: 3 }] })
  store.dispatch(clearDrawing(store.state.overlays))
  expect(store.state.overlays).toEqual([image])
  store.undo()
  expect(store.state.overlays.map(o => o.id)).toEqual(['image', 'stroke'])
})

import { addOverlay, removeOverlay, updateOverlay } from '../../src/core/commands'
import { eraseStrokes } from '../../src/core/drawing'
import { cloneOverlay, isImage, type ImageOverlay } from '../../src/core/model'
import { imageGeometry, initialImageGeometry, moveImage, resizeImage, setImageSize, mmToPts, ptsToMm } from '../../src/core/images/geometry'
const logo = image as ImageOverlay
const page = { width: 600, height: 800 }

test('image command snapshots, source and stacking order survive delete, undo and redo', () => {
  const store = new EditorStore()
  const input = { ...logo }
  store.dispatch(addOverlay(input))
  input.x = 999
  expect(store.state.overlays[0]).toEqual(logo)
  const before = imageGeometry(logo)
  const after = { ...before, x: 70, width: 200, height: 100 }
  store.dispatch(updateOverlay(logo.id, before, after))
  after.x = 888
  expect(store.state.overlays[0]).toMatchObject({ x: 70, width: 200, dataUrl: logo.dataUrl })
  store.undo()
  expect(store.state.overlays[0]).toEqual(logo)
  store.redo()
  const moved = store.state.overlays[0] as ImageOverlay
  store.dispatch(addOverlay({ ...logo, id: 'second' }))
  store.dispatch(removeOverlay(moved))
  store.undo()
  expect(store.state.overlays.map(o => o.id)).toEqual(['image', 'second'])
  expect(store.state.overlays[0]).toEqual(moved)
  store.redo()
  expect(store.state.overlays.map(o => o.id)).toEqual(['second'])
})

test('clone, erasing and model guards do not misclassify or change an image', () => {
  expect(isImage(logo)).toBe(true)
  const cloned = cloneOverlay(logo) as ImageOverlay
  cloned.x = 200
  expect(logo.x).toBe(10)
  expect(eraseStrokes([logo], 0, [{ x: 10, y: 20 }], 40)).toEqual([logo])
})

test('moving clamps all four edges without changing dimensions', () => {
  expect(moveImage(imageGeometry(logo), -200, 900, page)).toMatchObject({ x: 0, y: 750, width: 100, height: 50 })
  expect(moveImage(imageGeometry(logo), 900, -200, page)).toMatchObject({ x: 500, y: 0 })
})

test('four unlocked corners keep their opposite corner fixed', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100, lockAspectRatio: false }
  expect(resizeImage(rect, 'ne', 40, 20, page)).toEqual({ ...rect, width: 240, height: 120 })
  expect(resizeImage(rect, 'nw', -40, 20, page)).toEqual({ ...rect, x: 60, width: 240, height: 120 })
  expect(resizeImage(rect, 'sw', -40, -20, page)).toEqual({ ...rect, x: 60, y: 80, width: 240, height: 120 })
  expect(resizeImage(rect, 'se', 40, -20, page)).toEqual({ ...rect, y: 80, width: 240, height: 120 })
  expect(resizeImage(rect, 'ne', -999, -999, page)).toMatchObject({ x: 100, y: 100, width: 4, height: 4 })
})

test('locked resizing, numeric sizes and initial placement preserve ratios within page bounds', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100, lockAspectRatio: true }
  expect(resizeImage(rect, 'nw', -100, 0, page)).toEqual({ ...rect, x: 0, width: 300, height: 150 })
  expect(setImageSize(rect, 'height', 1000, page)).toEqual({ ...rect, width: 500, height: 250 })
  expect(setImageSize(rect, 'width', NaN, page)).toEqual(rect)
  expect(setImageSize(rect, 'width', -1, page)).toEqual(rect)
  expect(mmToPts(25.4)).toBeCloseTo(72)
  expect(ptsToMm(72)).toBeCloseTo(25.4)
  expect(initialImageGeometry(200, 100, page, { x: 0, y: 0 })).toEqual({ x: 0, y: 0, width: 275, height: 137.5, lockAspectRatio: true })
})
