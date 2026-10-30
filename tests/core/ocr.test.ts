import { expect, test, vi } from 'vitest'
import { gunzipSync } from 'fflate'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import assets from '../../src/core/ocr/ocrAssets.json'
import { toSourceWords, writeOcrLayers } from '../../src/core/ocr/ocrLayer'
import { verifyModel, withTimeout, wordsFromBlocks, type OcrWord } from '../../src/core/ocr/recognize'
import { composePages, exportPageDocument, inspectPages } from '../../src/core/pdf/pageOperations'
import { writeRasterSource } from '../../src/core/pdf/rasterSource'
import { deletePages, movePage, rotatePages, setPageOcr, type DocumentPage, type OcrSourceWord } from '../../src/core/pages'
import { CommandStack } from '../../src/core/commands'
import type { EditorState } from '../../src/core/model'
import { PNG_DATA_URL } from '../imageFixtures.js'

const word = (text: string, left: number, top: number, right: number, bottom: number): OcrWord => ({ text, confidence: 90, left, top, right, bottom })

async function scan(width = 400, height = 600) {
  const doc = await PDFDocument.create(), image = await doc.embedPng(PNG_DATA_URL)
  doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height })
  return doc.save()
}

async function read(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice() })
  const pdf = await task.promise, pages = []
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 })
    const operators = await page.getOperatorList()
    const items = (await page.getTextContent()).items.flatMap(item => {
      if (!('str' in item) || !item.str.trim()) return []
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
      return [{ text: item.str.trim(), x, y, width: item.width }]
    })
    const modes = operators.fnArray.flatMap((op, index) => op === OPS.setTextRenderingMode ? [operators.argsArray[index][0]] : [])
    pages.push({ items, modes, images: operators.fnArray.filter(op => op === OPS.paintImageXObject).length, view: page.view })
  }
  await task.destroy()
  return pages
}

test('the pinned hashes match the installed engine and models', () => {
  for (const asset of [...assets.files, ...Object.values(assets.models)])
    expect(createHash('sha256').update(readFileSync(`node_modules/${asset.source}`)).digest('hex')).toBe(asset.sha256)
})

test('a damaged model is refused, an intact one passes', async () => {
  const good = readFileSync(`node_modules/${assets.models.deu.source}`)
  await expect(verifyModel('deu', '/ocr/', vi.fn(async () => new Response(good)))).resolves.toBeUndefined()
  const bad = Buffer.from(good)
  bad[100] ^= 255
  await expect(verifyModel('deu', '/ocr/', vi.fn(async () => new Response(bad)))).rejects.toThrow(/beschädigt/)
})

test('a server that unpacks the .gz on the way is accepted too', async () => {
  const unpacked = gunzipSync(new Uint8Array(readFileSync(`node_modules/${assets.models.deu.source}`)))
  await expect(verifyModel('deu', '/ocr/', vi.fn(async () => new Response(unpacked)))).resolves.toBeUndefined()
  const damaged = unpacked.slice()
  damaged[5000] ^= 255
  await expect(verifyModel('deu', '/ocr/', vi.fn(async () => new Response(damaged)))).rejects.toThrow(/beschädigt/)
})

test('an unreachable model gets a plain message', async () => {
  await expect(verifyModel('eng', '/ocr/', vi.fn(async () => { throw new TypeError('offline') }))).rejects.toThrow(/nicht geladen/)
  await expect(verifyModel('eng', '/ocr/', vi.fn(async () => new Response('', { status: 404 })))).rejects.toThrow(/nicht geladen/)
})

test('models come from the app itself, with the same address the engine uses', async () => {
  const load = vi.fn(async () => new Response(readFileSync(`node_modules/${assets.models.eng.source}`)))
  await verifyModel('eng', '/pdf-editor/ocr/', load)
  expect(load).toHaveBeenCalledWith('/pdf-editor/ocr/lang/eng.traineddata.gz', { cache: 'no-cache' })
})

