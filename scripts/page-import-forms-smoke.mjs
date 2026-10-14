import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
// Real local files and UI: matching sheet sizes, editable image overlay, native PDF widgets.
import { chromium } from 'playwright'
import { PDFDocument, PDFArray, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { PNG_DATA_URL } from '../tests/imageFixtures.js'
const out = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-page-import-'))
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const p = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
const errors = []
p.on('pageerror', e => errors.push(String(e)))
p.on('dialog', d => void d.accept())
const btn = name => p.getByRole('button', { name, exact: true })
const settled = () => p.waitForFunction(() => !document.querySelector('.page-manager-message')?.textContent.includes('aktualisiert') && document.querySelector('.page-manager-preview canvas')?.width > 0)
async function download(name, path) {
  const pending = p.waitForEvent('download'); await btn(name).click(); if (name === 'Exportieren') await confirmDefaultExport(p); await (await pending).saveAs(join(out, path))
  return PDFDocument.load(readFileSync(join(out, path)))
}
const geometry = () => p.locator('.image-overlay').evaluate(el => ({ left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height, transform: el.style.transform }))
try {
  const doc = await PDFDocument.create(), first = doc.addPage([612, 792])
  doc.addPage([612, 792])
  const field = doc.getForm().createTextField('person.name'); field.setText('Ada Lovelace'); field.addToPage(first, { x: 30, y: 600, width: 180, height: 24 })
  await p.goto(process.env.SMOKE_URL ?? 'http://localhost:5207')
  await p.locator('input[accept="application/pdf"]').setInputFiles({ name: 'letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) })
  await p.waitForFunction(() => document.querySelector('.pages .page canvas')?.width > 0)
  await btn('Seiten verwalten').click(); await settled()
  await btn('＋ Seiten einfügen').click()
  await p.getByLabel('Quelle', { exact: true }).selectOption('text')
  await p.getByLabel('Text', { exact: true }).fill('An inserted note')
  await p.getByLabel('Einfügeposition').selectOption('2')
  await p.locator('.page-insert-dialog').getByRole('button', { name: 'Einfügen', exact: true }).click(); await settled()
  await btn('＋ Seiten einfügen').click()
  await p.getByLabel('Quelle', { exact: true }).selectOption('file')
  await p.locator('.page-insert-dialog input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(PNG_DATA_URL.split(',')[1], 'base64') })
  await p.getByLabel('Einfügeposition').selectOption('3')
  await p.locator('.page-insert-dialog').getByRole('button', { name: 'Einfügen', exact: true }).click(); await settled()
  let exported = await download('Exportieren', 'inserted.pdf')
  assert.deepEqual(exported.getPages().map(page => page.getSize()), Array(4).fill({ width: 612, height: 792 }))
  assert.equal(exported.getForm().getTextField('person.name').getText(), 'Ada Lovelace')
  await btn('Zur Dokumentbearbeitung').click()
  await p.getByRole('button', { name: /Auswahl/ }).click()
  await p.locator('.image-overlay').click()
  await p.waitForFunction(() => document.querySelector('.image-options')?.style.visibility === 'visible')
  assert.equal(await p.locator('.image-handle').count(), 4)
  assert.equal(await p.locator('.image-overlay img').evaluate(el => el.naturalWidth), 120)
  const initial = await geometry()
  const width = p.getByRole('spinbutton', { name: 'Breite in Millimetern', exact: true })
  await width.fill('50.8'); await width.press('Enter')
  const angle = p.getByRole('spinbutton', { name: 'Winkel in Grad', exact: true })
  await angle.fill('30'); await angle.press('Enter')
  await p.locator('.image-overlay').focus(); await p.keyboard.press('Shift+ArrowRight')
  const edited = await geometry(); assert.notDeepEqual(initial, edited)
  assert.equal(parseFloat(edited.width), 144); assert.match(edited.transform, /rotate\(30deg\)/)
  exported = await download('Exportieren', 'edited.pdf')
  const resources = exported.getPage(3).node.Resources().lookup(PDFName.of('XObject'))
  assert.match(resources.toString(), /Image/)
  const contents = exported.getPage(3).node.Contents()
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents]
  const drawing = refs.map(ref => Buffer.from(decodePDFRawStream(exported.context.lookup(ref, PDFRawStream)).decode()).toString()).join('\n')
  assert.match(drawing, /144 0 0 72 0 0 cm/)
  assert.match(drawing, /0\.866025/)
  await btn('Speichern').click()
  await p.waitForFunction(() => document.querySelector('.draft-save-status').textContent.includes('Entwurf gespeichert'))
  await p.reload(); await p.getByRole('button', { name: /Entwürfe/ }).click(); await p.locator('.draft-open').first().click()
  await p.waitForSelector('.image-overlay'); assert.deepEqual(await geometry(), edited)
  await btn('Seiten verwalten').click(); await settled()
  await p.locator('.page-manager-row').first().getByRole('button').first().click(); await settled()
  await btn('1 Seite im Uhrzeigersinn drehen').click(); await settled()
  await btn('Zuschneiden').click(); await p.getByLabel('Links · mm').fill('5'); await btn('Zuschnitt anwenden').click(); await settled()
  const extracted = await download('Extrahieren', 'form-cropped.pdf')
  assert.equal(extracted.getForm().getTextField('person.name').getText(), 'Ada Lovelace')
  extracted.getForm().getTextField('person.name').setText('Grace Hopper')
  const editedForm = await extracted.save()
  const widgets = await p.evaluate(async bytes => {
    const { getDocument, GlobalWorkerOptions } = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
    GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
    const task = getDocument({ data: new Uint8Array(bytes) }); const pdf = await task.promise
    const page = await pdf.getPage(1); const annotations = await page.getAnnotations(); await task.destroy()
    return annotations.map(a => ({ name: a.fieldName, value: a.fieldValue, type: a.subtype }))
  }, Array.from(editedForm))
  assert.deepEqual(widgets, [{ name: 'person.name', value: 'Grace Hopper', type: 'Widget' }])
  assert.deepEqual(errors, [])
  console.log('PASS 612pt reference widths for text/image sheets; image overlay resize/rotate/nudge, PDF matrices and draft reload; live form fields after rotation/crop/extraction, edited value independently parsed by PDF.js.')
} finally { await browser.close() }
