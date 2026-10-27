// Word-like source: every fragment is its own clipped BT/ET with absolute Tm,
// one marked-content sequence per paragraph. The paragraph must behave as one
// automatic block: one click selects it, shortening pulls the period along.
import { chromium } from 'playwright'
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
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
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }), errors = []
page.on('pageerror', (e) => errors.push(String(e)))
try {
  await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5237')
  await page.locator('input[accept="application/pdf"]').setInputFiles({ name: 'word-like.pdf', mimeType: 'application/pdf', buffer: bytes })
  await page.locator('.page canvas[data-render-state="ready"]').first().waitFor()
  await page.getByRole('button', { name: 'Originaltext korrigieren', exact: true }).click()
  await page.locator('.source-run-hit').first().waitFor()
  assert.equal(await page.locator('.source-block-outline').count(), 2, 'one outline per paragraph, not per fragment')
  assert.equal(await page.locator('.source-run-hit[tabindex="0"]').count(), 2, 'one keyboard stop per block')
  assert.equal(await page.locator('.source-unknown-hit').count(), 0, 'no grayed-out fragments between parts')
  await page.locator('.source-run-hit').filter({ hasText: /^handelt$/ }).click()
  const textarea = page.getByLabel('Ersatztext', { exact: true })
  assert.equal(await textarea.inputValue(), paragraph, 'a click selects the whole paragraph block')
  await page.getByText(/wird bei Bedarf automatisch neu umbrochen/).waitFor()
  assert.equal(await page.getByRole('checkbox', { name: /Fließtextabsatz/ }).count(), 0, 'structure-tagged blocks need no reflow confirmation')
  await textarea.fill(paragraph.replace('handelt.', 'hande.'))
  await page.getByRole('button', { name: 'PDF-Vorschau erzeugen', exact: true }).click()
  await page.getByText('PDF-Vorschau bereit. Absatz und Übergang zum Folgeabsatz prüfen.', { exact: true }).waitFor()
  await page.locator('.source-pdf-preview canvas[data-render-state="ready"]').waitFor()
  await page.getByRole('checkbox', { name: /Absatz, Abstände und Übergang/ }).check()
  await page.screenshot({ path: artifacts + '/blocks-preview.png', fullPage: true })
  await page.getByRole('button', { name: 'Korrektur übernehmen', exact: true }).click()
  await page.locator('.page canvas[data-render-state="ready"]').first().waitFor()
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click(); await confirmDefaultExport(page)
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
  console.log('PASS source blocks: Word-like fragments as one block, single click, automatic reflow, gapless shortening, export')
} catch (error) {
  console.error('Browser errors:', errors)
  console.error((await page.locator('body').innerText()).slice(-1400))
  await page.screenshot({ path: artifacts + '/blocks-failure.png', fullPage: true })
  throw error
} finally { await browser.close() }
