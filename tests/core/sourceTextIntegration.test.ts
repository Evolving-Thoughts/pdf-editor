import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, vi } from 'vitest'
import { PDFDocument, StandardFonts, PDFName, PDFDict, PDFRawStream, PDFArray, PDFNumber, PDFString } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { sourceRevision, sourceRevisions } from '../../src/core/sourceText/revision'
import { EditorStore } from '../../src/core/editorStore'
import { inspectPages, exportPageDocument } from '../../src/core/pdf/pageOperations'
import { sourceTextRequest } from '../../src/core/sourceText/client'
import { streamBytes } from '../../src/core/sourceText/streams'
import { inspectPageSource, previewPageSource, textString } from '../../src/core/sourceText/mixedPdf'
import { openDraftDb, saveDraft, loadDraft } from '../../src/core/persistence/drafts'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'

const inspectPage = (bytes: Uint8Array) => inspectPageSource(bytes, 0)
const previewEdit = previewPageSource

async function extract(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/' })
  try { const doc = await task.promise; return (await (await doc.getPage(1)).getTextContent()).items.filter(item => 'str' in item && item.str) }
  finally { await task.destroy() }
}
async function paragraphFixture(follow = 540) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  const text = 'This paragraph contains several short words that can flow naturally through the existing lines without moving the following paragraph.'
  const lines = text.split(' ').reduce<string[]>((all, word) => {
    const last = all.at(-1)
    if (last && font.widthOfTextAtSize(`${last} ${word}`, 12) <= 220) all[all.length - 1] = `${last} ${word}`
    else all.push(word)
    return all
  }, [])
  const page = doc.addPage([595, 842])
  page.drawText(lines.join('\n'), { x: 50, y: 700, font, size: 12, lineHeight: 20 })
  page.drawText('Following paragraph stays here.', { x: 50, y: follow, font, size: 12 })
  return doc.save()
}
function paragraphSelection(analysis: Awaited<ReturnType<typeof inspectPage>>) {
  const run = analysis.runs[0]
  expect(run.paragraph).toBeDefined()
  return { digest: analysis.digest, runId: run.id, expectedText: run.text, scope: 'paragraph' as const }
}

test('real paragraph shrinks naturally while neighbour baseline and first baseline remain fixed', async () => {
  const bytes = await paragraphFixture(), original = await inspectPage(bytes)
  const candidate = await previewEdit(bytes, paragraphSelection(original), 'This paragraph contains short words.')
  const items = await extract(candidate)
  expect(items.filter(item => item.transform[5] > 540).map(item => item.str).join(' ')).toBe('This paragraph contains short words.')
  expect(items[0].transform[5]).toBe(700)
  expect(items.at(-1)!.str).toBe('Following paragraph stays here.')
  expect(items.at(-1)!.transform[5]).toBe(540)
  expect((await inspectPage(candidate)).runs.length).toBeLessThan(original.runs.length)
})

test('paragraph grows only into proven free space, preserves size and rejects a protected following paragraph', async () => {
  const bytes = await paragraphFixture(), analysis = await inspectPage(bytes)
  const replacement = analysis.runs[0].paragraph!.text + ' More short words can follow naturally through the lines.'
  const candidate = await previewEdit(bytes, paragraphSelection(analysis), replacement)
  const changed = await inspectPage(candidate)
  expect(changed.runs.length).toBeGreaterThan(analysis.runs.length)
  expect(changed.runs.every(run => run.fontSize === 12)).toBe(true)
  expect((await extract(candidate)).at(-1)!.transform[5]).toBe(540)
  const occupied = await paragraphFixture(605), occupiedAnalysis = await inspectPage(occupied)
  await expect(previewEdit(occupied, paragraphSelection(occupiedAnalysis), replacement)).rejects.toThrow(/Absatzzeile/)
})

async function embeddedFixture() {
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit)
  const font = await doc.embedFont(readFileSync('node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff'), { subset: true })
  doc.addPage().drawText('Grüße München Hallo Welt äöüÄÖÜß', { font, size: 12, x: 50, y: 700 })
  return doc.save()
}

test('reuses a real embedded TrueType subset for DE/EN even when not a standard font', async () => {
  const bytes = await embeddedFixture(), analysis = await inspectPage(bytes), run = analysis.runs[0]
  const candidate = await previewEdit(bytes, { digest: analysis.digest, runId: run.id, expectedText: run.text }, 'Hallo München Grüße Welt äöüÄÖÜß')
  expect((await extract(candidate)).map(item => item.str).join('')).toBe('Hallo München Grüße Welt äöüÄÖÜß')
  expect((await inspectPage(candidate)).runs[0].fontName).toBe(run.fontName)
  await expect(previewEdit(bytes, { digest: analysis.digest, runId: run.id, expectedText: run.text }, 'Ein Z fehlt')).rejects.toThrow(/Zeichen fehlt/)
})