test('nested engine output becomes flat words in page points, without empty ones', () => {
  const words = wordsFromBlocks([{ paragraphs: [{ lines: [{ words: [
    { text: ' Größe ', confidence: 91.5, bbox: { x0: 100, y0: 200, x1: 300, y1: 240 } },
    { text: '  ', confidence: 10, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
  ] }] }] }], 2)
  expect(words).toEqual([{ text: 'Größe', confidence: 91.5, left: 50, top: 100, right: 150, bottom: 120 }])
  expect(wordsFromBlocks(null, 2)).toEqual([])
})

test('a stuck page ends with a message and stops the engine', async () => {
  vi.useFakeTimers()
  const stop = vi.fn()
  const run = expect(withTimeout(new Promise(() => undefined), 1000, stop)).rejects.toThrow(/zu lange gedauert/)
  await vi.advanceTimersByTimeAsync(1000)
  await run
  expect(stop).toHaveBeenCalledOnce()
  vi.useRealTimers()
})

test('recognized text becomes searchable, invisible text; umlauts and ß included', async () => {
  const bytes = await scan(), [page] = await inspectPages(bytes, 'scan.pdf')
  page.ocr = toSourceWords(page, [word('Größe', 50, 100, 120, 118), word('Straße', 130, 100, 210, 118)])
  const [result] = await read(await composePages(bytes, [], [page]))
  expect(result.items.map(item => item.text).join(' ')).toContain('Größe')
  expect(result.items.map(item => item.text).join(' ')).toContain('Straße')
  expect(result.modes).toContain(3)
  expect(result.images).toBe(1)
})

test('a word lands where it was recognized, with its recognized width', async () => {
  const bytes = await scan(), [page] = await inspectPages(bytes, 'scan.pdf')
  page.ocr = toSourceWords(page, [word('Probe', 50, 100, 150, 120)])
  const [{ items }] = await read(await composePages(bytes, [], [page]))
  expect(items[0].x).toBeCloseTo(50, 0)
  expect(items[0].y).toBeCloseTo(116, 0)
  expect(items[0].width).toBeGreaterThan(95)
  expect(items[0].width).toBeLessThan(110)
})

test('on a rotated page a word still reads along the displayed line', async () => {
  const bytes = await scan(), [plain] = await inspectPages(bytes, 'scan.pdf')
  const page: DocumentPage = { ...plain, rotation: 90 }
  page.ocr = toSourceWords(page, [word('Quer', 100, 50, 200, 70)])
  const [{ items }] = await read(await composePages(bytes, [], [page]))
  expect(items[0].x).toBeCloseTo(100, 0)
  expect(items[0].y).toBeCloseTo(66, 0)
})

test('characters outside the font are dropped from the hidden text instead of breaking the export', async () => {
  const bytes = await scan(), [page] = await inspectPages(bytes, 'scan.pdf')
  page.ocr = toSourceWords(page, [word('A漢B', 50, 100, 120, 118)])
  const [{ items }] = await read(await composePages(bytes, [], [page]))
  expect(items[0].text).toBe('AB')
})

test('without recognized text the file stays byte-identical', async () => {
  const bytes = await scan(), pages = await inspectPages(bytes, 'scan.pdf')
  expect(await writeOcrLayers(bytes, pages)).toBe(bytes)
})

test('applying is one undo step and redo brings it back', async () => {
  const bytes = await scan(), pages = await inspectPages(bytes, 'scan.pdf')
  const state: EditorState = { overlays: [], pages, pageSources: [] }, stack = new CommandStack(state)
  const words: OcrSourceWord[] = [{ text: 'a', x: 1, y: 2, dx: 3, dy: 0, height: 4 }]
  stack.execute(setPageOcr(state, new Map([[pages[0].id, words]])))
  expect(state.pages![0].ocr).toEqual(words)
  stack.undo()
  expect(state.pages![0].ocr).toBeUndefined()
  stack.redo()
  expect(state.pages![0].ocr).toEqual(words)
})

test('recognized text moves with its page and leaves with it', async () => {
  const one = await PDFDocument.create()
  for (let index = 0; index < 3; index++) one.addPage([300, 300])
  const bytes = await one.save(), pages = await inspectPages(bytes, 'a.pdf')
  const state: EditorState = { overlays: [], pages, pageSources: [] }
  setPageOcr(state, new Map([[pages[2].id, [{ text: 'Letzte', x: 20, y: 200, dx: 60, dy: 0, height: 12 }]]])).apply(state)
  movePage(state, pages[2].id, 0).apply(state)
  rotatePages(state, [pages[2].id], true).apply(state)
  const moved = await read(await exportPageDocument(bytes, [], state.pages!, []))
  expect(moved[0].items.map(item => item.text)).toEqual(['Letzte'])
  expect(moved[1].items).toEqual([])
  deletePages(state, [pages[2].id]).apply(state)
  expect((await read(await exportPageDocument(bytes, [], state.pages!, []))).flatMap(page => page.items)).toEqual([])
})

test('a blacked-out page loses its recognized text', async () => {
  const bytes = await scan(), [page] = await inspectPages(bytes, 'scan.pdf')
  page.ocr = [{ text: 'Geheimnis', x: 20, y: 200, dx: 100, dy: 0, height: 12 }]
  const raster = await writeRasterSource([{ page, png: Uint8Array.from(atob(PNG_DATA_URL.split(',')[1]), char => char.charCodeAt(0)) }])
  expect(raster.replacements[0].ocr).toBeUndefined()
  const output = await exportPageDocument(bytes, [raster.source], raster.replacements, [])
  expect(new TextDecoder('latin1').decode(output)).not.toContain('Geheimnis')
  expect((await read(output))[0].items).toEqual([])
})

test('a text page stays usable next to scanned text', async () => {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([300, 300]).drawText('Echter Text', { x: 20, y: 200, size: 12, font })
  doc.addPage([300, 300])
  const bytes = await doc.save(), pages = await inspectPages(bytes, 'a.pdf')
  pages[1].ocr = [{ text: 'Erkannt', x: 20, y: 200, dx: 60, dy: 0, height: 12 }]
  const result = await read(await composePages(bytes, [], pages))
  expect(result[0].items.map(item => item.text)).toEqual(['Echter Text'])
  expect(result[1].items.map(item => item.text)).toEqual(['Erkannt'])
})
