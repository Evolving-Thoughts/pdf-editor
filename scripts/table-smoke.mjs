// T26: from a PDF table to reviewed XLSX and ODS files. The saved files stay in
// SMOKE_ARTIFACT_DIR for scripts/verify-table-export.py.
import { chromiumPath } from './browser-helper.mjs'
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import assert from 'node:assert/strict'

const out = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-table-'))
mkdirSync(out, { recursive: true })

const ROWS = [
  ['Artikel', 'Menge', 'Preis', 'Nummer'],
  ['Papier', '12,5', '1.234,50', '0042'],
  ['Toner', '3', '89,90', '4012345678901234'],
  ['Unklar', '1.234', '=SUM(A1)', '7'],
]
async function source() {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  page.drawText('Rechnung mit Tabelle', { x: 60, y: 780, size: 16, font })
  ROWS.forEach((row, rowIndex) => row.forEach((text, column) => page.drawText(text, { x: 70 + column * 110, y: 700 - rowIndex * 24, size: 11, font })))
  doc.addPage([595, 842])
  return doc.save()
}

const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
await page.goto(process.env.SMOKE_URL ?? 'http://localhost:5199')
const original = await source()
await page.locator('input[accept="application/pdf"]').setInputFiles({ name: 'rechnung.pdf', mimeType: 'application/pdf', buffer: Buffer.from(original) })
await page.waitForSelector('.page canvas[data-render-state="ready"]')

await page.getByRole('button', { name: 'Dokument', exact: true }).click()
await page.getByRole('menuitem', { name: 'Tabelle exportieren …' }).click()
await page.getByRole('heading', { name: 'Tabelle prüfen' }).waitFor()
const stage = page.locator('.table-stage')
await page.waitForSelector('.table-stage canvas[data-render-state="ready"]')

// A page without text explains what to do.
await page.getByRole('button', { name: 'Nächste Seite', exact: true }).click()
await page.getByText('Diese Seite hat keine Textebene').waitFor()
await page.getByRole('button', { name: 'Vorherige Seite', exact: true }).click()
await page.waitForFunction(() => document.querySelector('.table-source-bar')?.textContent.includes('Seite 1 von 2'))
await page.waitForTimeout(300)

// Draw the table area; columns come from the gaps.
const box = await stage.boundingBox(), factor = box.width / 595
const at = (x, y) => [box.x + x * factor, box.y + (842 - y) * factor]
await page.mouse.move(...at(60, 715))
await page.mouse.down()
await page.mouse.move(...at(540, 620), { steps: 6 })
await page.mouse.up()
await page.getByLabel('Zeile 1, Spalte 1').waitFor()
const cell = (row, column) => page.getByLabel(`Zeile ${row}, Spalte ${column}`, { exact: true })
assert.equal(await page.locator('.table-line').count(), 3, 'three column lines from the gaps')
for (const [rowIndex, row] of ROWS.entries()) for (const [column, text] of row.entries())
  assert.equal(await cell(rowIndex + 1, column + 1).inputValue(), text)

// Doubtful values are marked and stay text.
assert.match(await page.locator('.table-review').textContent(), /markiert/)
for (const [row, column] of [[2, 4], [3, 4], [4, 2], [4, 3]])
  assert.ok(await cell(row, column).evaluate(input => input.closest('td').classList.contains('table-cell-note')), `marked ${row}/${column}`)
assert.ok(await cell(2, 3).evaluate(input => input.closest('td').classList.contains('table-cell-number')))

// Export needs an explicit check, and any change takes it back.
const saveXlsx = page.getByRole('button', { name: 'Als XLSX speichern', exact: true })
const saveOds = page.getByRole('button', { name: 'Als ODS speichern', exact: true })
const confirmed = page.getByRole('checkbox', { name: /geprüft/ })
assert.equal(await saveXlsx.isDisabled(), true)
await confirmed.check()
assert.equal(await saveXlsx.isEnabled(), true)
await cell(3, 1).fill('Toner schwarz')
assert.equal(await confirmed.isChecked(), false, 'a value change revokes the check')
assert.equal(await saveXlsx.isDisabled(), true)
await confirmed.check()
await page.getByLabel('Zahlenformat').selectOption('en')
assert.equal(await confirmed.isChecked(), false, 'a format change revokes the check')
await page.getByLabel('Zahlenformat').selectOption('de')

// A wrong boundary can be corrected. Moving a line rebuilds the table.
await page.getByRole('button', { name: 'Spaltengrenze 3', exact: true }).focus()
await page.keyboard.press('Delete')
assert.equal(await page.locator('.table-line').count(), 2)
assert.equal(await cell(2, 3).inputValue(), '1.234,50 0042')
assert.equal(await cell(2, 4).count(), 0)
await page.mouse.click(...at(370, 680))
assert.equal(await page.locator('.table-line').count(), 3, 'a click adds the line back')
assert.equal(await cell(2, 4).inputValue(), '0042')

await cell(3, 1).fill('Toner schwarz')
await page.locator('.table-grid').getByLabel('Zeile 4 löschen').click()
await cell(1, 1).fill('Artikel ÄÖÜ ß & <Größe>')
await confirmed.check()
const download = async (button, file) => {
  const [event] = await Promise.all([page.waitForEvent('download'), button.click()])
  assert.match(event.suggestedFilename(), /^rechnung-tabelle\./)
  await event.saveAs(join(out, file))
  return new Uint8Array(readFileSync(join(out, file)))
}
const xlsx = await download(saveXlsx, 'tabelle.xlsx')
const ods = await download(saveOds, 'tabelle.ods')
const sheet = strFromU8(unzipSync(xlsx)['xl/worksheets/sheet1.xml'])
assert.match(sheet, /<v>1234\.5<\/v>/)
assert.match(strFromU8(unzipSync(ods)['content.xml']), /office:value="12\.5"/)
writeFileSync(join(out, 'expected.json'), JSON.stringify({
  rows: [
    ['Artikel ÄÖÜ ß & <Größe>', 'Menge', 'Preis', 'Nummer'],
    ['Papier', 12.5, 1234.5, '0042'],
    ['Toner schwarz', 3, 89.9, '4012345678901234'],
  ],
}))

// The document itself is untouched: leaving the panel shows the same editor.
await page.getByRole('button', { name: 'Zur Dokumentbearbeitung', exact: true }).click()
await page.waitForSelector('.pages .page canvas')
assert.equal(await page.locator('.textbox').count(), 0)
assert.deepEqual(errors, [])
console.log(`PASS table: Bereich, Spalten, Markierungen, Prüfpflicht, Korrektur, XLSX, ODS. Dateien: ${out}`)
await browser.close()
