// T24: document info through the real menu, undo, draft restore and an
// independently read export.
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import { chromium } from 'playwright'
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>Mira Muster</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`

async function source() {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage([400, 500])
  doc.addPage([400, 500])
  doc.setTitle('Größenbericht')
  doc.setAuthor('Mira Muster')
  doc.setProducer('Druckwerk 3')
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(PDFRawStream.of(doc.context.obj({ Type: 'Metadata', Subtype: 'XML' }), new TextEncoder().encode(XMP))))
  return doc.save({ useObjectStreams: false })
}
const read = async bytes => {
  const task = getDocument({ data: bytes.slice() })
  const { info, metadata } = await (await task.promise).getMetadata()
  await task.destroy()
  return { info, xmp: metadata?.getRaw() ?? '', raw: new TextDecoder('latin1').decode(bytes) }
}

const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
await page.goto(process.env.SMOKE_URL ?? 'http://localhost:5199')
await page.locator('input[accept="application/pdf"]').setInputFiles({ name: 'info.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source()) })
await page.waitForSelector('.page canvas[data-render-state="ready"]')

const info = () => page.getByRole('dialog', { name: 'Dokumentinfo', exact: true })
const openInfo = async () => {
  await page.getByRole('button', { name: 'Dokument', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Dokumentinfo …' }).click()
  await info().getByLabel('Titel').waitFor()
}
const exported = async () => {
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click()
  const [download] = await Promise.all([page.waitForEvent('download'), confirmDefaultExport(page)])
  return new Uint8Array(readFileSync(await download.path()))
}

// Reading: values from the file, empty fields as empty, technical data apart.
await openInfo()
assert.equal(await info().getByLabel('Titel').inputValue(), 'Größenbericht')
assert.equal(await info().getByLabel('Betreff').inputValue(), '')
assert.match(await info().textContent(), /Druckwerk 3/)
assert.match(await info().textContent(), /keine vollständige Anonymisierung/)

// Cancelling changes nothing.
await info().getByLabel('Titel').fill('Verworfen')
await info().getByRole('button', { name: 'Abbrechen', exact: true }).click()
await openInfo()
assert.equal(await info().getByLabel('Titel').inputValue(), 'Größenbericht')

// Editing is one undo step.
await info().getByLabel('Titel').fill('Neuer Titel äöü')
await info().getByRole('button', { name: 'Übernehmen', exact: true }).click()
await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
await openInfo()
assert.equal(await info().getByLabel('Titel').inputValue(), 'Größenbericht')
await info().getByRole('button', { name: 'Abbrechen', exact: true }).click()
await page.getByRole('button', { name: 'Wiederholen', exact: true }).click()

// The decision survives a reload through the draft.
await page.getByRole('button', { name: 'Speichern', exact: true }).click()
await page.waitForFunction(() => document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'))
await page.reload()
await page.locator('.drafts-menu button, button:has-text("Entwürfe")').first().click()
await page.getByRole('button', { name: /info\.pdf/ }).first().click()
await page.waitForSelector('.page canvas[data-render-state="ready"]')
await openInfo()
assert.equal(await info().getByLabel('Titel').inputValue(), 'Neuer Titel äöü')
await info().getByRole('button', { name: 'Abbrechen', exact: true }).click()

const edited = await read(await exported())
assert.equal(edited.info.Title, 'Neuer Titel äöü')
assert.equal(edited.info.Author, 'Mira Muster', 'other fields stay')
assert.match(edited.xmp, /Neuer Titel/)
assert.equal(edited.info.Producer, 'Druckwerk 3', 'the export adds no software name of its own')

// Removing everything asks first, then leaves nothing to find in the output.
await openInfo()
await info().getByRole('button', { name: 'Alle entfernen', exact: true }).click()
await info().getByRole('button', { name: 'Jetzt alle entfernen', exact: true }).click()
const cleaned = await read(await exported())
for (const text of ['Mira Muster', 'Druckwerk', 'pdf-lib', 'Größenbericht', 'Neuer Titel']) assert.equal(`${cleaned.raw}${cleaned.xmp}`.includes(text), false, text)
assert.equal(cleaned.info.Title, undefined)

// Undo brings the decision back; the source draft never changed.
await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
await openInfo()
assert.equal(await info().getByLabel('Titel').inputValue(), 'Neuer Titel äöü')
assert.deepEqual(errors, [])
console.log('PASS metadata: Lesen, Ändern, Undo, Entwurf, Entfernen, unabhängiges Auslesen')
await browser.close()
