import { afterEach, expect, test, vi } from 'vitest'
import { importImage, MAX_IMAGE_BYTES } from '../../src/core/images/importImage'
import { PNG_DATA_URL } from '../imageFixtures.js'
const png = () => new Uint8Array(Buffer.from(PNG_DATA_URL.split(',')[1], 'base64'))
afterEach(() => vi.unstubAllGlobals())
test('file limit is enforced before reading bytes or decoding', async () => {
  const read = vi.fn()
  await expect(importImage({ size: MAX_IMAGE_BYTES + 1, arrayBuffer: read } as unknown as File)).rejects.toThrow('50 MB')
  expect(read).not.toHaveBeenCalled()
})
test('oversized pixel dimensions are rejected before allocation/decoding', async () => {
  const bytes = png(); const view = new DataView(bytes.buffer)
  view.setUint32(16, 30_000); view.setUint32(20, 30_000)
  const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode)
  await expect(importImage(new File([bytes], 'huge.png'))).rejects.toThrow('40 Megapixel')
  expect(decode).not.toHaveBeenCalled()
})
test('decoder failures become an actionable error', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decoder')))
  await expect(importImage(new File([png()], 'broken.png'))).rejects.toThrow('beschädigt')
})
test('bitmap is closed even if a browser cannot provide a canvas context', async () => {
  const close = vi.fn()
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 120, height: 60, close }))
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) })
  await expect(importImage(new File([png()], 'logo.png'))).rejects.toThrow('Gerät')
  expect(close).toHaveBeenCalledOnce()
})
