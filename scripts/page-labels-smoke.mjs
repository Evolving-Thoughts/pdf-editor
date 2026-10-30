// T22: page labels through the dialog, on mixed pages, with undo, draft and export.
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

async function source() {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([400, 600]).drawText('Hochformat', { x: 50, y: 500, size: 12, font })
  doc.addPage([600, 400]).drawText('Querformat', { x: 50, y: 300, size: 12, font })
  const turned = doc.addPage([400, 600])
  turned.setRotation(degrees(90))
  // Sits exactly where a centered footer goes on the last page.
  doc.addPage([400, 600]).drawText('Bestehende Fußzeile', { x: 130, y: 30, size: 12, font })
  return doc.save()
}
const labels = async bytes => {
  const task = getDocument({ data: bytes.slice() })
  const pdf = await task.promise, found = []
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 })
    for (const item of (await page.getTextContent()).items) {
      if (!/^Seite /.test(item.str)) continue
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5])
      found.push({ page: number, text: item.str, center: Math.round(x + item.width / 2), width: viewport.width, fromBottom: Math.round(viewport.height - y) })
    }
  }
  await task.destroy()
  return found
}

const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
await page.goto(process.env.SMOKE_URL ?? 'http://localhost:5199')
await page.locator('input[accept="application/pdf"]').setInputFiles({ name: 'labels.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source()) })
await page.waitForSelector('.page canvas[data-render-state="ready"]')

const dialog = () => page.getByRole('dialog', { name: 'Seitenzahlen, Kopf- und Fußzeile', exact: true })
const openDialog = async () => {
  await page.getByRole('button', { name: 'Dokument', exact: true }).click()
  await page.getByRole('menuitem', { name: /Seitenzahlen/ }).click()
  await dialog().getByTestId('label-preview').waitFor()
}
const apply = name => dialog().getByRole('button', { name, exact: true })

// The preview shows the label on the real format of each page.
await openDialog()
assert.equal(await dialog().getByTestId('label-preview').textContent(), 'Seite 1 von 4')
assert.match(await dialog().locator('.page-labels-pager').textContent(), /Seite 1 · 400 × 600 pt/)
await dialog().getByRole('button', { name: 'Nächste Seite', exact: true }).click()
assert.match(await dialog().locator('.page-labels-pager').textContent(), /Seite 2 · 600 × 400 pt/)
await dialog().getByRole('button', { name: 'Nächste Seite', exact: true }).click()
assert.match(await dialog().locator('.page-labels-pager').textContent(), /Seite 3 · 600 × 400 pt/, 'rotated page shows its displayed size')

// A bad range explains itself and blocks applying.
await dialog().getByLabel('Seiten').fill('2-99')
assert.match(await dialog().getByRole('alert').textContent(), /außerhalb von 1 bis 4/)
assert.equal(await dialog().locator('.export-primary').isDisabled(), true)

// Existing text is never covered silently.
await dialog().getByLabel('Seiten').fill('')
await dialog().getByRole('checkbox', { name: /Überdeckt vorhandene Inhalte auf Seite 4/ }).waitFor()
assert.equal(await dialog().locator('.export-primary').isDisabled(), true)
await dialog().getByRole('checkbox', { name: /Überdeckt/ }).check()
await apply('Auf 4 Seiten anwenden').click()
await page.waitForFunction(() => document.querySelectorAll('.textbox').length >= 2)

// Undo removes all four at once, redo restores them.
await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
await page.waitForFunction(() => !document.querySelector('.textbox'))
await page.getByRole('button', { name: 'Wiederholen', exact: true }).click()
await page.waitForSelector('.textbox')

// Applying the same position again replaces instead of stacking.
await openDialog()
await dialog().getByLabel('Text').fill('Seite {n}')
await dialog().getByLabel('Seiten').fill('2-3')
await dialog().getByLabel('Erste Nummer').fill('7')
await apply('Auf 2 Seiten anwenden').click()
await page.waitForFunction(() => !document.querySelector('dialog[open]'))

const [download] = await Promise.all([page.waitForEvent('download'), (async () => {
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click()
  await confirmDefaultExport(page)
})()])
const found = await labels(new Uint8Array(readFileSync(await download.path())))
assert.deepEqual(found.map(item => [item.page, item.text]), [[2, 'Seite 7'], [3, 'Seite 8']])
for (const item of found) {
  assert.ok(Math.abs(item.center - item.width / 2) <= 2, `centered on page ${item.page}`)
  assert.equal(item.fromBottom, 28)
}
assert.deepEqual(errors, [])
console.log('PASS page labels: Vorschau, Bereiche, Überdeckung, Undo, Ersetzen, Export')
await browser.close()
