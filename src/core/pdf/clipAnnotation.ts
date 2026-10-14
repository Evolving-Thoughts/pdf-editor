import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, type PDFObject,
  concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState,
} from 'pdf-lib'
import type { DocumentPage } from '../pages'

function numbers(value: unknown, length: number): number[] | undefined {
  if (!(value instanceof PDFArray) || value.size() !== length) return
  const values = Array.from({ length }, (_, i) => {
    const v = value.lookup(i)
    return v instanceof PDFNumber ? v.asNumber() : NaN
  })
  return values.every(Number.isFinite) ? values : undefined
}
/** Annotation appearances are outside page content streams; clip them separately. */
export function clipAnnotation(doc: PDFDocument, annotation: PDFDict, box: DocumentPage['box']) {
  const rect = numbers(annotation.lookup(PDFName.of('Rect')), 4)
  if (!rect) return
  const [x0, y0, x1, y1] = rect
  const left = Math.max(x0, box.x), bottom = Math.max(y0, box.y)
  const right = Math.min(x1, box.x + box.width), top = Math.min(y1, box.y + box.height)
  if (right <= left || top <= bottom) {
    const flags = annotation.lookup(PDFName.of('F'))
    annotation.set(PDFName.of('F'), PDFNumber.of((flags instanceof PDFNumber ? flags.asNumber() : 0) | 2))
    return
  }
  if (left === x0 && bottom === y0 && right === x1 && top === y1) return
  const ap = annotation.lookup(PDFName.of('AP'))
  function wrap(value: unknown, statesAllowed = true): PDFObject | undefined {
    if (value instanceof PDFDict && statesAllowed) {
      const states = value.clone(doc.context)
      for (const [name] of states.entries()) {
        const wrapped = wrap(states.lookup(name), false)
        if (wrapped) states.set(name, wrapped)
      }
      return states
    }
    if (!(value instanceof PDFStream)) return
    const bounds = numbers(value.dict.lookup(PDFName.of('BBox')), 4)
    if (!bounds) throw new Error('Ein beschnittenes Annotationsfeld hat keine gültige Darstellung.')
    const [a, b, c, d, e, f] = numbers(value.dict.lookup(PDFName.of('Matrix')), 6) ?? [1, 0, 0, 1, 0, 0]
    const corners = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]]
      .map(([x, y]) => [a * x + c * y + e, b * x + d * y + f])
    const minX = Math.min(...corners.map(p => p[0])), minY = Math.min(...corners.map(p => p[1]))
    const w = Math.max(...corners.map(p => p[0])) - minX, h = Math.max(...corners.map(p => p[1])) - minY
    if (w <= 0 || h <= 0) throw new Error('Ein beschnittenes Annotationsfeld hat eine leere Darstellung.')
    const sx = (x1 - x0) / w, sy = (y1 - y0) / h
    return doc.context.register(doc.context.formXObject([
      pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, x0 - left - minX * sx, y0 - bottom - minY * sy),
      drawObject('Original'), popGraphicsState(),
    ], { BBox: [0, 0, right - left, top - bottom], Resources: { XObject: { Original: doc.context.register(value) } } }))
  }
  if (ap instanceof PDFDict) {
    const copy = ap.clone(doc.context)
    for (const [key] of copy.entries()) {
      const wrapped = wrap(copy.lookup(key))
      if (wrapped) copy.set(key, wrapped)
    }
    annotation.set(PDFName.of('AP'), copy)
  }
  annotation.set(PDFName.of('Rect'), doc.context.obj([left, bottom, right, top]))
}
