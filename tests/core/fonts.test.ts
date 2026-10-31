import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { BUNDLED_FONTS, bundledFontUrl, fontSupportsItalic, loadBundledFont } from '../../src/core/fonts'
import { exportPdf } from './exportFixture'
import type { Textbox } from '../../src/core/model'

afterEach(() => vi.unstubAllGlobals())

test('each bundled family/style embeds a real font program and preserves searchable German text', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const file = /(noto-sans|noto-serif|carlito|lato|eb-garamond|roboto-mono|caveat)-latin-(400|700)-(normal|italic)\.woff/.exec(url)
    if (!file) throw new Error(`Unexpected font asset: ${url}`)
    return new Response(readFileSync(resolve(`node_modules/@fontsource/${file[1]}/files/${file[0]}`)))
  }))
  const original = await PDFDocument.create(); original.addPage([595, 842])
  const overlays: Textbox[] = []
  for (const font of BUNDLED_FONTS) {
    for (const [bold, italic] of [[false, false], [true, false], [false, true], [true, true]]) {
      if (italic && !fontSupportsItalic(font)) continue
      overlays.push({ id: `${font}-${bold}-${italic}`, font, bold, italic, text: 'Grüße aus Würzburg – ÄÖÜ ß',
        pageId: 'p0', x: 30, y: 800 - overlays.length * 27, fontSize: 12, underline: true })
    }
  }
  expect(new Set(overlays.map(bundledFontUrl)).size).toBe(26)
  const bytes = await exportPdf(await original.save(), overlays), doc = await PDFDocument.load(bytes)
  const fonts = doc.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
  expect(fonts.keys()).toHaveLength(26)
  for (const key of fonts.keys()) {
    const font = fonts.lookup(key, PDFDict)
    expect(font.lookup(PDFName.of('Subtype')).toString()).toBe('/Type0')
    expect(font.lookup(PDFName.of('ToUnicode'))).toBeDefined()
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: bytes, useSystemFonts: true })
  try {
    const page = await (await task.promise).getPage(1)
    const lines = new Map<number, string[]>()
    for (const item of (await page.getTextContent()).items) {
      if (!('str' in item)) continue
      const baseline = Math.round(item.transform[5] * 1000) / 1000
      const parts = lines.get(baseline) ?? []
      parts.push(item.str); lines.set(baseline, parts)
    }
    expect([...lines.values()].map(parts => parts.join('').trim())).toEqual(overlays.map(overlay => overlay.text))
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

test('Caveat does not substitute a fake italic font, including restored data', () => {
  expect(fontSupportsItalic('caveat')).toBe(false)
  expect(bundledFontUrl({ font: 'caveat', bold: false, italic: true }))
    .toBe(bundledFontUrl({ font: 'caveat', bold: false, italic: false }))
  expect(bundledFontUrl({ font: 'caveat', bold: true, italic: true }))
    .toBe(bundledFontUrl({ font: 'caveat', bold: true, italic: false }))
})
