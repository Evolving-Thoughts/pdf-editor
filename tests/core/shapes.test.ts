import { expect, test, vi } from 'vitest'
import { createShape } from '../../src/core/shapes'
import { addOverlay, removeOverlay, updateOverlay } from '../../src/core/commands'
import { EditorStore } from '../../src/core/editorStore'
import { shapeGeometry } from '../../src/core/shapes'
import type { Textbox } from '../../src/core/model'
import { moveShape, resizeShape, rotateShape } from '../../src/core/shapes'
import { shapeWorldPoints, setShapeEndpoint, shapeToSvgPath } from '../../src/core/shapes'

test('drawing a rectangle in reverse direction retains the exact visible bounds and independent styles', () => {
  expect(
    createShape(
      'rect',
      [
        { x: 300, y: 300 },
        { x: 100, y: 200 },
      ],
      0,
      { fill: '#ffffff', strokeColor: null, strokeWidth: 3 },
      'cover',
    ),
  ).toEqual({
    kind: 'shape',
    shape: 'rect',
    id: 'cover',
    pageIndex: 0,
    x: 100,
    y: 200,
    width: 200,
    height: 100,
    rotation: 0,
    fill: '#ffffff',
    strokeColor: null,
    strokeWidth: 3,
  })
})

test('shape commands keep a cover before later text and restore its exact order and styles on undo', () => {
  const cover = createShape(
    'rect',
    [
      { x: 100, y: 200 },
      { x: 300, y: 300 },
    ],
    0,
    { fill: '#ffffff', strokeColor: null, strokeWidth: 3 },
    'cover',
  )!
  const text: Textbox = {
    id: 'text',
    pageIndex: 0,
    x: 120,
    y: 220,
    text: 'Korrektur',
    font: 'helvetica',
    fontSize: 14,
    bold: false,
    italic: false,
    underline: false,
  }
  const store = new EditorStore()
  store.dispatch(addOverlay(cover))
  store.dispatch(addOverlay(text))
  expect(store.state.overlays.map((o) => o.id)).toEqual(['cover', 'text'])
  const before = shapeGeometry(cover),
    after = { ...before, x: 150, fill: null, strokeColor: '#111111' }
  store.dispatch(updateOverlay(cover.id, before, after))
  after.x = 999
  expect(store.state.overlays[0]).toMatchObject({ x: 150, fill: null, strokeColor: '#111111' })
  store.dispatch(removeOverlay(store.state.overlays[0] as typeof cover))
  store.undo()
  expect(store.state.overlays.map((o) => o.id)).toEqual(['cover', 'text'])
  store.undo()
  expect(store.state.overlays[0]).toEqual(cover)
})

const bounds = { width: 640, height: 790 }
const geometry = {
  x: 100,
  y: 100,
  width: 200,
  height: 100,
  rotation: 0,
  fill: null,
  strokeColor: '#111111',
  strokeWidth: 3,
}
test.each([
  ['ne', 40, 20, 100, 100],
  ['nw', -40, 20, 60, 100],
  ['sw', -40, -20, 60, 80],
  ['se', 40, -20, 100, 80],
] as const)(
  'corner %s scales independently while keeping its opposite corner fixed',
  (corner, dx, dy, x, y) => {
    expect(resizeShape(geometry, corner, dx, dy, bounds)).toMatchObject({ x, y, width: 240, height: 120 })
  },
)
test('arbitrary rotation, snapped rotation and page-edge movement retain local dimensions', () => {
  expect(rotateShape(geometry, -30, bounds)).toEqual({ ...geometry, rotation: 330 })
  expect(rotateShape(geometry, 38, bounds, true)).toEqual({ ...geometry, rotation: 45 })
  const moved = moveShape({ ...geometry, rotation: 90 }, -999, 999, bounds)
  expect(moved.x).toBeCloseTo(-50)
  expect(moved.y).toBeCloseTo(640)
  expect(moved).toMatchObject({ width: 200, height: 100 })
  expect(resizeShape({ ...geometry, rotation: 90 }, 'ne', 20, -40, bounds)).toMatchObject({
    x: 90,
    y: 70,
    width: 240,
    height: 120,
  })
})