test('invalid embedded glyph reference or ambiguous Unicode mapping is refused', async () => {
  const bytes = await embeddedFixture()
  for (const corrupt of ['gid', 'unicode']) {
    const doc = await PDFDocument.load(bytes), fonts = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
    const font = fonts.lookup(fonts.keys()[0], PDFDict)
    if (corrupt === 'gid') {
      const cid = font.lookup(PDFName.of('DescendantFonts'))!.toString()
      void cid
      // Widths/Unicode must not make a nonexistent embedded GID usable.
      const raw = font.lookup(PDFName.of('ToUnicode')) as PDFRawStream
      const text = new TextDecoder().decode(await streamBytes(raw)).replace('<0001> <0047>', '<FFFF> <0047>')
      font.set(PDFName.of('ToUnicode'), doc.context.register(doc.context.flateStream(text)))
    } else {
      const raw = font.lookup(PDFName.of('ToUnicode')) as PDFRawStream
      const text = new TextDecoder().decode(await streamBytes(raw)).replace('<0002> <0072>', '<0002> <0047>')
      font.set(PDFName.of('ToUnicode'), doc.context.register(doc.context.flateStream(text)))
    }
    const broken = await doc.save()
    await expect((async () => {
      const analysis = await inspectPage(broken), run = analysis.runs[0]
      return previewEdit(broken, { digest: analysis.digest, runId: run.id, expectedText: run.text }, 'Hallo')
    })()).rejects.toThrow()
  }
})

test('source revision supports undo/redo, stored drafts and real page export without mutating original', async () => {
  const bytes = await paragraphFixture(), analysis = await inspectPage(bytes)
  const candidate = await previewEdit(bytes, paragraphSelection(analysis), 'This paragraph contains short words.')
  const pages = await inspectPages(bytes, 'original.pdf'), store = new EditorStore()
  store.restore({ overlays: [], pages: pages, pageSources: [] })
  const originalSource = store.state.pages![0].sourceId
  store.dispatch(sourceRevision(store.state, pages[0].id, Uint8Array.from(candidate).buffer))
  const source = store.state.pageSources![0]
  expect(store.state.pages![0].sourceId).toBe(source.id)
  store.undo(); expect(store.state.pages![0].sourceId).toBe(originalSource)
  store.redo(); expect(store.state.pages![0].sourceId).toBe(source.id)
  const exported = await exportPageDocument(bytes, store.state.pageSources!, store.state.pages!, [])
  expect((await extract(exported)).map(item => item.str).join(' ')).toContain('This paragraph contains short words.')
  vi.stubGlobal('indexedDB', indexedDB); vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const db = await openDraftDb()
  try {
    await saveDraft(db, { id: 'source-revision-test', name: 'test.pdf', createdAt: 1, updatedAt: 2, pdfBytes: Uint8Array.from(bytes).buffer, overlays: [], pages: store.state.pages, pageSources: store.state.pageSources })
    const draft = await loadDraft(db, 'source-revision-test')
    expect(draft?.pageSources?.[0].bytes).toEqual(source.bytes)
    expect(draft?.pages?.[0].sourceId).toBe(source.id)
  } finally { db.close(); vi.unstubAllGlobals() }
})

test('worker request terminates on abort and deadline; original bytes stay available', async () => {
  const worker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker
  const bytes = new ArrayBuffer(8), abort = new AbortController()
  const pending = sourceTextRequest({ action: 'inspect', bytes }, abort.signal, () => worker, 1000)
  abort.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(worker.terminate).toHaveBeenCalledOnce(); expect(bytes.byteLength).toBe(8)
  const timeoutWorker = { postMessage: vi.fn(), terminate: vi.fn() } as unknown as Worker
  await expect(sourceTextRequest({ action: 'inspect', bytes }, new AbortController().signal, () => timeoutWorker, 5)).rejects.toThrow(/lange gedauert/)
  expect(timeoutWorker.terminate).toHaveBeenCalledOnce()
})

test('source revision refuses overlays and leaves duplicate page copies and original bytes untouched', async () => {
  const bytes = await paragraphFixture(), pages = await inspectPages(bytes, 'original.pdf'), store = new EditorStore()
  store.restore({ overlays: [], pages: [...pages, { ...pages[0], id: 'another-copy' }], pageSources: [] })
  store.state.overlays.push({ id: 'overlay', pageId: pages[0].id, x: 50, y: 700, text: 'overlay', font: 'helvetica', fontSize: 12, bold: false, italic: false, underline: false })
  const before = store.state.pages
  expect(() => sourceRevision(store.state, pages[0].id, Uint8Array.from(bytes).buffer)).toThrow(/Overlays/)
  expect(store.state.pages).toBe(before); expect(store.canUndo).toBe(false)
  store.state.overlays = []
  store.dispatch(sourceRevision(store.state, pages[0].id, Uint8Array.from(bytes).buffer))
  expect(store.state.pages![1].sourceId).toBe('original')
  expect(store.state.pages![0].sourceId).not.toBe('original')
  store.undo(); expect(store.state.pageSources).toEqual([])
})

