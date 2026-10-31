import { expect, test } from 'vitest'
import { moveImage, resizeImage, setImageSize } from '../../src/core/images/geometry'
const rect = { x: 100, y: 100, width: 200, height: 100, rotation: 90, lockAspectRatio: false }
const page = { width: 400, height: 400 }
test('movement constrains the rotated footprint rather than its unrotated rectangle', () => {
  const moved = moveImage(rect, -999, 999, page)
  expect(moved.x).toBeCloseTo(-50)
  expect(moved.y).toBeCloseTo(250)
  expect(moved.width).toBe(200)
  expect(moved.height).toBe(100)
})
test('rotated corner resizing uses local axes and keeps the opposite world corner fixed', () => {
  const resized = resizeImage(rect, 'ne', 20, -40, page)
  expect(resized.x).toBeCloseTo(90)
  expect(resized.y).toBeCloseTo(70)
  expect(resized.width).toBeCloseTo(240)
  expect(resized.height).toBeCloseTo(120)
})
test('numeric width edits on a rotated image change its local width', () => {
  const resized = setImageSize(rect, 'width', 240, page)
  expect(resized.width).toBeCloseTo(240)
  expect(resized.height).toBeCloseTo(100)
  expect(resized.x).toBeCloseTo(80)
  expect(resized.y).toBeCloseTo(80)
})
test('locked rotated resizing projects pointer motion onto the dragged corner direction', () => {
  const old = { ...rect, rotation: 30, lockAspectRatio: true }
  const next = resizeImage(old, 'se', 1, 0, page)
  // SE corner direction is (123.20508,-186.60254): moving right expands it.
  expect(next.width).toBeCloseTo(200.492820323)
  expect(next.height).toBeCloseTo(100.246410162)
})
test('numeric size retains the exact requested local dimension with rotated proportions locked', () => {
  const old = { ...rect, rotation: 30, lockAspectRatio: true }
  const width = setImageSize(old, 'width', 240, page)
  expect(width.width).toBeCloseTo(240); expect(width.height).toBeCloseTo(120)
  const height = setImageSize(old, 'height', 120, page)
  expect(height.width).toBeCloseTo(240); expect(height.height).toBeCloseTo(120)
})

import { imageBounds, imageGeometry, normalizeAngle, rotateImage } from '../../src/core/images/geometry'
import { EditorStore } from '../../src/core/editorStore'
import { addOverlay, updateOverlay } from '../../src/core/commands'
import type { ImageOverlay } from '../../src/core/model'

test('arbitrary clockwise angles preserve the center, local sizes and normalize/snap as specified', () => {
  const old = { ...rect, rotation: 0 }
  expect(rotateImage(old, 37.5, page)).toEqual({ ...old, rotation: 37.5 })
  expect(rotateImage(old, -30, page)).toEqual({ ...old, rotation: 330 })
  expect(rotateImage(old, 38, page, true)).toEqual({ ...old, rotation: 45 })
  expect(normalizeAngle(450)).toBe(90)
  expect(rotateImage(old, NaN, page)).toBe(old)
  expect(rotateImage(old, 360, page)).toBe(old)
})
test('rotating at page edges moves the footprint inside, shrinking only if it cannot fit', () => {
  const rotated = rotateImage({ x: 0, y: 0, width: 300, height: 300, lockAspectRatio: true }, 45, { width: 300, height: 300 })
  expect(rotated.width).toBeCloseTo(212.13203436)
  expect(rotated.height).toBeCloseTo(212.13203436)
  const b = imageBounds(rotated)
  expect(b.left).toBeCloseTo(0); expect(b.bottom).toBeCloseTo(0)
  expect(b.right).toBeCloseTo(300); expect(b.top).toBeCloseTo(300)
})
test.each([
  ['nw', 20, 40, 90, 110], ['sw', -20, 40, 70, 110], ['se', -20, -40, 70, 70],
] as const)('corner %s at 90° preserves the opposite anchor', (corner, dx, dy, x, y) => {
  const next = resizeImage(rect, corner, dx, dy, page)
  expect(next.x).toBeCloseTo(x); expect(next.y).toBeCloseTo(y)
  expect(next.width).toBeCloseTo(240); expect(next.height).toBeCloseTo(120)
})
test('arbitrary-angle resize stops at page edges instead of clipping or moving its fixed anchor', () => {
  const old = { ...rect, rotation: 45, lockAspectRatio: true }
  const next = resizeImage(old, 'ne', 1000, -1000, page)
  expect(next.width / next.height).toBeCloseTo(2)
  const b = imageBounds(next)
  expect(b.left).toBeGreaterThanOrEqual(-1e-8); expect(b.bottom).toBeGreaterThanOrEqual(-1e-8)
  expect(b.right).toBeLessThanOrEqual(400 + 1e-8); expect(b.top).toBeLessThanOrEqual(400 + 1e-8)
  // Rotated SW corner of the original: (93.93398,185.35534).
  const c = Math.SQRT1_2
  expect(next.x + next.width / 2 - c * next.width / 2 - c * next.height / 2).toBeCloseTo(93.93398282201787)
  expect(next.y + next.height / 2 + c * next.width / 2 - c * next.height / 2).toBeCloseTo(185.35533905932738)
})
test('rotation commands undo/redo without losing source or older zero-angle image state', () => {
  const image: ImageOverlay = { kind: 'image', id: 'old', pageIndex: 0, x: 100, y: 100, width: 200, height: 100,
    lockAspectRatio: true, name: 'logo.png', dataUrl: 'data:image/png;base64,AQ==', pixelWidth: 200, pixelHeight: 100 }
  const store = new EditorStore(); store.dispatch(addOverlay(image))
  const before = imageGeometry(image)
  store.dispatch(updateOverlay(image.id, before, rotateImage(before, 37.5, page)))
  expect(store.state.overlays[0]).toMatchObject({ rotation: 37.5, dataUrl: image.dataUrl })
  store.undo(); expect(store.state.overlays[0]).toEqual(image)
  store.redo(); expect(store.state.overlays[0]).toMatchObject({ rotation: 37.5 })
})
