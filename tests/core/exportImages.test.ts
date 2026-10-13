import { expect, test } from 'vitest'
import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { exportPdf } from '../../src/core/pdf/exportPdf'
import type { ImageOverlay } from '../../src/core/model'
import { PNG_DATA_URL, JPEG_DATA_URL } from '../imageFixtures.js'
const image: ImageOverlay = { kind: 'image', id: 'logo', pageIndex: 0, x: 40, y: 60, width: 120, height: 80,
  lockAspectRatio: false, name: 'logo.png', pixelWidth: 120, pixelHeight: 60, dataUrl: PNG_DATA_URL }
function contents(doc: PDFDocument, index: number) {
  const value = doc.getPage(index).node.Contents()!
  const streams = value instanceof PDFArray ? value.asArray() : [value]
  return streams.map(ref => Buffer.from(decodePDFRawStream(doc.context.lookup(ref, PDFRawStream)).decode()).toString()).join('\n')
}
test('PNG and JPG are embedded as images at exact rectangle size, on the specified page', async () => {
  const doc = await PDFDocument.create(); doc.addPage([600, 800]); doc.addPage([600, 800])
  const result = await PDFDocument.load(await exportPdf(await doc.save(), [image, { ...image, id: 'jpg', pageIndex: 1, dataUrl: JPEG_DATA_URL }]))
  for (const index of [0, 1]) {
    const stream = contents(result, index)
    expect(stream).toContain('1 0 0 1 40 60 cm')
    expect(stream).toContain('120 0 0 80 0 0 cm')
    expect(stream).toMatch(/\/Image-\S+ Do/)
    const objects = result.getPage(index).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    const embedded = result.context.lookup(objects.values()[0], PDFRawStream)
    expect(embedded.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(120)
    expect(embedded.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber()).toBe(60)
    if (index === 0) expect(embedded.dict.has(PDFName.of('SMask'))).toBe(true)
  }
})

test.each([
  [0, '1 0 0 1 70 100 cm'],
  [90, '1 0 0 1 400 90 cm'],
  [180, '1 0 0 1 410 410 cm'],
  [270, '1 0 0 1 80 420 cm'],
])('rotation %i maps the visible CropBox and UserUnit back to PDF coordinates', async (rotation, translation) => {
  const doc = await PDFDocument.create(); const page = doc.addPage([600, 800])
  page.setCropBox(50, 70, 380, 370); page.setRotation(degrees(rotation))
  page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))
  const result = await PDFDocument.load(await exportPdf(await doc.save(), [image]))
  const stream = contents(result, 0)
  expect(stream).toContain(translation)
  expect(stream).toContain('60 0 0 40 0 0 cm')
  const expected = rotation === 0 ? /1 0 0 1 0 0 cm/ : rotation === 90 ? /0\.\d+ 1 -1 0\.\d+ 0 0 cm/ : rotation === 180 ? /-1 0\.\d+ -0\.\d+ -1 0 0 cm/ : /-0\.\d+ -1 1 -0\.\d+ 0 0 cm/
  expect(stream).toMatch(expected)
})

test('identical sources share the embedded PDF image but remain independently placed', async () => {
  const doc = await PDFDocument.create(); doc.addPage([600, 800])
  const result = await PDFDocument.load(await exportPdf(await doc.save(), [image, { ...image, id: 'two', x: 250 }]))
  const resources = result.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
  const refs = resources.values().map(ref => ref.toString())
  expect(new Set(refs).size).toBe(1)
  expect(contents(result, 0)).toContain('1 0 0 1 250 60 cm')
})

test('clockwise image rotation is centered, with the same source and dimensions', async () => {
  const doc = await PDFDocument.create(); doc.addPage([600, 800])
  const rotated = { ...image, x: 100, y: 200, width: 120, height: 60, rotation: 90 }
  const result = await PDFDocument.load(await exportPdf(await doc.save(), [rotated]))
  const stream = contents(result, 0)
  // Center (160,230); rotated bottom-left is (130,290), clockwise 90°.
  expect(stream).toContain('1 0 0 1 130 290 cm')
  expect(stream).toMatch(/0\.\d+ -1 1 0\.\d+ 0 0 cm/)
  expect(stream).toContain('120 0 0 60 0 0 cm')
})

test('a 30° clockwise image uses independently calculated origin and rotation operators', async () => {
  const doc = await PDFDocument.create(); doc.addPage([600, 800])
  const result = await PDFDocument.load(await exportPdf(await doc.save(), [{ ...image, x: 100, y: 200, width: 120, height: 60, rotation: 30 }]))
  const stream = contents(result, 0)
  const translation = /1 0 0 1 ([-\d.]+) ([-\d.]+) cm/.exec(stream)!
  expect(Number(translation[1])).toBeCloseTo(93.03847577293368)
  expect(Number(translation[2])).toBeCloseTo(234.01923788646684)
  expect(stream).toContain('120 0 0 60 0 0 cm')
  expect(stream).toMatch(/0\.866\d+ -0\.499\d+ 0\.499\d+ 0\.866\d+ 0 0 cm/)
})