test('vertical lines and reverse horizontal arrows retain endpoints without inventing a fill', () => {
  expect(
    createShape(
      'line',
      [
        { x: 100, y: 300 },
        { x: 100, y: 200 },
      ],
      0,
      { fill: '#ffffff', strokeColor: '#111111', strokeWidth: 3 },
      'line',
    ),
  ).toMatchObject({
    x: 100,
    y: 200,
    width: 0,
    height: 100,
    flipX: false,
    flipY: true,
    fill: null,
  })
  expect(
    createShape(
      'arrow',
      [
        { x: 300, y: 200 },
        { x: 100, y: 200 },
      ],
      0,
      { fill: null, strokeColor: '#111111', strokeWidth: 3 },
      'arrow',
    ),
  ).toMatchObject({
    x: 100,
    y: 200,
    width: 200,
    height: 0,
    flipX: true,
    flipY: false,
  })
})
test('a freehand marker keeps every sampled point in immutable local fractions', () => {
  const marker = createShape(
    'marker',
    [
      { x: 100, y: 200 },
      { x: 180, y: 230 },
      { x: 200, y: 200 },
    ],
    1,
    { fill: null, strokeColor: '#ffe34b', strokeWidth: 24 },
    'marker',
  )!
  expect(marker).toMatchObject({
    x: 100,
    y: 200,
    width: 100,
    height: 30,
    markerPoints: [
      { x: 0, y: 0 },
      { x: 0.8, y: 1 },
      { x: 1, y: 0 },
    ],
  })
})

test('rotated line endpoint editing fixes the other endpoint and retains its angle', () => {
  const line = createShape(
    'line',
    [
      { x: 100, y: 100 },
      { x: 300, y: 200 },
    ],
    0,
    { fill: null, strokeColor: '#111111', strokeWidth: 3 },
    'line',
  )!
  line.rotation = 90
  const points = shapeWorldPoints(line)
  expect(points[0].x).toBeCloseTo(150)
  expect(points[0].y).toBeCloseTo(250)
  expect(points[1].x).toBeCloseTo(250)
  expect(points[1].y).toBeCloseTo(50)
  const next = { ...line, ...setShapeEndpoint(line, 'end', { x: 270, y: 40 }, bounds) }
  expect(next.rotation).toBe(90)
  expect(next.width).toBeCloseTo(210)
  expect(next.height).toBeCloseTo(120)
  const changed = shapeWorldPoints(next)
  expect(changed[0].x).toBeCloseTo(150)
  expect(changed[0].y).toBeCloseTo(250)
  expect(changed[1].x).toBeCloseTo(270)
  expect(changed[1].y).toBeCloseTo(40)
})
test('local marker and rectangle paths match independently known SVG coordinates', () => {
  const marker = createShape(
    'marker',
    [
      { x: 100, y: 200 },
      { x: 180, y: 230 },
      { x: 200, y: 200 },
    ],
    0,
    { fill: null, strokeColor: '#ffe34b', strokeWidth: 24 },
    'mark',
  )!
  expect(shapeToSvgPath(marker)).toBe('M 0 30 L 80 0 L 100 30')
  expect(shapeToSvgPath({ ...marker, shape: 'rect', width: 120, height: 60 })).toBe(
    'M 0 0 L 120 0 L 120 60 L 0 60 Z',
  )
})

const style = { fill: null, strokeColor: '#111111', strokeWidth: 3 }

test('rapid shape nudges merge but changing the action starts a new undo step', async () => {
  const { nudgeOverlay } = await import('../../src/core/commands')
  const store = new EditorStore()
  const shape = createShape(
    'rect',
    [
      { x: 100, y: 100 },
      { x: 200, y: 160 },
    ],
    0,
    style,
    'nudge',
  )!
  store.dispatch(addOverlay(shape))
  const a = shapeGeometry(shape),
    b = { ...a, x: 101 },
    c = { ...a, x: 102 }
  store.dispatch(nudgeOverlay(shape.id, a, b, 'move'))
  store.dispatch(nudgeOverlay(shape.id, b, c, 'move'))
  store.dispatch(nudgeOverlay(shape.id, c, { ...c, rotation: 1 }, 'rotate'))
  store.undo()
  expect(store.state.overlays[0]).toMatchObject({ x: 102, rotation: 0 })
  store.undo()
  expect(store.state.overlays[0]).toMatchObject({ x: 100 })
})
test('long markers and single-point markers have drawable paths without argument overflow', () => {
  const long = createShape(
    'marker',
    Array.from({ length: 200000 }, (_, i) => ({ x: i % 300, y: i % 200 })),
    0,
    style,
  )!
  expect(long.width).toBe(299)
  const dot = createShape('marker', [{ x: 100, y: 100 }], 0, style)!
  expect(shapeToSvgPath(dot)).toBe('M 2 2 L 2.01 2')
})

