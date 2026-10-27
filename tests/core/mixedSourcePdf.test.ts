import fontkit from '@pdf-lib/fontkit'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  inspectPageSource,
  previewPageSource,
} from '../../src/core/sourceText/mixedPdf'
import { contentTokens } from '../../src/core/sourceText/contentTokens'
import { unicodeMap } from '../../src/core/sourceText/sourceFonts'
const n = PDFName.of
async function fixture(
  options: {
    extra?: string
    text?: string
    tags?: boolean
    otherBad?: boolean
    shared?: boolean
  } = {},
) {
  const d = await PDFDocument.create(),
    p = d.addPage([600, 800]),
    font = await d.embedFont(StandardFonts.Helvetica)
  p.node.set(n('Resources'), d.context.obj({ Font: { F1: font.ref } }))
  const tag = options.tags ? '/Span << /MCID 0 /Lang (de-DE) >> BDC\n' : ''
  const stream = d.context.register(
    d.context.flateStream(
      `${tag}q\nBT /F1 12 Tf 1 0 0 1 60 700 Tm 0.1 Tc [(${options.text ?? 'A small typo'}) 5 ( here)] TJ 0 -40 Td (Following text) Tj ET\nQ\n${options.tags ? 'EMC\n' : ''}${options.extra ?? ''}`,
    ),
  )
  p.node.set(n('Contents'), stream)
  if (options.tags) {
    d.catalog.set(
      n('StructTreeRoot'),
      d.context.obj({ Type: 'StructTreeRoot', K: [] }),
    )
    p.node.set(n('StructParents'), d.context.obj(0))
  }
  if (options.otherBad || options.shared) {
    const p2 = d.addPage([600, 800])
    p2.node.set(n('Resources'), p.node.Resources()!)
    p2.node.set(
      n('Contents'),
      options.shared
        ? stream
        : d.context.register(
            d.context.flateStream('BT 1 2 UnsupportedOperation ET'),
          ),
    )
  }
  return d.save()
}
async function replace(
  bytes: Uint8Array,
  text = 'A corrected typo here',
  page = 0,
) {
  const a = await inspectPageSource(bytes, page),
    r = a.runs[0]
  return previewPageSource(
    bytes,
    { digest: a.digest, runId: r.id, expectedText: r.text },
    text,
  )
}
async function extract(bytes: Uint8Array, page = 1) {
  const task = getDocument({
    data: bytes.slice(),
    standardFontDataUrl:
      resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
  })
  try {
    const d = await task.promise
    return (await (await d.getPage(page)).getTextContent()).items.filter(
      (i) => 'str' in i,
    )
  } finally {
    await task.destroy()
  }
}
function cmap(body: string) {
  return `/CIDInit /ProcSet findresource begin 26 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${body} endcmap CMapName currentdict /CMap defineresource pop end end`
}
test('page-scoped analysis does not reject a supported page for unrelated operators on another page', async () => {
  const b = await fixture({ otherBad: true }),
    a = await inspectPageSource(b, 0)
  const chars = a.runs[0].selection!.characters
  expect(chars).toHaveLength(a.runs[0].text.length)
  expect(chars[0].width).toBeCloseTo(8.004 + 0.1, 8) // A at 12pt plus original Tc
  expect(chars[12].offset).toBeCloseTo(chars[11].offset + chars[11].width - 0.06, 8) // TJ 5
  expect(chars.at(-1)!.offset + chars.at(-1)!.width).toBeCloseTo(a.runs[0].width, 8)
  expect(a.runs[0].selection!.groupId).toBeUndefined() // never invent paragraph support

  expect(a.runs[0].text).toBe('A small typo here')
  await expect(inspectPageSource(b, 1)).rejects.toThrow(
    /Seite 2.*UnsupportedOperation/,
  )
  const c = await replace(b)
  expect((await extract(c))[0].str).toBe('A corrected typo here')
})
test('TJ and relative Td retain neighbour positions after shorter and longer replacements', async () => {
  const b = await fixture(),
    before = await extract(b)
  for (const text of ['A typo here', 'A corrected typo here']) {
    const c = await replace(b, text),
      after = await extract(c)
    expect(after[0].str).toBe(text)
    expect(after[0].transform).toEqual(before[0].transform)
    expect(after[1].transform).toEqual(before[1].transform)
    expect(after[1].str).toBe(before[1].str)
  }
})
test('tags and MCIDs are preserved, not removed to make a document editable', async () => {
  const b = await fixture({ tags: true }),
    c = await replace(b),
    d = await PDFDocument.load(c)
  expect(d.catalog.has(n('StructTreeRoot'))).toBe(true)
  expect(d.getPage(0).node.has(n('StructParents'))).toBe(true)
  const contents = d.getPage(0).node.Contents()!,
    raw = contents instanceof PDFArray ? contents.lookup(0) : contents
  expect(
    String.fromCharCode(...decodePDFRawStream(raw as PDFRawStream).decode()),
  ).toMatch(/MCID 0/)
})
test('images and vector paths are preserved and protect their occupied regions', async () => {
  const b = await fixture({
    extra: 'q 20 0 0 20 300 690 cm /Img Do Q\n400 500 20 20 re f',
  })
  const d = await PDFDocument.load(b),
    p = d.getPage(0),
    img = d.context.register(
      d.context.stream(Uint8Array.of(255, 0, 0), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 1,
        Height: 1,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
      }),
    )
  p.node.Resources()!.set(n('XObject'), d.context.obj({ Img: img }))
  const input = await d.save(),
    c = await replace(input)
  const after = await PDFDocument.load(c)
  expect(after.context.lookup(img)?.toString()).toBe(
    d.context.lookup(img)?.toString(),
  )
  await expect(replace(input, 'A '.repeat(30).trim())).rejects.toThrow(
    /geschützten Abstand/,
  )
})
test('links protect their hit area while unrelated links do not block editing', async () => {
  const d = await PDFDocument.load(await fixture())
  d.getPage(0).node.set(
    n('Annots'),
    d.context.obj([
      {
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [230, 690, 300, 720],
        A: { S: 'URI', URI: 'https://example.com' },
      },
    ]),
  )
  const b = await d.save()
  await replace(b)
  await expect(replace(b, 'A '.repeat(25).trim())).rejects.toThrow(/Abstand/)
})
test('copy-on-write does not modify a second page that shares the original content stream', async () => {
  const b = await fixture({ shared: true }),
    before = await extract(b, 2),
    c = await replace(b)
  const stable = (items: Awaited<ReturnType<typeof extract>>) =>
    items.map(({ fontName: _fontName, ...rest }) => {
      void _fontName
      return rest
    })
  expect(stable(await extract(c, 2))).toEqual(stable(before))
  const d = await PDFDocument.load(c)
  expect(d.getPage(0).node.Resources()?.lookup(n('Font'))?.toString()).toBe(
    d.getPage(1).node.Resources()?.lookup(n('Font'))?.toString(),
  )
})
test('unshared replacement does not leave the original text stream as an orphan', async () => {
  const c = await replace(await fixture()),
    d = await PDFDocument.load(c)
  for (const [, raw] of d.context.enumerateIndirectObjects())
    if (raw instanceof PDFRawStream) {
      let s = ''
      try {
        s = String.fromCharCode(...decodePDFRawStream(raw).decode())
      } catch {
        /* other binary streams */
      }
      expect(s).not.toContain('A small typo')
    }
})
test('unsupported selected-page painting reports the operator and page, without modifying input', async () => {
  const b = await fixture({ extra: '/Shade sh' }),
    snapshot = b.slice()
  await expect(inspectPageSource(b, 0)).rejects.toThrow(/Seite 1.*sh/)
  expect(b).toEqual(snapshot)
})
test('ActualText and nonrectangular clipping fail with a concrete preservation reason', async () => {
  await expect(
    inspectPageSource(
      await fixture({ extra: '/Span << /ActualText (cache) >> BDC EMC' }),
      0,
    ),
  ).rejects.toThrow(/ActualText/)
  await expect(
    inspectPageSource(
      await fixture({ extra: '10 20 m 50 60 l 20 80 l h W n' }),
      0,
    ),
  ).rejects.toThrow(/Clipfläche/)
})
test('stale selections, paragraph requests on fragmented source and missing glyphs reject atomically', async () => {
  const b = await fixture(),
    a = await inspectPageSource(b, 0),
    r = a.runs[0],
    s = { digest: a.digest, runId: r.id, expectedText: r.text }
  await expect(
    previewPageSource(b, { ...s, digest: 'stale' }, 'new'),
  ).rejects.toThrow(/veraltet/)
  await expect(
    previewPageSource(
      b,
      { ...s, scope: 'paragraph', confirmReflow: true },
      'new',
    ),
  ).rejects.toThrow(/keinem nachgewiesenen Absatz/)
  await expect(previewPageSource(b, s, 'ẞ')).rejects.toThrow(/Originalschrift/)
})
test('bounded composite lexer respects literal strings and absolute offsets', () => {
  const s = '[ (a]b) -20 <0041> ] TJ /Span << /MCID 0 /Lang (de) >> BDC'
  const t = contentTokens(s, true)
  expect(t[0].kind).toBe('array')
  expect(t[0].items!.map((x) => x.raw)).toEqual(['(a]b)', '-20', '<0041>'])
  for (const x of t[0].items!) expect(s.slice(x.start, x.end)).toBe(x.raw)
  expect(() => contentTokens('['.repeat(20) + ']'.repeat(20), true)).toThrow()
  expect(() => contentTokens('[1 2]')).toThrow() // strict legacy mode remains strict
})
test('bounded bfrange supports sequential and array ranges and leaves ligatures non-encodable', () => {
  const m = unicodeMap(
    cmap(
      '1 beginbfchar <0001> <00660069> endbfchar 1 beginbfrange <0002> <0003> <0041> endbfrange 1 beginbfrange <0004> <0005> [<00E4> <00DF>] endbfrange',
    ),
    true,
  )
  expect([...m.values()]).toEqual(['fi', 'A', 'B', 'ä', 'ß'])
  expect(() =>
    unicodeMap(cmap('1 beginbfrange <0002> <0003> <FFFF> endbfrange'), true),
  ).toThrow()
  expect(() =>
    unicodeMap(cmap('1 beginbfrange <0002> <0003> [<0041>] endbfrange'), true),
  ).toThrow()
})

