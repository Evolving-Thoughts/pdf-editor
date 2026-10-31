// T18: "Struktur optimieren" in the real dialog: savings, the unchanged case, and
// that protection and the plain export still work next to it.
import { chromiumPath } from './browser-helper.mjs'
import { chromium } from 'playwright'
import { PDFDocument, PDFRawStream, StandardFonts } from 'pdf-lib'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

async function wasteful() {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 500])
  page.drawText('Bleibt lesbar', { x: 50, y: 420, size: 14, font })
  const stream = doc.context.register(PDFRawStream.of(doc.context.obj({}), new TextEncoder().encode('q Q\n'.repeat(60000))))
  page.node.addContentStream(stream)
  return doc.save({ useObjectStreams: false })
}
async function tight() {
  const doc = await PDFDocument.create()
  doc.addPage([400, 500])
  return doc.save()
}
const textOf = async bytes => {
  const task = getDocument({ data: bytes })
  const pdf = await task.promise
  const text = (await (await pdf.getPage(1)).getTextContent()).items.map(item => item.str).join(' ')
  await task.destroy()
  return text
}

const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
await page.goto(process.env.SMOKE_URL ?? 'http://localhost:5199')

let opened = 0
const open = async bytes => {
  const name = `structure-${++opened}.pdf`
  await page.locator('input[accept="application/pdf"]').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) })
  await page.waitForFunction(value => document.querySelector('.file-info')?.textContent.includes(value), name)
  await page.waitForSelector('.page canvas[data-render-state="ready"]')
}
const startExport = async () => {
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click()
  await page.getByRole('radio', { name: /Struktur optimieren/ }).check()
  await page.getByRole('button', { name: 'Export vorbereiten', exact: true }).click()
  await page.getByRole('dialog', { name: 'Export vorbereitet' }).waitFor({ timeout: 60000 })
}
const save = async name => {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name, exact: true }).click()])
  return new Uint8Array(readFileSync(await download.path()))
}

await open(await wasteful())
await page.getByRole('button', { name: 'Exportieren', exact: true }).click()
assert.equal(await page.getByRole('radio', { name: /Nicht optimieren/ }).isChecked(), true, 'optimizing stays opt-in')
assert.match(await page.locator('.export-size').textContent(), /Keine Einsparung garantiert/)
await page.getByRole('radio', { name: /Struktur optimieren/ }).check()
assert.equal(await page.locator('#export-quality').count(), 0, 'lossless mode shows no quality choice')
await page.getByRole('button', { name: 'Abbrechen', exact: true }).click()

await startExport()
assert.match(await page.locator('.export-dialog').innerText(), /% kleiner · Verlustfrei/)
const smaller = await save('Kleinere Datei speichern')
assert.match(await textOf(smaller), /Bleibt lesbar/)

// The passphrase step still sits behind the optimized output.
await startExport()
await page.getByRole('button', { name: 'Einstellungen', exact: true }).click()
await page.getByRole('checkbox', { name: /Mit Passwort schützen/ }).check()
await page.getByLabel('Export-Passwort').fill('geheim')
await page.getByLabel('Passwort wiederholen').fill('geheim')
await page.getByRole('radio', { name: /Struktur optimieren/ }).check()
await page.getByRole('button', { name: 'Export vorbereiten', exact: true }).click()
await page.getByRole('dialog', { name: 'Export vorbereitet' }).waitFor({ timeout: 60000 })
const protectedOutput = await save('Kleinere Datei speichern')
await assert.rejects(textOf(protectedOutput), /[Pp]assword/)

// Nothing to gain: the dialog says so and hands over the unchanged output.
await open(await tight())
await startExport()
assert.match(await page.locator('.export-dialog').innerText(), /Keine Ersparnis/)
await save('Datei speichern')

assert.deepEqual(errors, [])
console.log('PASS structure optimization: Einsparung, Passwort, keine Ersparnis')
await browser.close()
