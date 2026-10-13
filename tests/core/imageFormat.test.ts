import { expect, test } from 'vitest'
import { inspectImage } from '../../src/core/images/imageFormat'
import { PNG_DATA_URL, JPEG_DATA_URL } from '../imageFixtures.js'
const bytes = (url: string) => new Uint8Array(Buffer.from(url.split(',')[1], 'base64'))
test('reads real PNG and JPG dimensions before pixel decoding', () => {
  expect(inspectImage(bytes(PNG_DATA_URL))).toEqual({ width: 120, height: 60 })
  expect(inspectImage(bytes(JPEG_DATA_URL))).toEqual({ width: 120, height: 60 })
})
test('rejects fake, truncated and zero-sized image metadata', () => {
  expect(() => inspectImage(new Uint8Array([1, 2, 3]))).toThrow('PNG- oder JPG')
  expect(() => inspectImage(bytes(PNG_DATA_URL).slice(0, 12))).toThrow('PNG')
  expect(() => inspectImage(bytes(JPEG_DATA_URL).slice(0, 8))).toThrow('JPG')
  const invalid = bytes(PNG_DATA_URL); invalid.fill(0, 16, 20)
  expect(() => inspectImage(invalid)).toThrow('Größe')
})
test('allows pre-decode checks to detect excessive PNG dimensions', () => {
  const huge = bytes(PNG_DATA_URL); const view = new DataView(huge.buffer)
  view.setUint32(16, 30_000); view.setUint32(20, 30_000)
  expect(inspectImage(huge)).toEqual({ width: 30_000, height: 30_000 })
})
