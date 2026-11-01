import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { sourceFontCodec } from '../../src/core/sourceText/encoding'

const glyphs = Array.from(' abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZäöüÄÖÜß-.,!?').map((character, i) => ({ character, code: i.toString(16).padStart(2, '0'), advance: 500 }))
const built = sourceFontCodec(glyphs, 1)
if (!built.ok) throw Error('fixture')
const codec = built.value

test('DE/EN encode to original source codes, not UTF-8, with no fallback', () => {
  expect(codec.encode('Grüße')).toEqual({ ok: true, value: { hex: [...'Grüße'].map(c => glyphs.find(g => g.character === c)!.code).join('').toUpperCase(), advance: 2500 } })
  expect(codec.encode('€')).toEqual({ ok: false, error: 'missing-glyph' })
  expect(codec.encode('ア')).toEqual({ ok: false, error: 'unsupported-text' })
  expect(codec.encode('…')).toEqual({ ok: false, error: 'missing-glyph' })
})

test('two-byte subset character IDs are independent of Unicode values', () => {
  const result = sourceFontCodec([{ character: 'ü', code: '00AF', advance: 540 }, { character: 'ß', code: '0003', advance: 500 }], 2)
  expect(result.ok && result.value.encode('üß')).toEqual({ ok: true, value: { hex: '00AF0003', advance: 1040 } })
})

test('rejects ambiguous, malformed or unsafe font maps and snapshots valid entries', () => {
  for (const bad of [
    [glyphs[0], glyphs[0]],
    [glyphs[0], { ...glyphs[1], code: glyphs[0].code }],
    [{ ...glyphs[1], advance: NaN }], [{ ...glyphs[1], advance: -1 }],
    [{ ...glyphs[1], code: 'GG' }], [{ ...glyphs[1], code: '0001' }],
    [{ ...glyphs[1], character: 'ab' }],
  ]) expect(sourceFontCodec(bad, 1)).toEqual({ ok: false, error: 'invalid-font-map' })
  const entry = { ...glyphs[1] }
  const result = sourceFontCodec([entry], 1)
  entry.code = 'FF'
  expect(result.ok && result.value.encode('a')).toEqual({ ok: true, value: { hex: glyphs[1].code.toUpperCase(), advance: 500 } })
})

test('verified WinAnsi codes and source-font widths round-trip through a real PDF independently', async () => {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const text = 'Grüße Würzburg ÄÖÜ äöü ß. English text.'
  const map = [...new Set(text)].map(character => ({ character, code: font.encodeText(character).asString(), advance: font.widthOfTextAtSize(character, 1000) }))
  const result = sourceFontCodec(map, 1)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const encoded = result.value.encode(text)
  expect(encoded.ok).toBe(true)
  if (!encoded.ok) return
  const page = doc.addPage([595, 842])
  page.node.setFontDictionary(PDFName.of('F1'), font.ref)
  const stream = doc.context.flateStream(`BT /F1 10 Tf 1 0 0 1 50 700 Tm <${encoded.value.hex}> Tj ET`)
  page.node.addContentStream(doc.context.register(stream))
  const task = getDocument({ data: await doc.save(), standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/' })
  try {
    const pdf = await task.promise
    const content = await (await pdf.getPage(1)).getTextContent()
    const items = content.items.filter(item => 'str' in item)
    expect(items.map(item => item.str).join('')).toBe(text)
    expect(items[0].transform[5]).toBe(700)
    expect(items[0].height).toBe(10)
  } finally { await task.destroy() }
})
