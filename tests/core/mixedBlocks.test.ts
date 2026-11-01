import { expect, test } from 'vitest'
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import type { PDFFont } from 'pdf-lib'
import { inspectPageSource, previewPageSource } from '../../src/core/sourceText/mixedPdf'
import { previewPageSources } from '../../src/core/sourceText/mixedBatch'
import type { SourceRun } from '../../src/core/sourceText/sourceTypes'

const n = PDFName.of
const SIZE = 12, LEADING = 14.4, LEFT = 72
type Frag = string | { text: string; font: 'F1' | 'F2' }
interface Para { lines: Frag[][]; top: number }
const word = (text: string, at = 3) => text.split(/(?<= )/).reduce<string[]>((parts, w, i) => {
  if (i % at === 0) parts.push(w); else parts[parts.length - 1] += w
  return parts
}, [])

/** Word-like layout: every fragment is its own clipped BT/ET with absolute Tm. */
async function wordPdf(paragraphs: Para[], options: { tags?: boolean; between?: string } = {}) {
  const d = await PDFDocument.create(), p = d.addPage([595, 842])
  const fonts: Record<string, PDFFont> = {
    F1: await d.embedFont(StandardFonts.Helvetica),
    F2: await d.embedFont(StandardFonts.HelveticaOblique),
  }
  p.node.set(n('Resources'), d.context.obj({ Font: { F1: fonts.F1.ref, F2: fonts.F2.ref } }))
  let mcid = 0, ops = ''
  // Word tags a whole paragraph as one marked-content sequence.
  for (const para of paragraphs) {
  if (options.tags) ops += `/P <</MCID ${mcid++}>> BDC\n`
  para.lines.forEach((line, li) => {
    let x = LEFT
    const y = para.top - li * LEADING
    line.forEach((frag, fi) => {
      const { text, font } = typeof frag === 'string' ? { text: frag, font: 'F1' as const } : frag
      const lit = text.replace(/[\\()]/g, (c) => '\\' + c)
      const show = `q 0 0 595 842 re W* n BT /${font} ${SIZE} Tf 1 0 0 1 ${x.toFixed(3)} ${y.toFixed(3)} Tm 0 g [(${lit})] TJ ET Q`
      ops += show + '\n'
      x += fonts[font].widthOfTextAtSize(text, SIZE)
      if (li === 0 && fi === 0 && options.between) ops += options.between + '\n'
    })
  })
  if (options.tags) ops += 'EMC\n'
  }
  p.node.set(n('Contents'), d.context.register(d.context.flateStream(ops)))
  if (options.tags) {
    d.catalog.set(n('StructTreeRoot'), d.context.obj({ Type: 'StructTreeRoot', K: [] }))
    p.node.set(n('StructParents'), d.context.obj(0))
  }
  return d.save()
}
const body: Para = {
  top: 760,
  lines: [
    word('Dieses Dokument zeigt einen Absatz, der in Word '),
    word('entstanden ist und aus vielen einzelnen Textfragmenten '),
    [...word('besteht, die jeweils absolut positioniert sind und '), { text: 'kursive ', font: 'F2' }, 'Teile '],
    ['enthalten. Hier ', 'handelt', '.'],
  ],
}
const next: Para = { top: 690, lines: [word('Der folgende Absatz bleibt unverändert stehen. ')] }
const groups = (runs: SourceRun[]) => {
  const g = new Map<string, SourceRun[]>()
  for (const r of runs) if (r.selection?.groupId) g.set(r.selection.groupId, [...(g.get(r.selection.groupId) ?? []), r])
  return [...g.values()]
}
const glyphs = (runs: SourceRun[]) => runs.flatMap((r) => [...r.text].map((char, i) => ({
  char, x: r.x + r.selection!.characters[i].offset, end: r.x + r.selection!.characters[i].offset + r.selection!.characters[i].width, baseline: r.baseline,
})))
async function edit(bytes: Uint8Array, find: string, to: string, extra: { confirmReflow?: boolean; scope?: 'paragraph' | 'line' } = {}) {
  const a = await inspectPageSource(bytes, 0)
  const members = groups(a.runs).find((rs) => rs[0].paragraph!.text.includes(find))!
  const r = members[0]
  return previewPageSource(bytes, { digest: a.digest, runId: r.id, expectedText: r.text, scope: 'paragraph', ...extra }, r.paragraph!.text.replace(find, to))
}
const paragraphText = 'Dieses Dokument zeigt einen Absatz, der in Word entstanden ist und aus vielen einzelnen Textfragmenten besteht, die jeweils absolut positioniert sind und kursive Teile enthalten. Hier handelt.'

