import { afterEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  width: 595,
  height: 842,
  render: vi.fn(() => ({ promise: Promise.resolve() })),
}))
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: mocks.width * scale, height: mocks.height * scale }),
        render: mocks.render,
      }),
    }),
    destroy: async () => {},
  }),
}))

import { loadPdf } from '../../src/core/pdf/loadPdf'
import { MAX_RENDER_PIXELS, MAX_RENDER_SIDE } from '../../src/core/pdf/renderBudget'

afterEach(() => {
  mocks.width = 595
  mocks.height = 842
  mocks.render.mockClear()
  vi.unstubAllGlobals()
})

test('oversized PDF dimensions are rejected before either canvas dimension is assigned', async () => {
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  mocks.width = mocks.height = 1_080_000
  const pdf = await loadPdf('malicious-user-unit.pdf', new Uint8Array())
  const assigned = vi.fn()
  const canvas = { dataset: {}, style: {}, set width(value: number) { assigned(value) }, set height(value: number) { assigned(value) } } as unknown as HTMLCanvasElement
  await expect(pdf.getPageSize(1)).rejects.toThrow('Seitenabmessungen')
  await expect(pdf.renderPage(1, canvas, 1)).rejects.toThrow('Seitenabmessungen')
  expect(assigned).not.toHaveBeenCalled()
  expect(mocks.render).not.toHaveBeenCalled()
  await pdf.destroy()
})

test('HiDPI rendering is capped and a rejected request does not poison the canvas queue', async () => {
  vi.stubGlobal('window', { devicePixelRatio: 4 })
  const pdf = await loadPdf('a4.pdf', new Uint8Array())
  const canvas = { dataset: {}, style: {}, width: 0, height: 0 } as unknown as HTMLCanvasElement
  await expect(pdf.renderPage(1, canvas, NaN)).rejects.toThrow('Zoom')
  await pdf.renderPage(1, canvas, 4)
  expect(canvas.width * canvas.height).toBeLessThanOrEqual(MAX_RENDER_PIXELS)
  expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(MAX_RENDER_SIDE)
  expect(canvas.style.width).toBe('2380px')
  expect(canvas.style.height).toBe('3368px')
  expect(canvas.dataset.renderState).toBe('ready')
  expect(mocks.render).toHaveBeenCalledOnce()
  await pdf.destroy()
})