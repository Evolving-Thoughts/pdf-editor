import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { PDFArray, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { inspectPageSource, previewPageSource } from '../../src/core/sourceText/mixedPdf'
import { contentTokens } from '../../src/core/sourceText/contentTokens'

const inspectPage = (bytes: Uint8Array) => inspectPageSource(bytes, 0)
const previewEdit = previewPageSource
const n = PDFName.of
async function fixture(text = 'Grüße Würzburg. A small typo.', fontName = StandardFonts.Helvetica) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(fontName)
  const page = doc.addPage([595, 842])
  page.drawText(text, { x: 50, y: 700, size: 12, font })
  page.drawText('Unveränderter Folgeabsatz.', { x: 50, y: 630, size: 12, font })
  return doc.save()
}
async function extract(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/' })
  try {
    const pdf = await task.promise
    const content = await (await pdf.getPage(1)).getTextContent()
    return content.items.filter(item => 'str' in item).filter(item => item.str)
  } finally { await task.destroy() }
}
async function selection(bytes: Uint8Array) {
  const result = await inspectPage(bytes)
  return { digest: result.digest, runId: result.runs[0].id, expectedText: result.runs[0].text }
}
async function mutate(bytes: Uint8Array, callback: (doc: PDFDocument) => void) {
  const doc = await PDFDocument.load(bytes)
  callback(doc)
  return doc.save()
}
function streamRefs(doc: PDFDocument) {
  const contents = doc.getPages()[0].node.Contents()
  return contents instanceof PDFArray ? contents.asArray() : [doc.getPages()[0].node.get(n('Contents'))!]
}
async function changeContent(bytes: Uint8Array, transform: (text: string) => string) {
  return mutate(bytes, doc => {
    const ref = streamRefs(doc)[0]
    const raw = doc.context.lookup(ref) as PDFRawStream
    const text = String.fromCharCode(...decodePDFRawStream(raw).decode())
    doc.context.assign(ref as Parameters<typeof doc.context.assign>[0], doc.context.flateStream(transform(text)))
  })
}

test('inspects real DE/EN standard-font source text without treating Unicode as PDF codes', async () => {
  const result = await inspectPage(await fixture())
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
  expect(result.runs.map(run => run.text)).toEqual(['Grüße Würzburg. A small typo.', 'Unveränderter Folgeabsatz.'])
  expect(result.runs[0]).toMatchObject({ fontName: 'Helvetica', fontSize: 12, x: 50, baseline: 700 })
  const run = result.runs[0], characters = run.selection!.characters
  expect(characters).toHaveLength(run.text.length)
  expect(characters[0].offset).toBe(0)
  expect(characters.at(-1)!.offset + characters.at(-1)!.width).toBeCloseTo(run.width, 8)
  for (let i = 1; i < characters.length; i++) expect(characters[i].offset).toBeCloseTo(characters[i - 1].offset + characters[i - 1].width, 8)
})

test('actually replaces the original stream, not an appended overlay, preserving neighbours/font/baseline', async () => {
  const input = await fixture(), snapshot = input.slice(), selected = await selection(input)
  const candidate = await previewEdit(input, selected, 'Grüße Würzburg. A corrected typo.')
  expect(input).toEqual(snapshot)
  const before = await extract(input), after = await extract(candidate)
  expect(after.map(item => item.str)).toEqual(['Grüße Würzburg. A corrected typo.', 'Unveränderter Folgeabsatz.'])
  expect(after[0].transform).toEqual(before[0].transform)
  expect(after[0].height).toEqual(before[0].height)
  // PDF.js uses per-document internal font aliases; compare the actual resources.
  const a = await PDFDocument.load(input), b = await PDFDocument.load(candidate)
  expect(b.getPages()[0].node.Resources()?.lookup(n('Font'))?.toString()).toBe(a.getPages()[0].node.Resources()?.lookup(n('Font'))?.toString())
  expect(after[1].transform).toEqual(before[1].transform)
  expect(streamRefs(b).length).toBe(streamRefs(a).length)
  const allStreams = b.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream)
  const sourceHex = Buffer.from('Grüße Würzburg. A small typo.', 'latin1').toString('hex').toUpperCase()
  for (const [, object] of allStreams) {
    const content = String.fromCharCode(...decodePDFRawStream(object as PDFRawStream).decode())
    expect(content).not.toContain(sourceHex)
  }
})

test('shorter and longer words move the remaining words naturally without squeezing', async () => {
  const input = await fixture('A tiny typo here.')
  for (const replacement of ['A typo here.', 'A corrected typographical error here.']) {
    const candidate = await previewEdit(input, await selection(input), replacement)
    const after = await extract(candidate)
    expect(after[0].str).toBe(replacement)
    expect(after[0].height).toBe(12)
    expect(after[1].str).toBe('Unveränderter Folgeabsatz.')
    expect(after[1].transform[5]).toBe(630)
  }
})

test('rejects overflow and missing glyph atomically', async () => {
  const bytes = await fixture(), snapshot = bytes.slice(), selected = await selection(bytes)
  await expect(previewEdit(bytes, selected, 'W'.repeat(150))).rejects.toThrow(/überschreitet/)
  await expect(previewEdit(bytes, selected, 'Ein großes ẞ')).rejects.toThrow(/Zeichen fehlt/)
  expect(bytes).toEqual(snapshot)
  expect((await extract(bytes))[0].str).toBe(selected.expectedText)
})

