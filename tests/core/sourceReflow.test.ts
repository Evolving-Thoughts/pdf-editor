import { expect, test } from 'vitest'
import { PDFDocument, PDFName, StandardFonts, decodePDFRawStream, PDFRawStream } from 'pdf-lib'
import type { PDFFont } from 'pdf-lib'
import { inspectPageSource, previewPageSource } from '../../src/core/sourceText/mixedPdf'
import { contentTokens } from '../../src/core/sourceText/contentTokens'
import { liveBlock, liveFont, modelSpace } from '../../src/core/sourceText/editModel'
import type { EditFont, EditModel } from '../../src/core/sourceText/editModel'
import { layoutEdit } from '../../src/core/sourceText/mixedBlocks'
import { caretStops, hitOffset, inlineLayout, lineRange, nearestOffset, paintedGlyphs, selectionRects } from '../../src/core/sourceText/inlineLayout'

const n = PDFName.of
const lit = (t: string) => t.replace(/[\\()]/g, (c) => '\\' + c)

/** One-page Helvetica PDF; `body(font)` returns the content stream. */
async function pdf(body: (font: PDFFont) => string, annots?: number[][]) {
  const d = await PDFDocument.create(), p = d.addPage([600, 800])
  const font = await d.embedFont(StandardFonts.Helvetica)
  p.node.set(n('Resources'), d.context.obj({ Font: { F1: font.ref } }))
  p.node.set(n('Contents'), d.context.register(d.context.flateStream(body(font))))
  if (annots)
    p.node.set(n('Annots'), d.context.obj(annots.map((r) => d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: r, Border: [0, 0, 0] })))))
  return d.save()
}
/** Plain paragraph: one BT per line, 12 pt, leading 14.4, starting at y=700. */
const lines = (rows: string[], top = 700, x = 72) =>
  rows.map((r, i) => `BT /F1 12 Tf 1 0 0 1 ${x} ${(top - i * 14.4).toFixed(2)} Tm (${lit(r)}) Tj ET`).join('\n')
const para = ['Ein kurzer Absatz mit einigen Worten, der sich', 'ueber drei Zeilen erstreckt und danach endet,', 'damit Bearbeitungen umbrechen.']
const follow = 'BT /F1 12 Tf 1 0 0 1 72 600 Tm (Der folgende Absatz bleibt stehen.) Tj ET'

async function blocks(bytes: Uint8Array) {
  const a = await inspectPageSource(bytes, 0)
  const rects = 'rects' in a ? a.rects : []
  return { a, blocks: a.blocks as EditModel[], fonts: a.fonts as EditFont[], limits: (m: EditModel) => ({ room: m.room, pinned: m.pinned, slots: m.slots, space: modelSpace(m, rects) }) }
}
async function edit(bytes: Uint8Array, find: string, to: string) {
  const { a, blocks: bs } = await blocks(bytes)
  const b = bs.find((x) => x.text.includes(find))!
  return previewPageSource(bytes, { digest: a.digest, runId: b.runId, expectedText: b.expectedText, scope: 'paragraph' }, b.text.replace(find, to))
}
const content = async (bytes: Uint8Array) => {
  const d = await PDFDocument.load(bytes), c = d.getPage(0).node.Contents()
  const s = c instanceof PDFRawStream ? c : (d.context.lookup((c as unknown as { get(i: number): never }).get(0)) as PDFRawStream)
  return new TextDecoder('latin1').decode(decodePDFRawStream(s).decode())
}
const runsAt = async (bytes: Uint8Array, y: number) =>
  (await inspectPageSource(bytes, 0)).runs.filter((r) => Math.abs(r.baseline - y) < 0.01).map((r) => ({ text: r.text, x: r.x }))

