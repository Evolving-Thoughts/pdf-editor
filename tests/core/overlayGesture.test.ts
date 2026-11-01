import { expect, test } from 'vitest'
import { arrowStep, arrowTurn, moveTextbox, nudgeCommand, pointerAngle, PointerGesture, sameScene, type GestureScene, type PointerSample } from '../../src/core/overlayGesture'
import { EditorStore } from '../../src/core/editorStore'
import type { ImageOverlay, Stroke, Textbox } from '../../src/core/model'

const scene: GestureScene = { zoom: 2, version: 1, tool: 'select', active: true }
const at = (clientX: number, clientY: number, pointerId = 1): PointerSample => ({ pointerId, clientX, clientY, shiftKey: false })
const page = { width: 100, height: 200 }
const box: Textbox = { id: 't', pageId: 'p0', x: 10, y: 10, text: 'x', font: 'helvetica', fontSize: 12, bold: false, italic: false, underline: false }
const image: ImageOverlay = { kind: 'image', id: 'i', pageId: 'p0', x: 90, y: 10, width: 10, height: 10, lockAspectRatio: true, dataUrl: 'data:,', name: 'a', pixelWidth: 1, pixelHeight: 1 }

test('a step reports page points, y upwards, whatever the zoom', () => {
  const gesture = new PointerGesture<string>()
  gesture.begin(at(10, 10), scene, 'data')
  expect(gesture.step(at(30, 0), scene)).toMatchObject({ data: 'data', dx: 10, dy: 5, valid: true })
})

test('only one pointer at a time, and a foreign pointer has no effect', () => {
  const gesture = new PointerGesture<void>()
  expect(gesture.begin(at(0, 0), scene, undefined)).toBe(true)
  expect(gesture.begin(at(0, 0, 2), scene, undefined)).toBe(false)
  expect(gesture.step(at(5, 5, 2), scene)).toBeNull()
  expect(gesture.step(at(5, 5), scene)).not.toBeNull()
})

test.each<[string, Partial<GestureScene>]>([
  ['zoom', { zoom: 1 }], ['document version', { version: 2 }], ['tool', { tool: 'pen' }], ['editability', { active: false }],
])('a changed %s makes the gesture invalid', (_, change) => {
  const gesture = new PointerGesture<void>()
  gesture.begin(at(0, 0), scene, undefined)
  expect(gesture.step(at(1, 1), { ...scene, ...change })?.valid).toBe(false)
})

test('a gesture may start on an overlay that only becomes active through it', () => {
  expect(sameScene({ ...scene, active: false }, scene)).toBe(true)
})

test('after a cancel the gesture is over and a new one can start', () => {
  const gesture = new PointerGesture<void>()
  gesture.begin(at(0, 0), scene, undefined)
  gesture.cancel()
  expect(gesture.step(at(1, 1), scene)).toBeNull()
  expect(gesture.begin(at(0, 0, 2), scene, undefined)).toBe(true)
})

test('arrow keys mean the same everywhere, and other keys mean nothing', () => {
  expect(arrowStep({ key: 'ArrowLeft', shiftKey: false })).toEqual({ dx: -1, dy: 0 })
  expect(arrowStep({ key: 'ArrowUp', shiftKey: true })).toEqual({ dx: 0, dy: 10 })
  expect(arrowStep({ key: 'Enter', shiftKey: false })).toBeNull()
  expect(arrowTurn({ key: 'ArrowDown', shiftKey: true })).toBe(-15)
  expect(arrowTurn({ key: 'ArrowRight', shiftKey: false })).toBe(1)
  expect(arrowTurn({ key: 'Tab', shiftKey: false })).toBeNull()
})

test('rotation handles measure the angle around the center', () => {
  expect(pointerAngle({ x: 0, y: 0 }, at(0, 5))).toBe(90)
})

test('a textbox anchor stays on the page in every direction', () => {
  expect(moveTextbox({ x: 5, y: 5 }, -10, -10, page)).toEqual({ x: 0, y: 0 })
  expect(moveTextbox({ x: 95, y: 195 }, 10, 10, page)).toEqual({ x: 100, y: 200 })
})

test('a nudge is one undoable command for textboxes and images alike', () => {
  const store = new EditorStore()
  store.state.overlays.push({ ...box }, { ...image })
  store.dispatch(nudgeCommand(box, { dx: 1, dy: 2 }, page)!)
  expect(store.state.overlays[0]).toMatchObject({ x: 11, y: 12 })
  store.undo()
  expect(store.state.overlays[0]).toMatchObject({ x: 10, y: 10 })
  store.dispatch(nudgeCommand(image, { dx: -1, dy: 0 }, page)!)
  expect(store.state.overlays[1]).toMatchObject({ x: 89 })
})

test('no command at the page edge, and none for strokes', () => {
  expect(nudgeCommand(image, { dx: 1, dy: 0 }, page)).toBeNull()
  expect(nudgeCommand({ ...box, x: 100 }, { dx: 1, dy: 0 }, page)).toBeNull()
  const stroke: Stroke = { id: 's', pageId: 'p0', points: [], color: '#000', width: 1 }
  expect(nudgeCommand(stroke, { dx: 1, dy: 0 }, page)).toBeNull()
})
