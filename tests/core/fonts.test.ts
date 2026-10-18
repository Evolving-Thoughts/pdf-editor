import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { bundledFontUrl, loadBundledFont } from '../../src/core/fonts'
import { exportPdf } from '../../src/core/pdf/exportPdf'
import type { Textbox } from '../../src/core/model'

afterEach(() => vi.unstubAllGlobals())

test('each bundled family/style embeds a real font program and preserves searchable German text', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const file = /noto-(sans|serif)-latin-(400|700)-(normal|italic)\.woff/.exec(url)
    if (!file) throw new Error(`Unexpected font asset: ${url}`)
    return new Response(readFileSync(resolve(`node_modules/@fontsource/noto-${file[1]}/files/${file[0]}`)))
  }))
  const original = await PDFDocument.create(); original.addPage([595, 842])
  const overlays: Textbox[] = []
  for (const font of ['noto-sans', 'noto-serif'] as const) {
    for (const [bold, italic] of [[false, false], [true, false], [false, true], [true, true]]) {
      overlays.push({ id: `${font}-${bold}-${italic}`, font, bold, italic, text: 'Grüße aus Würzburg – ÄÖÜ ß',
        pageIndex: 0, x: 30, y: 800 - overlays.length * 35, fontSize: 14, underline: true })
    }
  }
  expect(new Set(overlays.map(bundledFontUrl)).size).toBe(8)
  const bytes = await exportPdf(await original.save(), overlays), doc = await PDFDocument.load(bytes)
  const fonts = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
  expect(fonts.keys()).toHaveLength(8)
  for (const key of fonts.keys()) {
    const font = fonts.lookup(key, PDFDict)
    expect(font.lookup(PDFName.of('Subtype')).toString()).toBe('/Type0')
    expect(font.lookup(PDFName.of('ToUnicode'))).toBeDefined()
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: bytes, useSystemFonts: true })
  try {
    const page = await (await task.promise).getPage(1)
    const text = (await page.getTextContent()).items.flatMap(item => 'str' in item ? [item.str] : [])
    expect(text.filter(line => line === overlays[0].text)).toHaveLength(8)
  } finally { await task.destroy() }
})

test('failed local font loads reject clearly and can be retried', async () => {
  const request = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
  vi.stubGlobal('fetch', request)
  await expect(loadBundledFont('/retry-font.woff')).rejects.toThrow('Schriftart konnte nicht geladen werden')
  expect(await loadBundledFont('/retry-font.woff')).toEqual(new Uint8Array([1, 2, 3]))
  expect(request).toHaveBeenCalledTimes(2)
})
