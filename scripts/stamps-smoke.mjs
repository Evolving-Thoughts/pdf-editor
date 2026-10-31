// T23: stamps through the picker, as editable image overlays, with date stability.
import { clickExport, collectErrors, launchBrowser, pageReady, pdfInput } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

async function source() {
  const doc = await PDFDocument.create()
  doc.addPage([400, 600])
  doc.addPage([700, 300])
  return doc.save()
}

const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
const errors = []
collectErrors(page, errors)
await page.goto(process.env.SMOKE_URL ?? 'http://localhost:5199')
await pdfInput(page).setInputFiles({ name: 'stempel.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source()) })
await pageReady(page)

const openPicker = () => page.getByRole('button', { name: 'Stempel auswählen', exact: true }).click()
const pick = async name => {
  await openPicker()
  await page.getByRole('button', { name, exact: true }).click()
}
const pageAt = index => page.locator(`.page[data-page-index="${index}"]`)
const overlays = () => page.locator('.image-overlay')
const pictures = () => page.evaluate(() => [...document.querySelectorAll('.image-overlay img')].map(img => img.src))

await openPicker()
assert.match(await page.locator('.stamp-popover').textContent(), /keine digitale Signatur/)
await page.keyboard.press('Escape')

// Choosing arms the tool; each click places another stamp.
await pick('Stempel ERLEDIGT')
assert.equal(await page.getByRole('button', { name: 'Stempel auswählen', exact: true }).getAttribute('aria-pressed'), 'true')
await pageAt(0).click({ position: { x: 150, y: 200 } })
await pageAt(0).click({ position: { x: 200, y: 400 } })
await pageAt(1).click({ position: { x: 300, y: 150 } })
assert.equal(await overlays().count(), 3)
await page.keyboard.press('Escape')

// Undo takes back one placement.
await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
assert.equal(await overlays().count(), 2)
await page.getByRole('button', { name: 'Wiederholen', exact: true }).click()
assert.equal(await overlays().count(), 3)

// A placed stamp behaves like an image: it moves and can be deleted.
const first = overlays().first()
await first.click()
const before = await first.boundingBox()
await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
await page.mouse.down()
await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 + 30, { steps: 4 })
await page.mouse.up()
const after = await first.boundingBox()
assert.ok(Math.abs(after.x - before.x - 40) < 3, 'stamp moved')
await page.keyboard.press('Delete')
assert.equal(await overlays().count(), 2)
await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
assert.equal(await overlays().count(), 3)

// The chosen date is drawn into the picture, so it is the same after a reload.
await openPicker()
await page.getByLabel('Datum für Datumsstempel').fill('2024-02-29')
await page.getByRole('button', { name: 'Stempel ERLEDIGT AM', exact: true }).click()
await pageAt(0).click({ position: { x: 200, y: 300 } })
await page.keyboard.press('Escape')
assert.equal(await overlays().count(), 4)
const withDate = await pictures()
const dated = withDate.at(-1)

// Own stamps stay available after a reload.
await openPicker()
await page.getByRole('button', { name: 'Eigener Stempel …', exact: true }).click()
await page.locator('.stamp-form input[type="text"]').fill('Bezahlt')
await page.locator('.stamp-form').getByRole('button', { name: 'Speichern', exact: true }).click()
await page.getByRole('button', { name: 'Stempel Bezahlt', exact: true }).waitFor()
await page.keyboard.press('Escape')

await page.getByRole('button', { name: 'Speichern', exact: true }).click()
await page.waitForFunction(() => document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'))
await page.reload()
await page.locator('button:has-text("Entwürfe")').first().click()
await page.getByRole('button', { name: /stempel\.pdf/ }).first().click()
await page.waitForFunction(() => document.querySelectorAll('.image-overlay').length === 4)
assert.deepEqual((await pictures()).sort(), [...withDate].sort(), 'draft restores the exact pictures')
assert.ok((await pictures()).includes(dated), 'the date stamp did not change')
await openPicker()
await page.getByRole('button', { name: 'Stempel Bezahlt', exact: true }).waitFor()
await page.getByRole('button', { name: 'Stempel Bezahlt löschen', exact: true }).click()
assert.equal(await page.getByRole('button', { name: 'Stempel Bezahlt', exact: true }).count(), 0)
await page.keyboard.press('Escape')

// The export contains the pictures.
const [download] = await Promise.all([page.waitForEvent('download'), (async () => {
  await clickExport(page)
  await confirmDefaultExport(page)
})()])
const output = await PDFDocument.load(new Uint8Array(readFileSync(await download.path())))
const images = output.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image')
assert.ok(images.length >= 2, 'stamp pictures are in the file')
assert.deepEqual(errors, [])
console.log('PASS stamps: Mehrfach platzieren, Undo, Verschieben, Datum, eigene Stempel, Entwurf, Export')
await browser.close()
