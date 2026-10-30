// T25: real recognition of synthetic German and English scans in the browser.
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const GERMAN = ['Größe und Straße', 'Äpfel, Öl und Übung']
const ENGLISH = ['The quick brown fox', 'jumps over the lazy dog']

const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
const errors = [], requests = []
page.on('pageerror', error => errors.push(String(error)))
page.on('request', request => requests.push(request.url()))
const base = process.env.SMOKE_URL ?? 'http://localhost:5199'
await page.goto(base)

// A scan is a picture of text, drawn here at 200 dpi on a white sheet.
const picture = (lines, { blur = 0 } = {}) => page.evaluate(({ lines, blur }) => {
  const canvas = document.createElement('canvas')
  canvas.width = 1654
  canvas.height = 2339
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#000'
  context.filter = blur ? `blur(${blur}px)` : 'none'
  context.font = '70px Arial, sans-serif'
  lines.forEach((line, index) => context.fillText(line, 160, 320 + index * 130))
  return canvas.toDataURL('image/png')
}, { lines, blur })

async function scanPdf() {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  const add = async (lines, options, rotate = 0) => {
    const image = await doc.embedPng(await picture(lines, options))
    const sheet = doc.addPage([595, 842])
    sheet.drawImage(image, { x: 0, y: 0, width: 595, height: 842 })
    if (rotate) sheet.setRotation(degrees(rotate))
  }
  await add(GERMAN)
  await add(ENGLISH)
  await add(GERMAN, { blur: 1.5 })
  doc.addPage([595, 842]).drawText('Schon durchsuchbar', { x: 50, y: 700, size: 14, font })
  return doc.save()
}

const open = async (bytes, name) => {
  await page.locator('input[accept="application/pdf"]').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) })
  await page.waitForFunction(value => document.querySelector('.file-info')?.textContent.includes(value), name)
  await page.waitForSelector('.page canvas[data-render-state="ready"]')
}
const dialog = () => page.getByRole('dialog', { name: 'Text erkennen', exact: true })
const openDialog = async () => {
  await page.getByRole('button', { name: 'Dokument', exact: true }).click()
  await page.getByRole('menuitem', { name: /Text erkennen/ }).click()
  await dialog().getByRole('button', { name: 'Erkennung starten', exact: true }).waitFor()
}
const run = async (range, language) => {
  await dialog().getByLabel('Seiten').fill(range)
  await dialog().getByLabel('Sprache').selectOption({ label: language })
  await dialog().getByRole('button', { name: 'Erkennung starten', exact: true }).click()
}
const pixels = () => page.evaluate(() => {
  const canvas = document.querySelector('.page[data-page-index="0"] canvas')
  return canvas.toDataURL('image/png')
})

await open(await scanPdf(), 'scan.pdf')

// Opening a document must not touch the engine at all: the button is the only trigger.
await page.waitForTimeout(800)
const engineLoaded = () => requests.some(url => /\/ocr\/(worker|core\/|lang\/)|deps\/tesseract/.test(url))
assert.equal(engineLoaded(), false, 'nothing of OCR loads before the button')
await openDialog()
assert.equal(engineLoaded(), false, 'opening the dialog starts nothing')
assert.equal(await dialog().getByLabel('Seiten').inputValue(), '1')

// Pages that already have text are not scanned.
await run('4', 'Deutsch')
await dialog().getByRole('alert').waitFor({ timeout: 30000 })
assert.match(await dialog().getByRole('alert').textContent(), /bereits durchsuchbar/)

// A damaged model is refused with a clear message.
await page.route('**/ocr/lang/deu.traineddata.gz', route => route.fulfill({ status: 200, body: Buffer.from('kaputt') }))
await run('1', 'Deutsch')
await dialog().getByRole('alert').filter({ hasText: 'beschädigt' }).waitFor({ timeout: 30000 })
await page.unroute('**/ocr/lang/deu.traineddata.gz')

// Cancelling while it runs ends the run; the document stays as it was.
await run('1', 'Deutsch')
await page.getByRole('progressbar', { name: 'Fortschritt der Erkennung' }).waitFor()
await dialog().getByRole('button', { name: 'Abbrechen', exact: true }).click()
await dialog().getByRole('button', { name: 'Erkennung starten', exact: true }).waitFor()

// German: umlauts and ß arrive, the result is shown before anything changes.
const before = await pixels()
await run('1', 'Deutsch')
const german = dialog().getByRole('textbox', { name: 'Erkannter Text von Seite 1' })
await german.waitFor({ timeout: 120000 })
const text = await german.inputValue()
for (const word of ['Größe', 'Straße', 'Äpfel', 'Öl', 'Übung']) assert.ok(text.includes(word), `recognized "${word}" in: ${text}`)
assert.equal(await page.locator('.textLayer span', { hasText: 'Größe' }).count(), 0, 'nothing is applied before the decision')

// Discarding leaves the document unchanged.
await dialog().getByRole('button', { name: 'Verwerfen', exact: true }).click()
assert.equal(await page.locator('.page[data-page-index="0"] .textLayer span').count(), 0)

// Applying makes the page searchable and leaves its picture pixel-identical.
await openDialog()
await run('1', 'Deutsch')
await german.waitFor({ timeout: 120000 })
await dialog().getByRole('button', { name: 'Übernehmen', exact: true }).click()
await page.waitForFunction(() => [...document.querySelectorAll('.page[data-page-index="0"] .textLayer span')].some(span => span.textContent.includes('Größe')), null, { timeout: 30000 })
await page.waitForSelector('.page[data-page-index="0"] canvas[data-render-state="ready"]')
assert.equal(await pixels(), before, 'the visible page is unchanged')
await page.keyboard.press('Control+f')
await page.getByRole('textbox', { name: 'Suchtext', exact: true }).fill('Straße')
await page.waitForSelector('[data-search-active="true"]', { state: 'attached', timeout: 20000 })
await page.getByRole('button', { name: 'Suche schließen' }).click()

