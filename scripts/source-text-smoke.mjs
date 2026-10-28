import { chromium } from 'playwright'
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { applyButton, caret, checkInPdf, fit, inlineInput, openInline, setInlineText } from './source-inline-helper.mjs'
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
  await page.locator('.source-block-outline').first().waitFor()
}
async function edit(text) {
  await openInline(page)
  await setInlineText(page, text)
  assert.match(await fit(page), /^Passt/)
  await checkInPdf(page)
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
  assert.equal(await page.locator('.source-block-outline').count(), 2, 'paragraph and following paragraph are blocks')
  // A drag across two paragraphs is refused; a drag inside one opens the inline editor with that range.
  const sourceRuns = page.locator('.source-run-hit')
  async function dragBetween(first, from, last, to) {
    const a = await first.locator('span').nth(from).boundingBox(), b = await last.locator('span').nth(to - 1).boundingBox()
    await page.mouse.move(a.x + .05, a.y + a.height * .55); await page.mouse.down()
    await page.mouse.move(b.x + b.width - .05, b.y + b.height * .55, { steps: 15 }); await page.mouse.up()
  }
  await dragBetween(sourceRuns.first(), 5, sourceRuns.last(), 5)
  await page.locator('.source-editor [role="alert"]').waitFor()
  assert.equal(await page.locator('.source-inline').count(), 0, 'cross-paragraph selection does not silently combine text')
  await dragBetween(sourceRuns.first(), 5, sourceRuns.nth(1), 5)
  await page.locator('.source-inline').waitFor()
  assert.equal(await inlineInput(page).inputValue(), originalText, 'the whole paragraph is edited in place')
  assert.deepEqual(await caret(page), [5, lines[0].length + 1 + 5], 'native cross-line selection becomes the inline selection')
  assert.ok(await page.locator('.source-inline-selection').count() >= 2, 'selection is drawn on both lines')
  assert.ok((await fit(page)).startsWith(`Unverändert · ${lines.length} Zeilen`))
  assert.equal(await page.getByRole('checkbox').count(), 0, 'no reflow or review checkboxes')
  // Caret keys follow the visual lines.
  await inlineInput(page).focus()
  await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('ArrowDown')
  const [down] = await caret(page)
  assert.ok(down > lines[0].length && down <= lines[0].length + 1 + lines[1].length, 'ArrowDown moves to line 2: ' + down)
  await page.keyboard.press('Home'); assert.deepEqual(await caret(page), [lines[0].length + 1, lines[0].length + 1])
  await page.keyboard.press('End'); assert.deepEqual(await caret(page), [lines[0].length + 1 + lines[1].length, lines[0].length + 1 + lines[1].length])
  await page.keyboard.press('Shift+ArrowUp'); const [s0, s1] = await caret(page)
  assert.ok(s0 < s1 && s1 === lines[0].length + 1 + lines[1].length, 'Shift+ArrowUp extends the selection')
  // Typing updates the page and the fit display at once.
  await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type(' More')
  assert.equal(await inlineInput(page).inputValue(), originalText + ' More')
  assert.ok((await fit(page)).startsWith(`Passt · ${lines.length} Zeilen`))
  await page.keyboard.press('Enter')
  assert.equal(await inlineInput(page).inputValue(), originalText + ' More', 'Enter inserts no hard break')
  await setInlineText(page, 'This paragraph contains short words.')
  assert.ok((await fit(page)).startsWith(`Passt · ${lines.length} → 1 Zeilen · darunter bleibt freier Platz`))
  await page.screenshot({ path: artifacts + '/inline.png', fullPage: true })
  await checkInPdf(page)
  await page.getByRole('button', { name: 'Original anzeigen', exact: true }).click()
  assert.equal(await applyButton(page).isDisabled(), true, 'apply only while the checked result is shown')
  await page.getByRole('button', { name: 'Ergebnis anzeigen', exact: true }).click()
  await page.getByText('Ergebnis in der echten PDF bereit. Absatz und Übergang zum Folgeinhalt ansehen.', { exact: true }).waitFor()
  await page.screenshot({ path: artifacts + '/desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no mobile page overflow')
  await page.getByRole('button', { name: 'Vorschau vergrößern' }).click()
  await page.locator('.source-pdf-preview canvas[data-render-state="ready"]').waitFor()
  await page.screenshot({ path: artifacts + '/mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByText('Ergebnis in der echten PDF bereit. Absatz und Übergang zum Folgeinhalt ansehen.', { exact: true }).waitFor()
  await applyButton(page).click()
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
  await openPanel(); await edit('This paragraph has short words.')
  await page.getByRole('button', { name: 'Weiter bearbeiten', exact: true }).click()
  assert.equal(await applyButton(page).count(), 0, 'editing again discards the checked result')
  assert.equal(await inlineInput(page).inputValue(), 'This paragraph has short words.', 'text is kept for further editing')
  await setInlineText(page, 'W'.repeat(1000))
  assert.match(await fit(page), /^Passt nicht · Der Absatz würde die Seiten- oder Zuschnittgrenze überschreiten/)
  await page.getByRole('button', { name: 'In PDF prüfen', exact: true }).click()
  await page.locator('.source-editor [role="alert"]').waitFor()
  assert.equal(await applyButton(page).count(), 0, 'a rejected check offers no apply')
  await page.screenshot({ path: artifacts + '/rejected.png', fullPage: true })
  page.once('dialog', dialog => dialog.accept())
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
  await openInline(page)
  assert.ok(await page.locator('.source-inline-svg path').count() > 10, 'embedded subset glyphs are drawn from their outlines')
  await setInlineText(page, 'Hallo München Grüße Welt äöüÄÖÜß')
  await checkInPdf(page)
  await applyButton(page).click()
  await page.locator('.page canvas[data-render-state="ready"]').first().waitFor()
  items = await downloadText(); assert.equal(items.map(item => item.str).join(''), 'Hallo München Grüße Welt äöüÄÖÜß', 'real embedded subset works through worker and UI')

  assert.deepEqual(errors, [])
  console.log('PASS source text: inline editor (click/drag/caret keys/fit), real worker check, apply/export/undo/redo/save/rejection/switch/desktop/mobile, embedded subset')
} catch (error) { console.error('Browser errors:', errors); console.error((await page.locator('body').innerText()).slice(-2500)); await page.screenshot({ path: artifacts + '/failure.png', fullPage: true }); throw error } finally { await browser.close() }