test('paragraph model: lines, room and limit; the UI layout matches the real PDF edit', async () => {
  const bytes = await pdf(() => `${lines(para)}\n${follow}`)
  const { blocks: bs, fonts } = await blocks(bytes)
  const b = bs.find((x) => x.text.startsWith('Ein kurzer'))!
  expect(b.lines).toHaveLength(3)
  expect(b.text).toBe(para.join(' '))
  expect(b.room).toBeGreaterThan(0)
  expect(b.slots).toHaveLength(3)
  const live = liveBlock(b, fonts.map(liveFont))
  const text = b.text.replace('einigen', 'ziemlich vielen zusaetzlichen')
  const planned = layoutEdit(live, text)
  expect(planned.ok).toBe(true)
  const out = await edit(bytes, 'einigen', 'ziemlich vielen zusaetzlichen')
  const after = (await blocks(out)).blocks.find((x) => x.text.startsWith('Ein kurzer'))!
  expect(after.text).toBe(text)
  expect(planned.ok && planned.lines.map((l) => l.baseline)).toEqual(after.lines.map((l) => l.baseline))
  expect(await runsAt(out, 600)).toEqual(await runsAt(bytes, 600))
})

test('characters outside the font are reported by the live layout before any PDF work', async () => {
  const { blocks: bs, fonts } = await blocks(await pdf(() => lines(para)))
  const r = layoutEdit(liveBlock(bs[0], fonts.map(liveFont)), bs[0].text + ' ア')
  expect(r).toMatchObject({ ok: false, reason: 'char', char: 'ア' })
})

test('scaled page matrix with one Tj per character (HTML renderers) forms an editable block', async () => {
  const bytes = await pdf((font) => {
    const row = (t: string, y: number) => {
      let x = 96, ops = ''
      for (const c of t) {
        ops += `BT /F1 16 Tf 1 0 0 1 ${x.toFixed(3)} ${y} Tm (${lit(c)}) Tj ET\n`
        x += font.widthOfTextAtSize(c, 16)
      }
      return ops
    }
    // 0.75 maps CSS pixels to points; the 16 px text is 12 pt on the page.
    return `q 0.75 0 0 0.75 0 0 cm\n${row('Gerenderter Text aus einem', 900)}${row('Browser mit Einzelzeichen.', 880)}Q\n`
  })
  const { blocks: bs } = await blocks(bytes)
  expect(bs[0]).toMatchObject({ text: 'Gerenderter Text aus einem Browser mit Einzelzeichen.', size: 12 })
  expect(bs[0].lines).toHaveLength(2)
  const out = await edit(bytes, 'einem', 'dem')
  expect((await blocks(out)).blocks[0].text).toBe('Gerenderter Text aus dem Browser mit Einzelzeichen.')
})

test('ActualText spaces (NBSP) survive an edit and the lexer reads <FEFF00A0>>> correctly', async () => {
  const t = contentTokens('/Span <</ActualText <FEFF00A0>>> BDC')
  expect(t.map((x) => x.raw)).toEqual(['/Span', '<</ActualText <FEFF00A0>>>', 'BDC'])
  const bytes = await pdf(() => 'BT /F1 12 Tf 1 0 0 1 72 700 Tm (Seite) Tj /Span <</ActualText <FEFF00A0>>> BDC ( ) Tj EMC (12 von 20 Seiten) Tj ET')
  const { blocks: bs } = await blocks(bytes)
  expect(bs[0].text).toBe('Seite\u00a012 von 20 Seiten')
  const out = await edit(bytes, '20', '30')
  expect((await blocks(out)).blocks[0].text).toBe('Seite\u00a012 von 30 Seiten')
  expect(await content(out)).toMatch(/\/ActualText <FEFF00A0>/)
})

test('a hyphen at a line end between lowercase letters joins as a soft hyphen', async () => {
  const bytes = await pdf(() => lines(['Diese Zeile endet mit einer Silben-', 'trennung und geht hier weiter.']))
  const { blocks: bs } = await blocks(bytes)
  expect(bs[0].text).toBe('Diese Zeile endet mit einer Silben\u00adtrennung und geht hier weiter.')
  const out = await edit(bytes, 'Diese Zeile endet', 'Sie endet')
  const after = (await blocks(out)).blocks[0]
  expect(after.text).toBe('Sie endet mit einer Silben\u00adtrennung und geht hier weiter.')
  expect(after.lines).toHaveLength(2)
})