// Undo takes the text away again, redo returns it.
await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
await page.waitForFunction(() => document.querySelector('.page[data-page-index="0"] .textLayer .endOfContent') && !document.querySelector('.page[data-page-index="0"] .textLayer span'), null, { timeout: 30000 })
await page.getByRole('button', { name: 'Wiederholen', exact: true }).click()
await page.waitForFunction(() => document.querySelector('.page[data-page-index="0"] .textLayer span'), null, { timeout: 30000 })

// English on a second page, and a poor scan still ends with a reviewable result.
await openDialog()
await run('2-3', 'Englisch')
const english = dialog().getByRole('textbox', { name: 'Erkannter Text von Seite 2' })
await english.waitFor({ timeout: 180000 })
assert.match(await english.inputValue(), /quick brown fox/)
assert.match(await dialog().locator('.ocr-review').textContent(), /Seite 3/)
await dialog().getByRole('checkbox', { name: /Seite 3/ }).uncheck()
await dialog().getByRole('button', { name: 'Übernehmen', exact: true }).click()
await page.waitForFunction(() => !document.querySelector('.ocr-dialog'))

// The drafted text survives a reload.
await page.waitForTimeout(800)
await page.getByRole('button', { name: 'Speichern', exact: true }).click()
await page.waitForFunction(() => document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'))
await page.reload()
await page.locator('button:has-text("Entwürfe")').first().click()
await page.getByRole('button', { name: /scan\.pdf/ }).first().click()
await page.waitForFunction(() => [...document.querySelectorAll('.page[data-page-index="0"] .textLayer span')].some(span => span.textContent.includes('Größe')), null, { timeout: 30000 })

// Independent reading of the export: real text on the scanned pages, none on the skipped one.
const [download] = await Promise.all([page.waitForEvent('download'), (async () => {
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click()
  await confirmDefaultExport(page)
})()])
const task = getDocument({ data: new Uint8Array(readFileSync(await download.path())) })
const pdf = await task.promise
const pageText = async number => (await (await pdf.getPage(number)).getTextContent()).items.map(item => item.str).join(' ')
assert.match(await pageText(1), /Größe/)
assert.match(await pageText(2), /quick/)
assert.equal((await pageText(3)).trim(), '')
await task.destroy()

// A scanned table: recognized text feeds the table workspace, with a warning.
const tableScan = await page.evaluate(() => {
  const canvas = document.createElement('canvas')
  canvas.width = 1654
  canvas.height = 2339
  const context = canvas.getContext('2d')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#000'
  context.font = '60px Arial, sans-serif'
  const rows = [['Artikel', 'Menge', 'Preis'], ['Papier', '12,5', '89,90'], ['Toner', '3', '45,00']]
  rows.forEach((row, rowIndex) => row.forEach((text, column) => context.fillText(text, 180 + column * 460, 400 + rowIndex * 130)))
  return canvas.toDataURL('image/png')
})
const tableDoc = await PDFDocument.create()
const tableImage = await tableDoc.embedPng(tableScan)
tableDoc.addPage([595, 842]).drawImage(tableImage, { x: 0, y: 0, width: 595, height: 842 })
await open(await tableDoc.save(), 'tabellenscan.pdf')
await page.getByRole('button', { name: 'Dokument', exact: true }).click()
await page.getByRole('menuitem', { name: 'Tabelle exportieren …' }).click()
await page.getByText('Diese Seite hat keine Textebene').waitFor()
await page.getByRole('button', { name: 'Zur Dokumentbearbeitung', exact: true }).click()
await openDialog()
await run('1', 'Deutsch')
await dialog().getByRole('textbox', { name: 'Erkannter Text von Seite 1' }).waitFor({ timeout: 120000 })
await dialog().getByRole('button', { name: 'Übernehmen', exact: true }).click()
await page.waitForFunction(() => document.querySelector('.page[data-page-index="0"] .textLayer span'), null, { timeout: 30000 })
await page.getByRole('button', { name: 'Dokument', exact: true }).click()
await page.getByRole('menuitem', { name: 'Tabelle exportieren …' }).click()
await page.getByRole('button', { name: 'Ganze Seite', exact: true }).click()
await page.getByLabel('Zeile 1, Spalte 1').waitFor()
assert.match(await page.locator('.table-review').textContent(), /Texterkennung/)
const scanned = []
for (let row = 1; row <= 3; row++) for (let column = 1; column <= 3; column++) scanned.push(await page.getByLabel(`Zeile ${row}, Spalte ${column}`, { exact: true }).inputValue())
assert.deepEqual(scanned, ['Artikel', 'Menge', 'Preis', 'Papier', '12,5', '89,90', 'Toner', '3', '45,00'])
await page.getByRole('button', { name: 'Zur Dokumentbearbeitung', exact: true }).click()

// Nothing left this machine: every request stayed on the app's own address.
const origin = new URL(base).origin
assert.deepEqual(requests.filter(url => !url.startsWith(origin) && !url.startsWith('blob:') && !url.startsWith('data:')), [])
assert.deepEqual(errors, [])
console.log('PASS ocr: Start nur per Button, Umlaute, Tabellen aus Scans, Prüfung, Verwerfen, pixelgleich, Suche, Undo, Entwurf, Export, keine externen Anfragen')
await browser.close()