test('Word fragments of one paragraph become one automatic block; every fragment stays selectable', async () => {
  const a = await inspectPageSource(await wordPdf([body, next], { tags: true }), 0)
  expect(a.runs.every((r) => r.selection?.groupId)).toBe(true) // edge spaces no longer gray out fragments
  const g = groups(a.runs)
  expect(g).toHaveLength(2)
  expect(g[0].length).toBeGreaterThan(10)
  expect(g[0][0].paragraph).toMatchObject({ text: paragraphText, lineCount: 4, separator: '', automatic: true })
  expect(g[0].map((r) => r.text).join('')).toBe(paragraphText)
  expect(g[1][0].paragraph).toMatchObject({ lineCount: 1, automatic: true })
})

test('shortening a fragment pulls the following period along instead of leaving a gap', async () => {
  const before = await inspectPageSource(await wordPdf([body, next], { tags: true }), 0)
  const out = await edit(await wordPdf([body, next], { tags: true }), 'handelt.', 'hande.')
  const after = await inspectPageSource(out, 0), g = groups(after.runs)
  expect(g[0][0].paragraph!.text).toBe(paragraphText.replace('handelt.', 'hande.'))
  const chars = glyphs(g[0]), e = chars.findLastIndex((c) => c.char === 'e')
  expect(chars[e + 1].char).toBe('.')
  expect(Math.abs(chars[e + 1].x - chars[e].end)).toBeLessThan(0.01)
  // Untouched text keeps its exact position and the next paragraph is unchanged.
  const old = glyphs(groups(before.runs)[0])
  for (let i = 0; i < 60; i++) expect(chars[i].x).toBeCloseTo(old[i].x, 3)
  expect(glyphs(g[1])).toEqual(glyphs(groups(before.runs)[1]))
})

test('longer and shorter text reflows words between lines without moving other content', async () => {
  const pdf = await wordPdf([body, next], { tags: true })
  const longer = groups((await inspectPageSource(await edit(pdf, 'einen Absatz', 'einen ziemlich langen Absatz'), 0)).runs)
  expect(longer[0][0].paragraph).toMatchObject({ lineCount: 4, text: paragraphText.replace('einen Absatz', 'einen ziemlich langen Absatz') })
  const firstLine = glyphs(longer[0]).filter((c) => c.baseline === 760).map((c) => c.char).join('')
  expect(firstLine.trim().endsWith('Word')).toBe(false) // a word moved down
  const shorter = groups((await inspectPageSource(await edit(pdf, 'entstanden ist und aus vielen einzelnen', 'aus'), 0)).runs)
  expect(shorter[0][0].paragraph!.lineCount).toBe(3) // words moved up, last line vanished
  for (const g of [longer, shorter]) expect(g[1][0].paragraph!.text).toBe(next.lines[0].join(''))
})

test('extra lines are only used when the space below is free', async () => {
  const add = ' Dieser zusätzliche Satz braucht ganz sicher eine weitere Zeile im Absatz.'
  const free = await wordPdf([body], { tags: true })
  const grown = await inspectPageSource(await edit(free, 'Hier handelt.', 'Hier handelt.' + add), 0)
  expect(groups(grown.runs)[0][0].paragraph!.lineCount).toBe(5)
  const crowded = await wordPdf([body, { ...next, top: 760 - 4 * LEADING }], { tags: true })
  await expect(edit(crowded, 'Hier handelt.', 'Hier handelt.' + add)).rejects.toThrow(/überlappen|nichts verändert/)
})

test('repeated edits keep the reconstructed block editable', async () => {
  let pdf = await edit(await wordPdf([body, next], { tags: true }), 'handelt.', 'hande.')
  pdf = await edit(pdf, 'Dokument', 'Beispieldokument')
  pdf = await edit(pdf, 'kursive Teile', 'kursivere Teile')
  const g = groups((await inspectPageSource(pdf, 0)).runs)
  expect(g).toHaveLength(2)
  expect(g[0][0].paragraph!.text).toBe(paragraphText.replace('handelt.', 'hande.').replace('Dokument', 'Beispieldokument').replace('kursive', 'kursivere'))
})