test('a character whose only slot has width 0 is not in the subset and is never inserted', async () => {
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit)
  const embedded = await doc.embedFont(readFileSync('node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff'), { subset: true })
  const sheet = doc.addPage(); sheet.drawText('Hallo München', { font: embedded, size: 12, x: 50, y: 700 }); sheet.drawText('W', { font: embedded, size: 12, x: 50, y: 400 })
  await doc.save() // writes the subset, its widths and ToUnicode
  const fonts = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('Font'), PDFDict), font = fonts.lookup(fonts.keys()[0], PDFDict)
  const map = new TextDecoder().decode(await streamBytes(font.lookup(PDFName.of('ToUnicode')) as PDFRawStream))
  const cid = parseInt(/<([0-9A-Fa-f]{4})> <0057>/.exec(map)![1], 16) // 'W'
  const cidFont = (font.lookup(PDFName.of('DescendantFonts'), PDFArray)).lookup(0, PDFDict), widths = cidFont.lookup(PDFName.of('W'), PDFArray)
  for (let i = 0; i < widths.size(); i += 2) {
    const first = (widths.lookup(i) as PDFNumber).asNumber(), list = widths.lookup(i + 1, PDFArray)
    if (cid >= first && cid < first + list.size()) list.set(cid - first, PDFNumber.of(0))
  }
  const { inspectPageSource } = await import('../../src/core/sourceText/mixedPdf')
  const analysis = await inspectPageSource(await doc.save(), 0)
  const insertable = analysis.fonts.flatMap(f => f.insertable.map(([c]) => c))
  expect(insertable).toContain('H')
  expect(insertable).not.toContain('W')
})

test('ASCIIHexDecode streams larger than the argument limit decode in bounded steps', async () => {
  const doc = await PDFDocument.create()
  const data = new Uint8Array(200_000).map((_, i) => i * 7)
  const hex = Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('\n') + '>'
  const raw = PDFRawStream.of(doc.context.obj({ Filter: 'ASCIIHexDecode' }), new TextEncoder().encode(hex))
  await expect(streamBytes(raw, 1024 * 1024)).resolves.toEqual(data)
  const odd = PDFRawStream.of(doc.context.obj({ Filter: 'AHx' }), new TextEncoder().encode('4 1 4>'))
  await expect(streamBytes(odd)).resolves.toEqual(Uint8Array.from([0x41, 0x40]))
  const bad = PDFRawStream.of(doc.context.obj({ Filter: 'AHx' }), new TextEncoder().encode('4G>'))
  await expect(streamBytes(bad)).rejects.toThrow(/Streamkodierung/)
})

test('corrections of several pages are one undoable command', async () => {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  for (const label of ['One', 'Two', 'Three']) doc.addPage().drawText(label, { font, size: 12, x: 50, y: 700 })
  const bytes = await doc.save(), pages = await inspectPages(bytes, 'three.pdf'), store = new EditorStore()
  store.restore({ overlays: [], pages: pages, pageSources: [] })
  const before = store.state.pages!.map(p => p.sourceId)
  store.dispatch(sourceRevisions(store.state, [{ pageId: pages[0].id, bytes: Uint8Array.from(bytes).buffer }, { pageId: pages[2].id, bytes: Uint8Array.from(bytes).buffer }]))
  const after = store.state.pages!.map(p => p.sourceId)
  expect(after[0]).not.toBe(before[0]); expect(after[1]).toBe(before[1]); expect(after[2]).not.toBe(before[2]); expect(after[0]).not.toBe(after[2])
  expect(store.state.pageSources).toHaveLength(2)
  store.undo(); expect(store.state.pages!.map(p => p.sourceId)).toEqual(before)
  store.redo(); expect(store.state.pages!.map(p => p.sourceId)).toEqual(after)
  expect(() => sourceRevisions(store.state, [{ pageId: pages[1].id, bytes: Uint8Array.from(bytes).buffer }, { pageId: pages[1].id, bytes: Uint8Array.from(bytes).buffer }])).toThrow()
})

test('stream dictionaries with other keys are refused as unsupported, not as too large', async () => {
  const doc = await PDFDocument.create()
  const external = PDFRawStream.of(doc.context.obj({ F: 'data.bin' }), new Uint8Array([65]))
  await expect(streamBytes(external)).rejects.toThrow(/Streamkodierung/)
  const large = PDFRawStream.of(doc.context.obj({}), new Uint8Array(600_000))
  await expect(streamBytes(large)).rejects.toThrow(/Grenzen/)
})

test('long PDF text strings decode without exceeding the argument limit', () => {
  const bytes = new Uint8Array(200_000).fill(65)
  expect(textString(bytes)).toBe('A'.repeat(200_000))
  expect(textString(Uint8Array.from([0xfe, 0xff, 0x00, 0xe4]))).toBe('ä')
})

test('a form too large to rule out signatures is refused instead of crashing or skipping fields', async () => {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage().drawText('Hello', { font, size: 12, x: 50, y: 700 })
  const kids = doc.context.obj(Array.from({ length: 70_000 }, (_, i) => i))
  const field = doc.context.register(doc.context.obj({ FT: 'Tx', T: PDFString.of('big'), Kids: kids }))
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [field] }))
  await expect(inspectPageSource(await doc.save(), 0)).rejects.toThrow(/zu umfangreich/)
})
