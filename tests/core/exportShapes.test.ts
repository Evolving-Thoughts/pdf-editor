import { expect, test } from 'vitest'
import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  decodePDFRawStream,
  LineJoinStyle,
  popGraphicsState,
  pushGraphicsState,
  setLineJoin,
  rgb,
} from 'pdf-lib'
import { exportPdf } from '../../src/core/pdf/exportPdf'
import { createShape } from '../../src/core/shapes'
import type { ShapeOverlay, Textbox } from '../../src/core/model'
function contents(doc: PDFDocument) {
  const value = doc.getPage(0).node.Contents()
  if (!value) return ''
  return (value instanceof PDFArray ? value.asArray() : [value])
    .map((ref) =>
      new TextDecoder().decode(decodePDFRawStream(doc.context.lookup(ref, PDFRawStream)).decode()),
    )
    .join('\n')
}
const rect: ShapeOverlay = {
  kind: 'shape',
  shape: 'rect',
  id: 'rect',
  pageIndex: 0,
  x: 100,
  y: 200,
  width: 120,
  height: 60,
  rotation: 90,
  fill: '#ffffff',
  strokeColor: null,
  strokeWidth: 3,
}
test('rotated shape export uses the centered top-left origin and omits a disabled contour', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([600, 800])
  const output = await PDFDocument.load(await exportPdf(await doc.save(), [rect]))
  const stream = contents(output)
  // Center (160,230); clockwise-rotated top-left is (190,290).
  expect(stream).toContain('1 0 0 1 190 290 cm')
  expect(stream).toContain('1 1 1 rg')
  expect(stream).toContain('f\n')
  expect(stream).not.toContain('S\n')
})
test('white correction is painted before later text, while an invisible shape emits nothing', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([600, 800])
  const text: Textbox = {
    id: 'text',
    pageIndex: 0,
    x: 110,
    y: 220,
    text: 'Korrektur',
    font: 'helvetica',
    fontSize: 14,
    bold: false,
    italic: false,
    underline: false,
  }
  const output = await PDFDocument.load(await exportPdf(await doc.save(), [{ ...rect, rotation: 0 }, text]))
  const stream = contents(output)
  expect(stream.indexOf('1 1 1 rg')).toBeLessThan(stream.indexOf('BT'))
  const invisible = await PDFDocument.load(await exportPdf(await doc.save(), [{ ...rect, fill: null }]))
  expect(contents(invisible)).toBe('')
})

test('marker export has transparency and Multiply blending, and cubic ellipse/arrow are vector paths', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([600, 800])
  const marker = createShape(
    'marker',
    [
      { x: 100, y: 200 },
      { x: 300, y: 200 },
    ],
    0,
    { fill: null, strokeColor: '#ffe34d', strokeWidth: 24 },
  )!
  const output = await PDFDocument.load(await exportPdf(await doc.save(), [marker]))
  const resources = output.getPage(0).node.Resources()!.toString()
  expect(resources).toContain('/CA 0.35')
  expect(resources).toContain('/BM /Multiply')
  const ellipse = await PDFDocument.load(
    await exportPdf(await doc.save(), [{ ...rect, shape: 'ellipse', strokeColor: '#111111' }]),
  )
  expect(contents(ellipse).match(/ c\n/g)).toHaveLength(4)
  const arrow = createShape(
    'arrow',
    [
      { x: 100, y: 200 },
      { x: 300, y: 200 },
    ],
    0,
    { fill: null, strokeColor: '#111111', strokeWidth: 3 },
  )!
  const arrowDoc = await PDFDocument.load(await exportPdf(await doc.save(), [arrow]))
  expect(contents(arrowDoc).match(/ l\n/g)).toHaveLength(3)
})

test('correction and later text share displayed coordinates on rotated cropped UserUnit pages', async () => {
  const { degrees, PDFName, PDFNumber } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([600, 800])
  page.setCropBox(50, 70, 380, 370)
  page.setRotation(degrees(90))
  page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))
  const text: Textbox = {
    id: 'text',
    pageIndex: 0,
    x: 100,
    y: 200,
    text: 'Korrektur',
    font: 'helvetica',
    fontSize: 14,
    bold: false,
    italic: false,
    underline: true,
  }
  const output = await PDFDocument.load(await exportPdf(await doc.save(), [{ ...rect, rotation: 0 }, text]))
  const stream = contents(output)
  // Displayed (100,200)/2 -> rotated PDF (330,120); font size scales by UserUnit.
  expect(stream).toContain('1 0 0 1 300 120 cm') // cover top-left displayed (100,260)
  expect(stream).toContain('7 Tf')
  const matrix = stream
    .split('\n')
    .find((line) => line.endsWith(' Tm'))!
    .split(' ')
    .slice(0, 6)
    .map(Number)
  ;[0, 1, -1, 0, 330, 120].forEach((value, index) => expect(matrix[index]).toBeCloseTo(value))
})

// Interpret the emitted graphics-state operators rather than only looking for
// "1 j": missing q/Q restoration must also fail this regression.
test.each(['rect', 'ellipse', 'line', 'arrow', 'marker'] as const)(
  '%s exports round joins in an isolated graphics state',
  async (kind) => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([600, 800])
    page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Bevel))
    page.drawSvgPath('M 20 20 L 60 20 L 60 60', { borderColor: rgb(0, 0, 0), borderWidth: 4 })
    page.pushOperators(popGraphicsState())
    const shape = createShape(
      kind,
      [
        { x: 100, y: 200 },
        { x: 160, y: 260 },
        { x: 220, y: 220 },
      ],
      0,
      { fill: null, strokeColor: '#111111', strokeWidth: 6 },
    )!
    const text: Textbox = {
      id: 'after-shape',
      pageIndex: 0,
      x: 100,
      y: 150,
      text: 'Nachfolgend',
      font: 'helvetica',
      fontSize: 14,
      bold: false,
      italic: false,
      underline: true,
    }
    const original = JSON.stringify(shape)
    const output = await PDFDocument.load(await exportPdf(await doc.save(), [shape, text]))
    const stack: number[] = []
    const paintedJoins: number[] = []
    let join = LineJoinStyle.Miter
    for (const operator of contents(output)
      .split('\n')
      .map((line) => line.trim())) {
      if (operator === 'q') stack.push(join)
      else if (operator === 'Q') {
        expect(stack.length).toBeGreaterThan(0)
        join = stack.pop()!
      } else if (/^[012] j$/.test(operator)) join = Number(operator[0])
      else if (operator === 'S') paintedJoins.push(join)
    }
    expect(stack).toHaveLength(0)
    expect(paintedJoins).toEqual([
      LineJoinStyle.Bevel, // Original PDF path is untouched.
      LineJoinStyle.Round, // This exported shape matches the SVG preview.
      LineJoinStyle.Miter, // Later underline sees the original/default state.
    ])
    expect(join).toBe(LineJoinStyle.Miter)
    expect(JSON.stringify(shape)).toBe(original)
  },
)
