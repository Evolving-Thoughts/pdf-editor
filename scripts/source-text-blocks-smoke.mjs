// Word-like source: every fragment is its own clipped BT/ET with absolute Tm,
// one marked-content sequence per paragraph. The paragraph must behave as one
// automatic block: one click selects it, shortening pulls the period along.
import { clickExport, collectErrors, launchBrowser, pageReady, pdfInput } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { applyButton, checkInPdf, fit, inlineInput } from './source-inline-helper.mjs'
const artifacts = process.env.SMOKE_ARTIFACT_DIR ?? '/tmp/pdf-editor-source-blocks'
mkdirSync(artifacts, { recursive: true })
const d = await PDFDocument.create(), p = d.addPage([595, 842]), n = PDFName.of
const font = await d.embedFont(StandardFonts.Helvetica)
p.node.set(n('Resources'), d.context.obj({ Font: { F1: font.ref } }))
const paragraphs = [
  { top: 760, lines: [['Dieses Dokument ', 'zeigt einen ', 'Absatz, der in ', 'Word '], ['entstanden ist ', 'und aus vielen ', 'Fragmenten '], ['besteht. Hier ', 'handelt', '.']] },
  { top: 690, lines: [['Der folgende ', 'Absatz bleibt ', 'stehen. ']] },
]
let ops = '', mcid = 0
for (const para of paragraphs) {
  ops += `/P <</MCID ${mcid++}>> BDC\n`
  para.lines.forEach((line, li) => {
    let x = 72
    for (const text of line) {
      ops += `q 0 0 595 842 re W* n BT /F1 12 Tf 1 0 0 1 ${x.toFixed(3)} ${(para.top - li * 14.4).toFixed(3)} Tm 0 g [(${text})] TJ ET Q\n`
      x += font.widthOfTextAtSize(text, 12)
    }
  })
  ops += 'EMC\n'
}
p.node.set(n('Contents'), d.context.register(d.context.flateStream(ops)))
d.catalog.set(n('StructTreeRoot'), d.context.obj({ Type: 'StructTreeRoot', K: [] }))
p.node.set(n('StructParents'), d.context.obj(0))
const bytes = Buffer.from(await d.save())
const paragraph = paragraphs[0].lines.flat().join('')
const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }), errors = []
collectErrors(page, errors)
try {
  await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5237')
  await pdfInput(page).setInputFiles({ name: 'word-like.pdf', mimeType: 'application/pdf', buffer: bytes })
  await pageReady(page)
  await page.getByRole('button', { name: 'Originaltext korrigieren', exact: true }).click()
  await page.locator('.source-run-hit').first().waitFor()
  assert.equal(await page.locator('.source-block-outline').count(), 2, 'one outline per paragraph, not per fragment')
  assert.equal(await page.locator('.source-run-hit[tabindex="0"]').count(), 2, 'one keyboard stop per block')
  assert.equal(await page.locator('.source-unknown-hit').count(), 0, 'no grayed-out fragments between parts')
  // A click on a word puts the caret there; the whole block is edited in place.
  const word = await page.locator('.source-run-hit').filter({ hasText: /^handelt$/ }).boundingBox()
  await page.mouse.click(word.x + word.width - 1, word.y + word.height / 2)
  await page.locator('.source-inline').waitFor()
  assert.equal(await inlineInput(page).inputValue(), paragraph, 'a click edits the whole paragraph block')
  const at = await inlineInput(page).evaluate((a) => a.selectionStart)
  assert.equal(at, paragraph.indexOf('handelt.') + 'handelt'.length, 'caret lands at the click point')
  assert.equal(await page.getByRole('checkbox').count(), 0, 'no reflow confirmation')
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace')
  assert.equal(await inlineInput(page).inputValue(), paragraph.replace('handelt.', 'hande.'))
  assert.match(await fit(page), /^Passt · 3 Zeilen/)
  await page.screenshot({ path: artifacts + '/blocks-inline.png', fullPage: true })
  await checkInPdf(page)
  await page.screenshot({ path: artifacts + '/blocks-preview.png', fullPage: true })
  await applyButton(page).click()
  await pageReady(page)
  const pending = page.waitForEvent('download')
  await clickExport(page); await confirmDefaultExport(page)
  const output = readFileSync(await (await pending).path())
  const task = getDocument({ data: Uint8Array.from(output), standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/' })
  try {
    const items = (await (await (await task.promise).getPage(1)).getTextContent()).items.filter((x) => 'str' in x && x.str)
    const text = items.map((x) => x.str).join('')
    assert.ok(text.includes('Hier hande.'), 'period follows directly: ' + text)
    assert.ok(!text.includes('handelt'))
    const next = items.find((x) => x.str.startsWith('Der folgende'))
    assert.equal(next.transform[5], 690, 'following paragraph stays in position')
  } finally { await task.destroy() }
  assert.deepEqual(errors, [])
  console.log('PASS source blocks: Word-like fragments as one block, click-to-caret inline editing, automatic reflow, gapless shortening, export')
} catch (error) {
  console.error('Browser errors:', errors)
  console.error((await page.locator('body').innerText()).slice(-1400))
  await page.screenshot({ path: artifacts + '/blocks-failure.png', fullPage: true })
  throw error
} finally { await browser.close() }