test('edited words keep the style of the text they replace (italic stays italic)', async () => {
  const pdf = await edit(await wordPdf([body, next], { tags: true }), 'kursive', 'schräge')
  const runs = (await inspectPageSource(pdf, 0)).runs
  const chars = runs.flatMap((r) => [...r.text].map((c) => ({ c, font: r.fontName })))
  const text = chars.map((x) => x.c).join(''), at = text.indexOf('schräge')
  expect(chars.slice(at, at + 7).every((x) => /Oblique/.test(x.font))).toBe(true)
  expect(/Oblique/.test(chars[at - 2].font)).toBe(false)
})

test('untagged multi-line blocks reflow like tagged ones (the inline editor shows the result first)', async () => {
  const pdf = await wordPdf([body, next])
  const a = await inspectPageSource(pdf, 0)
  expect(groups(a.runs)[0][0].paragraph).toMatchObject({ lineCount: 4, automatic: true })
  const out = await edit(pdf, 'handelt.', 'hande.')
  expect(groups((await inspectPageSource(out, 0)).runs)[0][0].paragraph!.text).toContain('Hier hande.')
})

test('a hard line break, painted content between fragments or mixed sizes split the block', async () => {
  const hard: Para = { top: 760, lines: [['Kurze Zeile. '], word('Danach beginnt eine neue Zeile mit Text. ')] }
  expect(groups((await inspectPageSource(await wordPdf([hard], { tags: true }), 0)).runs)).toHaveLength(2)
  const painted = await inspectPageSource(await wordPdf([body], { tags: true, between: '0 0 1 RG 300 300 m 310 310 l S' }), 0)
  expect(groups(painted.runs).length).toBeGreaterThan(1)
})

test('several paragraphs are checked together in one candidate; each against the previous result', async () => {
  const bytes = await wordPdf([body, next], { tags: true })
  const a = await inspectPageSource(bytes, 0), g = groups(a.runs)
  const sel = (rs: SourceRun[]) => ({ digest: a.digest, runId: rs[0].id, expectedText: rs[0].text, scope: 'paragraph' as const })
  const out = await previewPageSources(bytes, [
    { selection: sel(g[0]), replacement: paragraphText.replace('handelt.', 'hande.') },
    { selection: sel(g[1]), replacement: 'Der folgende Absatz bleibt stehen. ' },
  ])
  const after = groups((await inspectPageSource(out, 0)).runs)
  expect(after.map((rs) => rs[0].paragraph!.text)).toEqual([paragraphText.replace('handelt.', 'hande.'), 'Der folgende Absatz bleibt stehen. '])
  // Both blocks keep their first baseline.
  expect(after.map((rs) => rs[0].baseline)).toEqual(g.map((rs) => rs[0].baseline))
  // A stale paragraph refuses the whole batch and names the paragraph.
  await expect(previewPageSources(bytes, [
    { selection: sel(g[0]), replacement: paragraphText.replace('handelt.', 'hande.') },
    { selection: { ...sel(g[1]), expectedText: 'veraltet' }, replacement: 'x' },
  ])).rejects.toThrow(/veraltet/)
  // A failing later paragraph names it; nothing is returned.
  await expect(previewPageSources(bytes, [
    { selection: sel(g[0]), replacement: paragraphText.replace('handelt.', 'hande.') },
    { selection: sel(g[1]), replacement: 'Der folgende Absatz bleibt unverändert stehen. ' + 'und wächst über die Seitenbreite hinaus '.repeat(40) },
  ])).rejects.toThrow(/Absatz „Der folgende Absatz/)
})

test('member runs of one block share one paragraph object (sent once to the UI)', async () => {
  const a = await inspectPageSource(await wordPdf([body, next], { tags: true }), 0), g = groups(a.runs)
  expect(g[0].every((r) => r.paragraph === g[0][0].paragraph)).toBe(true)
  const copy = structuredClone(a.runs)
  expect(copy[0].paragraph).toBe(copy[1].paragraph)
})