test('eraser splits markers but retains forms; clearing drawing removes markers as one reversible step', async () => {
  const { eraseStrokes } = await import('../../src/core/drawing')
  const { clearDrawing, replaceOverlays } = await import('../../src/core/commands')
  const marker = createShape(
    'marker',
    [
      { x: 100, y: 200 },
      { x: 300, y: 200 },
    ],
    0,
    { ...style, strokeWidth: 12 },
    'marker',
  )!
  const form = createShape(
    'rect',
    [
      { x: 100, y: 100 },
      { x: 200, y: 160 },
    ],
    0,
    style,
    'form',
  )!
  const store = new EditorStore()
  store.restore({ overlays: [marker, form] })
  const after = eraseStrokes(store.state.overlays, 0, [{ x: 200, y: 200 }], 8)
  expect(after).toHaveLength(3)
  expect(after[2]).toEqual(form)
  expect(after[0]).toMatchObject({ shape: 'marker', strokeWidth: 12, strokeColor: '#111111' })
  store.dispatch(replaceOverlays(store.state.overlays, after))
  store.undo()
  expect(store.state.overlays).toEqual([marker, form])
  store.dispatch(clearDrawing(store.state.overlays))
  expect(store.state.overlays).toEqual([form])
  store.undo()
  expect(store.state.overlays).toEqual([marker, form])
})

test('style objects cannot overwrite the calculated shape geometry', () => {
  const supplied = { ...style, x: 999, width: 999 }
  const rect = createShape(
    'rect',
    [
      { x: 100, y: 100 },
      { x: 200, y: 160 },
    ],
    0,
    supplied,
  )!
  expect(rect).toMatchObject({ x: 100, y: 100, width: 100, height: 60 })
})

test.each(['nw', 'ne', 'sw', 'se'] as const)(
  'rotated %s resize fixes the opposite world corner',
  (corner) => {
    const initial = { ...geometry, rotation: 30 }
    const after = resizeShape(initial, corner, 20, 15, bounds)
    const east = corner.endsWith('e'),
      north = corner.startsWith('n')
    // Independent centered CW transform of the opposite local corner.
    const point = (box: typeof initial) => {
      const dx = (east ? -0.5 : 0.5) * box.width,
        dy = (north ? -0.5 : 0.5) * box.height
      return {
        x: box.x + box.width / 2 + Math.cos(Math.PI / 6) * dx + Math.sin(Math.PI / 6) * dy,
        y: box.y + box.height / 2 - Math.sin(Math.PI / 6) * dx + Math.cos(Math.PI / 6) * dy,
      }
    }
    expect(point(after).x).toBeCloseTo(point(initial).x)
    expect(point(after).y).toBeCloseTo(point(initial).y)
  },
)

test('a pause or a different element breaks shape keyboard undo grouping', async () => {
  const { nudgeOverlay } = await import('../../src/core/commands')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    const store = new EditorStore(),
      first = createShape(
        'rect',
        [
          { x: 100, y: 100 },
          { x: 200, y: 160 },
        ],
        0,
        style,
        'first',
      )!
    const second = { ...first, id: 'second' }
    store.restore({ overlays: [first, second] })
    const a = shapeGeometry(first),
      b = { ...a, x: 101 },
      c = { ...a, x: 102 }
    store.dispatch(nudgeOverlay(first.id, a, b))
    clock.mockReturnValue(2101)
    store.dispatch(nudgeOverlay(first.id, b, c))
    store.dispatch(nudgeOverlay(second.id, a, b))
    store.undo()
    expect((store.state.overlays[1] as typeof first).x).toBe(100)
    store.undo()
    expect((store.state.overlays[0] as typeof first).x).toBe(101)
    store.undo()
    expect((store.state.overlays[0] as typeof first).x).toBe(100)
  } finally {
    clock.mockRestore()
  }
})
