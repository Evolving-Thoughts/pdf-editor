import { expect, test } from 'vitest'
import { addOverlay, CommandStack, replaceOverlays } from '../../src/core/commands'
import { eraseStrokes, strokeToSvgPath } from '../../src/core/drawing'
import { isStroke, type EditorState, type Stroke, type Textbox } from '../../src/core/model'

function makeStroke(id = 'stroke-1', points = [
  { x: 0, y: 50 },
  { x: 20, y: 50 },
  { x: 40, y: 50 },
  { x: 60, y: 50 },
]): Stroke {
  return { id, pageId: 'p0', points, color: '#111111', width: 3 }
}

function makeTextbox(id: string): Textbox {
  return {
    id,
    pageId: 'p0',
    x: 50,
    y: 700,
    text: 'Text',
    font: 'helvetica',
    fontSize: 14,
    bold: false,
    italic: false,
    underline: false,
  }
}

test('a pen stroke is one undoable command', () => {
  const state: EditorState = { overlays: [] }
  const stack = new CommandStack(state)

  stack.execute(addOverlay(makeStroke()))
  expect(state.overlays).toHaveLength(1)

  stack.undo()
  expect(state.overlays).toHaveLength(0)
  stack.redo()
  expect(state.overlays[0]).toMatchObject({ id: 'stroke-1', color: '#111111', width: 3 })
})

test('an eraser gesture splits only the touched stroke into remaining vector parts', () => {
  const textbox = makeTextbox('text-1')
  const result = eraseStrokes(
    [textbox, makeStroke()],
    'p0',
    [
      { x: 30, y: 40 },
      { x: 30, y: 60 },
    ],
    2,
  )

  expect(result[0]).toEqual(textbox)
  const strokes = result.slice(1)
  expect(strokes).toHaveLength(2)
  expect(strokes[0]).toMatchObject({
    pageId: 'p0',
    color: '#111111',
    width: 3,
    points: [
      { x: 0, y: 50 },
      { x: 20, y: 50 },
      { x: 26.5, y: 50 },
    ],
  })
  expect(strokes[1]).toMatchObject({
    pageId: 'p0',
    color: '#111111',
    width: 3,
    points: [
      { x: 33.5, y: 50 },
      { x: 40, y: 50 },
      { x: 60, y: 50 },
    ],
  })
})

test('eraser gestures are undoable as one command without undoing earlier strokes', () => {
  const state: EditorState = { overlays: [makeStroke('kept'), makeStroke()] }
  const stack = new CommandStack(state)
  const before = state.overlays.map((overlay) => ({ ...overlay }))
  const after = eraseStrokes(before, 'p0', [{ x: 30, y: 50 }], 3)

  stack.execute(replaceOverlays(before, after))
  expect(state.overlays.length).toBeGreaterThan(1)

  stack.undo()
  expect(state.overlays).toEqual(before)
  stack.redo()
  expect(state.overlays).toEqual(after)
})

test('strokes convert PDF bottom-left coordinates to an exact SVG path', () => {
  expect(
    strokeToSvgPath(
      [
        { x: 10, y: 700 },
        { x: 100, y: 650 },
      ],
      842,
    ),
  ).toBe('M 10 142 L 100 192')
})

test('a sparse long stroke keeps both sides when a small eraser touches its middle', () => {
  const source = makeStroke('long', [{ x: 0, y: 50 }, { x: 100, y: 50 }])
  source.width = 2
  const result = eraseStrokes([source], 'p0', [{ x: 50, y: 50 }], 4)
  expect(result).toHaveLength(2)
  expect(result[0]).toMatchObject({ points: [{ x: 0, y: 50 }, { x: 45, y: 50 }] })
  const second = result.filter(isStroke)[1]
  expect(second.points[0].x).toBeCloseTo(55, 8)
  expect(second.points[0].y).toBe(50)
  expect(second.points[1]).toEqual({ x: 100, y: 50 })
  expect(source.points).toEqual([{ x: 0, y: 50 }, { x: 100, y: 50 }])
})

test('eraser misses preserve array identity and never affect text or another page', () => {
  const other = { ...makeStroke('other'), pageId: 'p1' }
  const overlays = [makeTextbox('text'), other, makeStroke()]
  expect(eraseStrokes(overlays, 'p0', [{ x: 200, y: 200 }], 4)).toBe(overlays)
  const result = eraseStrokes(overlays, 'p0', [{ x: 30, y: 50 }], 3)
  expect(result[0]).toBe(overlays[0])
  expect(result[1]).toBe(other)
})

test('eraser removes a dot but a miss leaves it intact', () => {
  const dot = [makeStroke('dot', [{ x: 10, y: 10 }])]
  expect(eraseStrokes(dot, 'p0', [{ x: 30, y: 30 }], 3)).toBe(dot)
  expect(eraseStrokes(dot, 'p0', [{ x: 10, y: 10 }], 3)).toEqual([])
})

test('a fast swept eraser removes the entire capsule, not just its sampled endpoints', () => {
  const source = makeStroke('long', [{ x: 0, y: 50 }, { x: 100, y: 50 }])
  source.width = 2
  const result = eraseStrokes([source], 'p0', [{ x: 50, y: 0 }, { x: 50, y: 100 }], 4).filter(isStroke)
  expect(result).toHaveLength(2)
  expect(result[0].points[1].x).toBeCloseTo(45, 8)
  expect(result[1].points[0].x).toBeCloseTo(55, 8)
})

test('stored and command snapshots do not share mutable stroke points', async () => {
  const { EditorStore } = await import('../../src/core/editorStore')
  const source = makeStroke()
  const store = new EditorStore()
  store.restore({ overlays: [source] })
  source.points[0].x = 999
  expect(store.state.overlays.filter(isStroke)[0].points[0].x).toBe(0)
  const fresh = makeStroke('new')
  store.dispatch(addOverlay(fresh))
  fresh.points[0].x = 999
  store.undo()
  store.redo()
  expect(store.state.overlays.filter(isStroke)[1].points[0].x).toBe(0)
})
