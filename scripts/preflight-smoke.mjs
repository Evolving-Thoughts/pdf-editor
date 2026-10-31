// T17: the export dialog reports risks, locks export until they are confirmed,
// and leaves document and draft untouched when cancelled.
import { clickExport, collectErrors, launchBrowser, pageReady, pdfInput } from './browser-helper.mjs'
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const key = PDFName.of
async function plain() {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([400, 500]).drawText('Inhalt', { x: 50, y: 420, size: 14, font })
  return doc
}
async function signed() {
  const doc = await plain()
  const signature = doc.context.register(doc.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', Contents: PDFHexString.of('00') }))
  const field = doc.context.register(doc.context.obj({ FT: 'Sig', T: PDFString.of('Unterschrift'), V: signature }))
  doc.catalog.set(key('AcroForm'), doc.context.obj({ Fields: [field], SigFlags: 3 }))
  return doc.save()
}

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
const errors = []
collectErrors(page, errors)
await page.goto(process.env.SMOKE_URL ?? 'http://localhost:5199')

let opened = 0
const open = async bytes => {
  const name = `check-${++opened}.pdf`
  await pdfInput(page).setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) })
  await page.waitForFunction(value => document.querySelector('.file-info')?.textContent.includes(value), name)
  await pageReady(page)
}
const dialog = () => page.getByRole('dialog', { name: 'PDF exportieren', exact: true })
const exportButton = () => dialog().locator('.export-primary')
const openExport = async () => {
  await clickExport(page)
  await dialog().locator('.export-check .export-detail').first().waitFor()
}

// A plain document exports without extra questions.
await open(await (await plain()).save())
await openExport()
assert.match(await dialog().locator('.export-check').textContent(), /Keine Risiken gefunden/)
assert.match(await dialog().locator('.export-check').textContent(), /keine Sicherheits- oder Konformitätsbestätigung/)
assert.equal(await exportButton().isEnabled(), true)
await dialog().getByRole('button', { name: 'Abbrechen', exact: true }).click()

// A signature is named on opening and has to be confirmed before exporting.
await open(await signed())
await page.waitForSelector('text=Dieses PDF ist digital signiert')
await openExport()
assert.equal(await exportButton().isEnabled(), false, 'unconfirmed risk locks the export')
await dialog().getByRole('checkbox', { name: /Signatur wird dadurch ungültig/ }).check()
assert.equal(await exportButton().isEnabled(), true)
await dialog().getByRole('button', { name: 'Abbrechen', exact: true }).click()

// An unsupported character is shown with text and font; nothing is replaced unasked.
await open(await (await plain()).save())
await page.getByRole('button', { name: 'T Text', exact: true }).click()
await page.locator('.page').click({ position: { x: 100, y: 200 } })
await page.keyboard.type('Widerstand 5 Ω gemessen')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await openExport()
const issues = await dialog().locator('.export-text-issues').textContent()
assert.match(issues, /Seite 1/)
assert.match(issues, /„Ω“ fehlt in Helvetica/)
assert.match(issues, /iderstand 5 Ω gemessen/)
assert.equal(await exportButton().isEnabled(), false)

// Jump to the text, correct it, and the problem is gone: check and export share one state.
await dialog().getByRole('button', { name: 'Zur Stelle', exact: true }).click()
await page.waitForSelector('.textbox textarea')
assert.equal(await dialog().count(), 0)
await page.locator('.textbox .drag-surface').dblclick({ force: true })
await page.keyboard.press('Control+a')
await page.keyboard.type('Widerstand 5 Ohm gemessen')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await openExport()
assert.equal(await dialog().locator('.export-text-issues').count(), 0)
await dialog().getByRole('button', { name: 'Abbrechen', exact: true }).click()

// Back to the character: an explicit decision exports the visible replacement.
await page.locator('.textbox .drag-surface').dblclick({ force: true })
await page.keyboard.press('Control+a')
await page.keyboard.type('Widerstand 5 Ω gemessen')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await openExport()
await dialog().getByRole('checkbox', { name: /durch „\?“ ersetzen/ }).check()
const [download] = await Promise.all([page.waitForEvent('download'), exportButton().click()])
const task = getDocument({ data: new Uint8Array(readFileSync(await download.path())) })
const pdf = await task.promise
const text = (await (await pdf.getPage(1)).getTextContent()).items.map(item => item.str).join(' ')
assert.match(text, /Widerstand 5 \? gemessen/)
await task.destroy()

// Cancelling never touched the editor: the box still holds the original character.
assert.equal(await page.locator('.textbox textarea').inputValue(), 'Widerstand 5 Ω gemessen')

// A check that cannot finish hands the decision over. It must not block the export for good.
// A new editing state first, so that no earlier check counts for this one.
await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
await page.evaluate(() => {
  window.Worker = class extends window.Worker {
    postMessage(job, ...options) {
      if (job?.kind === 'preflight') this.onerror?.(new ErrorEvent('error'))
      else super.postMessage(job, ...options)
    }
  }
})
await clickExport(page)
await dialog().getByRole('checkbox', { name: /Prüfung konnte nicht abgeschlossen/ }).check()
const [fallback] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), exportButton().click()])
assert.ok(readFileSync(await fallback.path()).length > 0)
assert.deepEqual(errors, [])
console.log('PASS preflight: Signatur, Zeichen, Sprung zur Stelle, Bestätigung, Abbruch')
await browser.close()