test('original ligature glyphs stay byte-identical and are never silently split into missing letters', async () => {
  const d = await PDFDocument.create()
  d.registerFontkit(fontkit)
  const f = await d.embedFont(
    readFileSync(
      'node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff',
    ),
    { subset: true },
  )
  const p = d.addPage([600, 800])
  p.drawText('office', { font: f, size: 12, x: 60, y: 700 })
  p.drawText('safe text', { font: f, size: 12, x: 60, y: 640 })
  const b = await d.save(),
    a = await inspectPageSource(b, 0)
  expect(a.runs.some((r) => r.text === 'safe text')).toBe(true)
  const r = a.runs.find((x) => x.text === 'office')!
  // Only the block path may touch ligature glyphs; the fragment path refuses.
  expect(r.paragraph?.automatic).toBe(true)
  const s = { digest: a.digest, runId: r.id, expectedText: r.text }
  await expect(previewPageSource(b, s, 'ofice')).rejects.toThrow(/nicht sicher bearbeitbar/)
  // Splitting the ligature would need an unembedded "i": rejected, not faked.
  await expect(
    previewPageSource(b, { ...s, scope: 'paragraph' }, 'ofice'),
  ).rejects.toThrow(/„i“ fehlt/)
  // An untouched ligature keeps its original glyph code.
  const out = await previewPageSource(b, { ...s, scope: 'paragraph' }, 'offices')
  expect((await inspectPageSource(out, 0)).runs.map((x) => x.text)).toEqual(['offices', 'safe text'])
})
test('structure-tree replacement text is not left as a stale accessibility cache', async () => {
  const d = await PDFDocument.load(await fixture({ tags: true }))
  d.catalog.set(
    n('StructTreeRoot'),
    d.context.obj({
      Type: 'StructTreeRoot',
      K: [{ Type: 'StructElem', S: 'P', ActualText: 'cached original' }],
    }),
  )
  await expect(inspectPageSource(await d.save(), 0)).rejects.toThrow(
    /Strukturbaum.*ActualText/,
  )
})
