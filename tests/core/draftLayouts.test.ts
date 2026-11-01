import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { expect, test } from 'vitest'
import { liveBlock, liveFont } from '../../src/core/sourceText/editModel'
import { draftLayouts, inlineLayout, lineBoxes, modelLimits } from '../../src/core/sourceText/inlineLayout'
import { inspectPageSource } from '../../src/core/sourceText/mixedPdf'

const n = PDFName.of
async function twoLines() {
  const d = await PDFDocument.create(), p = d.addPage([600, 800]), font = await d.embedFont(StandardFonts.Helvetica)
  p.node.set(n('Resources'), d.context.obj({ Font: { F1: font.ref } }))
  p.node.set(n('Contents'), d.context.register(d.context.flateStream(
    'BT /F1 12 Tf 1 0 0 1 60 700 Tm (First line) Tj ET\nBT /F1 12 Tf 1 0 0 1 60 600 Tm (Second line) Tj ET\n',
  )))
  const analysis = await inspectPageSource(await d.save(), 0), fonts = analysis.fonts.map(liveFont)
  const [first, second] = analysis.blocks
  const of = (texts: Record<string, string>) => (id: string) => {
    const model = analysis.blocks.find(b => b.id === id)!
    return { model, block: liveBlock(model, fonts), text: texts[id] ?? model.text }
  }
  return { first, second, of, rects: analysis.rects }
}

test('a paragraph alone lays out against the page as it is', async () => {
  const { first, of, rects } = await twoLines()
  const view = draftLayouts([first.id], [], of({}), rects).get(first.id)!
  expect(view).toEqual(inlineLayout(of({})(first.id).block, first.text, modelLimits(first, rects)))
})

test('with a draft next to it, a paragraph sees that draft and only that', async () => {
  const { first, second, of, rects } = await twoLines()
  const views = draftLayouts([first.id], [first.id, second.id], of({ [second.id]: 'Second edit' }), rects)
  expect([...views.keys()]).toEqual([first.id])
  expect(views.get(first.id)).not.toBeNull()
})

test('line ink skips spaces, as the worker does', async () => {
  const { first, of, rects } = await twoLines()
  const box = (text: string) => lineBoxes(draftLayouts([first.id], [], of({ [first.id]: text }), rects).get(first.id)!)[0]
  expect(box('First line ').right).toBeCloseTo(box('First line').right, 6)
})