test('revision digest, expected text and run identity all guard stale selections', async () => {
  const bytes = await fixture(), selected = await selection(bytes)
  for (const stale of [{ ...selected, digest: 'bad' }, { ...selected, expectedText: 'wrong' }, { ...selected, runId: `${selected.runId}9` }]) {
    await expect(previewEdit(bytes, stale, 'Fixed.')).rejects.toThrow(/veraltet/)
  }
  const changed = await mutate(bytes, doc => doc.setSubject('Another revision'))
  await expect(previewEdit(changed, selected, 'Fixed.')).rejects.toThrow(/veraltet/)
})

test('text-only obstruction and crop edge both refuse horizontal growth', async () => {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  page.drawText('Tiny.', { x: 50, y: 700, size: 12, font })
  page.drawText('Neighbour', { x: 160, y: 700, size: 12, font })
  const input = await doc.save()
  await expect(previewEdit(input, await selection(input), 'A much longer replacement.')).rejects.toThrow(/geschützten/)
  const cropped = await mutate(await fixture(), pdf => pdf.getPages()[0].setCropBox(0, 0, 140, 842))
  await expect(previewEdit(cropped, await selection(cropped), 'This replacement reaches beyond the cropped page.')).rejects.toThrow()
})

test('rotated pages fail closed, and a stream shared with another page stays intact there', async () => {
  const input = await fixture()
  const rotated = await mutate(input, doc => doc.getPages()[0].node.set(n('Rotate'), doc.context.obj(90)))
  await expect(inspectPage(rotated)).rejects.toThrow()
  const shared = await mutate(input, doc => {
    doc.addPage([595, 842]).node.set(n('Contents'), doc.getPages()[0].node.get(n('Contents'))!)
  })
  const selected = await selection(shared)
  const output = await previewEdit(shared, selected, 'Fixed.')
  const task = getDocument({ data: output.slice(), standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/' })
  try {
    const pdf = await task.promise, text = async (page: number) => (await (await pdf.getPage(page)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join('')
    expect(await text(1)).toContain('Fixed.')
    expect(await text(2)).toContain(selected.expectedText)
  } finally { await task.destroy() }
})

test('literal escaped strings, octal DE bytes and operator-looking content are decoded as text', async () => {
  const input = await changeContent(await fixture(), s => s.replace(/<[\da-f]+> Tj/i, '(Gr\\374\\337e \\(BT\\)) Tj'))
  const inspected = await inspectPage(input)
  expect(inspected.runs[0].text).toBe('Grüße (BT)')
  const candidate = await previewEdit(input, await selection(input), 'Grüße (ET)')
  expect((await extract(candidate))[0].str).toBe('Grüße (ET)')
})

test('lexer rejects malformed strings/composites and honors escapes and odd hex padding', () => {
  expect(contentTokens('(a\\\\b\\(c\\)\\101)')[0].bytes).toEqual(Uint8Array.from([97, 92, 98, 40, 99, 41, 65]))
  expect(contentTokens('<4 1 F>')[0].bytes).toEqual(Uint8Array.from([65, 240]))
  expect(contentTokens('% BT <41> Tj\n /F#31 12 Tf').map(token => token.raw)).toEqual(['/F#31', '12', 'Tf'])
  for (const text of ['(unterminated', '<GG>', '<41', '[<41>] TJ', '<< /A 1 >>', '('.repeat(34)]) expect(() => contentTokens(text)).toThrow()
})

test('bounded streaming inflate rejects highly compressed oversized content', async () => {
  const input = await mutate(await fixture(), doc => {
    const ref = streamRefs(doc)[0]
    doc.context.assign(ref as Parameters<typeof doc.context.assign>[0], doc.context.flateStream('%' + 'a'.repeat(600000)))
  })
  await expect(inspectPage(input)).rejects.toThrow(/Grenzen/)
})

test.each(Object.values(StandardFonts).filter(name => name !== StandardFonts.Symbol && name !== StandardFonts.ZapfDingbats))('DE/EN actual replacement retains supported original font %s', async fontName => {
  const bytes = await fixture('Grüße München. English text.', fontName)
  const candidate = await previewEdit(bytes, await selection(bytes), 'Grüße Würzburg. Corrected text.')
  const checked = await inspectPage(candidate)
  expect(checked.runs[0].fontName).toBe(fontName)
  const firstLine = (await extract(candidate)).filter(item => item.transform[5] === 700).map(item => item.str).join('')
  expect(firstLine).toBe('Grüße Würzburg. Corrected text.')
})

test('copies revision bytes and selection before asynchronous work', async () => {
  const bytes = await fixture(), selected = await selection(bytes)
  const result = previewEdit(bytes, selected, 'Grüße München. Fixed.')
  bytes.fill(0)
  selected.digest = 'mutated'
  selected.runId = 'mutated'
  const candidate = await result
  expect((await extract(candidate))[0].str).toBe('Grüße München. Fixed.')
})