test('text under a link must not move; edits after the link are fine', async () => {
  const bytes = await pdf(() => lines(para), [[200, 683, 260, 697]])
  await expect(edit(bytes, 'kurzer', 'deutlich laengerer')).rejects.toThrow()
  const out = await edit(bytes, 'endet,', 'endet;')
  expect((await blocks(out)).blocks[0].text).toContain('endet;')
})

test('images and graphics below the paragraph block growth and stay byte-identical', async () => {
  const rect = '0.9 g 72 640 300 20 re f'
  const bytes = await pdf(() => `${lines(para)}\n${rect}\n`)
  await expect(edit(bytes, 'umbrechen.', 'umbrechen, und noch ein ganzer weiterer Satz, der Platz braucht.')).rejects.toThrow()
  const out = await edit(bytes, 'umbrechen.', 'umbrechen!')
  expect(await content(out)).toContain(rect)
})

test('inline layout: caret stops follow lines, hit tests find offsets, fit status reflects room', async () => {
  const { blocks: bs, fonts, limits } = await blocks(await pdf(() => `${lines(para)}\n${follow}`))
  const m = bs.find((x) => x.text.startsWith('Ein kurzer'))!, live = liveBlock(m, fonts.map(liveFont)), lim = limits(m)
  const v = inlineLayout(live, m.text, lim)!
  expect(v.status).toMatchObject({ kind: 'same', before: 3, after: 3 })
  const stops = caretStops(v)
  expect(stops).toHaveLength(m.text.length + 1)
  const second = para[0].length + 1
  // An offset at a soft line break starts the next line.
  expect(stops[second]).toMatchObject({ line: 1, x: 72 })
  expect(stops[0]).toMatchObject({ line: 0, x: 72 })
  expect(hitOffset(v, stops, 72.1, 685.6 + 3, 12)).toBe(second)
  expect(lineRange(v, 1)).toEqual({ start: second, end: second + para[1].length + 1 })
  // Moving down from the end of line 1 stays before line 2's trailing space.
  expect(nearestOffset(v, stops, 1, 1000)).toBe(second + para[1].length)
  expect(selectionRects(v, stops, 4, second + 3, 12)).toHaveLength(2)
  const grown = inlineLayout(live, m.text + ' Noch ein Satz.'.repeat(20), lim)!
  expect(grown.status.kind).toBe('overflow')
  expect(grown.overflow.size).toBeGreaterThan(0)
  const missing = inlineLayout(live, m.text.replace('kurzer', 'kurzer ÿ'), lim)!
  expect(missing.status.kind === 'ok' || missing.status.kind === 'missing').toBe(true)
  const bad = inlineLayout(live, m.text.replace('kurzer', 'kurzer ア'), lim)!
  expect(bad.status).toMatchObject({ kind: 'invalid', chars: ['ア'] })
  expect(bad.missing.size).toBe(1)
  expect(paintedGlyphs(bad).length).toBeGreaterThan(50)
})

test('inline layout pins text under a link like the worker does', async () => {
  const bytes = await pdf(() => lines(para), [[200, 683, 260, 697]])
  const { blocks: bs, fonts, limits } = await blocks(bytes)
  const m = bs[0], live = liveBlock(m, fonts.map(liveFont)), lim = limits(m)
  expect(m.pinned.length).toBeGreaterThan(0)
  expect(inlineLayout(live, m.text.replace('kurzer', 'deutlich laengerer'), lim)!.status.kind).toBe('pinned')
  expect(inlineLayout(live, m.text.replace('endet,', 'endet;'), lim)!.status.kind).toBe('ok')
})
