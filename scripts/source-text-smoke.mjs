import { chromium } from 'playwright'
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:5237'
const artifacts = process.env.SMOKE_ARTIFACT_DIR ?? '/tmp/pdf-editor-source-text'
mkdirSync(artifacts, { recursive: true })
const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
const originalText = 'This paragraph contains several short words that can flow naturally through the existing lines without moving the following paragraph.'
const measure = text => [...text].reduce((sum, c) => sum + font.widthOfTextAtSize(c, 12), 0)
const lines = []; let line = ''
for (const word of originalText.split(' ')) { const next = line ? line + ' ' + word : word; if (measure(next) > 220) { lines.push(line); line = word } else line = next }
lines.push(line)
doc.addPage([595, 842]).drawText(lines.join('\n'), { x: 50, y: 700, size: 12, font, lineHeight: 20 })
doc.getPages()[0].drawText('Following paragraph stays here.', { x: 50, y: 540, font, size: 12 })
const input = Buffer.from(await doc.save())
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
const errors = []; page.on('pageerror', error => errors.push(String(error)))
async function load(name = 'source-text.pdf', buffer = input) {
  await page.locator('input[accept="application/pdf"]').setInputFiles({ name, mimeType: 'application/pdf', buffer })
  await page.locator('.page canvas[data-render-state="ready"]').first().waitFor()
}
async function openPanel() {
  await page.getByRole('button', { name: 'Originaltext korrigieren', exact: true }).click()
  await page.getByLabel('Ersatztext', { exact: true }).waitFor()
  await page.locator('.source-run-hit').first().waitFor(); await page.locator('.source-run-hit').first().click()
}
async function generate(text) {
  await page.getByLabel('Ersatztext', { exact: true }).fill(text)
  await page.getByRole('button', { name: 'PDF-Vorschau erzeugen', exact: true }).click()
  await page.getByText('PDF-Vorschau bereit. Absatz und Übergang zum Folgeabsatz prüfen.', { exact: true }).waitFor()
  await page.locator('.source-pdf-preview canvas[data-render-state="ready"]').waitFor()
}
async function downloadText() {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click(); await confirmDefaultExport(page)
  const download = await pending, path = await download.path()
  const task = getDocument({ data: Uint8Array.from(readFileSync(path)), standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/' })
  try { const pdf = await task.promise; const items = (await (await pdf.getPage(1)).getTextContent()).items.filter(item => 'str' in item && item.str); return items }
  finally { await task.destroy() }
}
try {
  await page.goto(base); await load(); await openPanel()
  // Real drag across two proved lines; unrelated following text must reject.
  const sourceRuns=page.locator('.source-run-hit')
  async function dragBetween(first,from,last,to) {
    const a=await first.locator('span').nth(from).boundingBox(),b=await last.locator('span').nth(to-1).boundingBox()
    await page.mouse.move(a.x+.05,a.y+a.height*.55);await page.mouse.down()
    await page.mouse.move(b.x+b.width-.05,b.y+b.height*.55,{steps:15});await page.mouse.up()
  }
  await dragBetween(sourceRuns.first(),5,sourceRuns.last(),5)
  await page.locator('.source-editor [role="alert"]').waitFor()
  assert.equal(await page.getByLabel('Ersatztext',{exact:true}).inputValue(),lines[0],'cross-paragraph selection does not silently combine text')
  await dragBetween(sourceRuns.first(),5,sourceRuns.nth(1),5)
  assert.equal(await page.getByLabel('Ersatztext',{exact:true}).inputValue(),lines[0].slice(5)+' '+lines[1].slice(0,5),'native cross-line selection uses proved paragraph offsets')
  const confirm = page.getByRole('checkbox', { name: /Diese .* Zeilen sind ein Fließtextabsatz/ })
  assert.equal(await confirm.count(), 1, 'supported paragraph recognized')
  await page.getByRole('button', { name: 'Ganzen Absatz auswählen' }).click()
  await confirm.check()
  await generate('This paragraph contains short words.')
  assert.equal(await page.getByRole('button', { name: 'Korrektur übernehmen', exact: true }).isDisabled(), true, 'actual PDF must be reviewed first')
  await page.getByRole('button', { name: 'Original anzeigen', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Korrektur übernehmen', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: 'Neue PDF anzeigen', exact: true }).click()
  await page.getByText('PDF-Vorschau bereit. Absatz und Übergang zum Folgeabsatz prüfen.', { exact: true }).waitFor()
  await page.getByRole('checkbox', { name: /Absatz, Abstände und Übergang/ }).check()
  await page.screenshot({ path: artifacts + '/desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no mobile page overflow')
  await page.getByRole('button', { name: 'Vorschau vergrößern' }).click()
  await page.locator('.source-pdf-preview canvas[data-render-state="ready"]').waitFor()
  await page.getByRole('checkbox', { name: /Absatz, Abstände und Übergang/ }).check()
  await page.screenshot({ path: artifacts + '/mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Korrektur übernehmen', exact: true }).click()
  await page.locator('.page canvas[data-render-state="ready"]').first().waitFor()
  let items = await downloadText()
  assert.equal(items.map(item => item.str).join(' '), 'This paragraph contains short words. Following paragraph stays here.')
  assert.equal(items.at(-1).transform[5], 540, 'following paragraph stays in position')
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
  await page.locator('.page canvas[data-render-state="ready"]').first().waitFor()
  items = await downloadText(); assert.equal(items.map(item => item.str).join(' '), originalText + ' Following paragraph stays here.')
  await page.getByRole('button', { name: 'Wiederholen', exact: true }).click()
  await page.locator('.page canvas[data-render-state="ready"]').first().waitFor()
  await page.getByRole('button', { name: 'Speichern', exact: true }).click()
  await page.getByText('✓ Entwurf gespeichert · Nur auf diesem Gerät.', { exact: true }).waitFor()
  await openPanel(); await generate('This paragraph has short words.')
  await page.getByLabel('Ersatztext', { exact: true }).fill('Another change')
  assert.equal(await page.getByRole('button', { name: 'Korrektur übernehmen', exact: true }).isDisabled(), true, 'changing input invalidates candidate/review')
  await page.getByLabel('Ersatztext', { exact: true }).fill('W'.repeat(1000))
  await page.getByRole('button', { name: 'PDF-Vorschau erzeugen', exact: true }).click()
  await page.locator('.source-editor [role="alert"]').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Korrektur übernehmen', exact: true }).isDisabled(), true, 'rejection does not allow apply')
  await page.screenshot({ path: artifacts + '/rejected.png', fullPage: true })
  await load('another-document.pdf')
  assert.equal(await page.locator('.source-correction').count(), 0, 'document switch cancels panel/request')
  await page.getByRole('button', { name: 'Entwürfe', exact: true }).click()
  await page.locator('.draft-open').filter({ hasText: 'source-text.pdf' }).click()
  await page.locator('.page canvas[data-render-state="ready"]').first().waitFor()
  items = await downloadText(); assert.equal(items.map(item => item.str).join(' '), 'This paragraph contains short words. Following paragraph stays here.', 'saved source revision reopens correctly')
  const embedded = await PDFDocument.create(); embedded.registerFontkit(fontkit)
  const embeddedFont = await embedded.embedFont(readFileSync('node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff'), { subset: true })
  embedded.addPage().drawText('Grüße München Hallo Welt äöüÄÖÜß', { font: embeddedFont, size: 12, x: 50, y: 700 })
  await load('embedded.pdf', Buffer.from(await embedded.save())); await openPanel()
  await generate('Hallo München Grüße Welt äöüÄÖÜß')
  await page.getByRole('checkbox', { name: /Absatz, Abstände und Übergang/ }).check()
  await page.getByRole('button', { name: 'Korrektur übernehmen', exact: true }).click()
  await page.locator('.page canvas[data-render-state="ready"]').first().waitFor()
  items = await downloadText(); assert.equal(items.map(item => item.str).join(''), 'Hallo München Grüße Welt äöüÄÖÜß', 'real embedded subset works through worker and UI')

  assert.deepEqual(errors, [])
  console.log('PASS source text: real worker/candidate/review/reflow/export/undo/redo/save/stale/rejection/switch/desktop/mobile')
} catch (error) { console.error('Browser errors:', errors); console.error((await page.locator('body').innerText()).slice(-2500)); await page.screenshot({ path: artifacts + '/failure.png', fullPage: true }); throw error } finally { await browser.close() }
