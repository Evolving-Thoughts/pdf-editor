import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { sourceFontCodec } from '../../src/core/sourceText/encoding'
import { planSourceParagraph } from '../../src/core/sourceText/layout'
import type { SourceParagraphRegion } from '../../src/core/sourceText/layout'

const glyphs = Array.from(' abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZäöüÄÖÜß-.,!?').map((character, i) => ({ character, code: i.toString(16).padStart(2, '0'), advance: 500 }))
const built = sourceFontCodec(glyphs, 1)
if (!built.ok) throw Error('fixture')
const codec = built.value
const region: SourceParagraphRegion = { left: 50, right: 110, firstBaseline: 700, bottomLimit: 620, fontSize: 10, leading: 14, ascent: 8, descent: 2, originalLineCount: 3 }

test('DE/EN encode to original source codes, not UTF-8, with no fallback', () => {
  expect(codec.encode('Grüße')).toEqual({ ok: true, value: { hex: [...'Grüße'].map(c => glyphs.find(g => g.character === c)!.code).join('').toUpperCase(), advance: 2500 } })
  expect(codec.encode('€')).toEqual({ ok: false, error: 'unsupported-text' })
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

test('longer replacement cascades whole words, retaining baseline, size and normal spacing', () => {
  const result = planSourceParagraph('one longerword three four five six', codec, region)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.lines.map(line => line.text)).toEqual(['one', 'longerword', 'three four', 'five six'])
  expect(result.value.lines.map(line => line.baseline)).toEqual([700, 686, 672, 658])
  expect(result.value.lineDelta).toBe(1)
  expect(result.value.lines.every(line => line.x === 50 && line.width <= 60)).toBe(true)
})

test('shorter words pull back into preceding lines and leave unused space below', () => {
  const result = planSourceParagraph('one two three four five', codec, region)
  expect(result.ok && result.value.lines.map(line => line.text)).toEqual(['one two', 'three four', 'five'])
  const short = planSourceParagraph('one two three', codec, region)
  expect(short.ok && short.value.lineDelta).toBe(-1)
  expect(short.ok && short.value.lines[0].baseline).toBe(700)
  expect(region.bottomLimit).toBe(620)
})

test('growth permitted only within supplied proven free region; overflow is atomic', () => {
  const constrained = { ...region, bottomLimit: 670 }
  const snapshot = structuredClone(constrained)
  expect(planSourceParagraph('one longerword three four five six', codec, constrained)).toEqual({ ok: false, error: 'overflow' })
  expect(constrained).toEqual(snapshot)
  expect(planSourceParagraph('one two three', codec, constrained).ok).toBe(true)
  expect(planSourceParagraph('supercalifragilistic', codec, region)).toEqual({ ok: false, error: 'overflow' })
})

test('refuses hard breaks, ambiguous spacing, controls, combining marks and oversized input', () => {
  for (const text of ['a\nb', 'a\rb', 'a  b', ' a', 'a ', 'a\u00a0b', 'u\u0308', 'a\u202eb', 'a\u00adb', '', 'a'.repeat(4097)]) {
    expect(planSourceParagraph(text, codec, region)).toEqual({ ok: false, error: 'unsupported-text' })
  }
})

test('invalid geometry fails closed', () => {
  for (const change of [{ leading: 0 }, { leading: 9 }, { ascent: NaN }, { right: 49 }, { fontSize: -2 }, { descent: -1 }, { originalLineCount: 1.5 }, { firstBaseline: NaN }, { left: -1e308, right: 1e308 }, { bottomLimit: 701 }]) {
    expect(planSourceParagraph('one two', codec, { ...region, ...change })).toEqual({ ok: false, error: 'invalid-geometry' })
  }
})

test('verified WinAnsi codes and source-font widths round-trip through a real PDF independently', async () => {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const text = 'Grüße Würzburg ÄÖÜ äöü ß. English text.'
  const map = [...new Set(text)].map(character => ({ character, code: font.encodeText(character).asString(), advance: font.widthOfTextAtSize(character, 1000) }))
  const result = sourceFontCodec(map, 1)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const planned = planSourceParagraph(text, result.value, { ...region, right: 400 })
  expect(planned.ok).toBe(true)
  if (!planned.ok) return
  const page = doc.addPage([595, 842])
  page.node.setFontDictionary(PDFName.of('F1'), font.ref)
  const stream = doc.context.flateStream(`BT /F1 10 Tf ${planned.value.lines.map(line => `1 0 0 1 ${line.x} ${line.baseline} Tm ${PDFHexString.of(line.hex).toString()} Tj`).join('\n')} ET`)
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
