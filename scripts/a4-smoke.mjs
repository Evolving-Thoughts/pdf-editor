// Optional A4 via real UI, real PDF export, native fields, overlays and local drafts.
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { PNG_DATA_URL } from '../tests/imageFixtures.js'
const out = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-a4-'))
mkdirSync(out, { recursive: true })
const W = 210 * 72 / 25.4, H = 297 * 72 / 25.4
const near = (a, b, tolerance = 0.05) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`)
const browser = await chromium.launch({ executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), args: ['--no-sandbox'] })
const p = await browser.newPage({ viewport: { width: 1280, height: 1100 }, acceptDownloads: true })
const errors = []; p.on('pageerror', e => errors.push(String(e)))
const btn = name => p.getByRole('button', { name, exact: true })
const ready = () => p.waitForFunction(() => document.querySelector('.page-manager-preview canvas')?.width > 0 && !document.querySelector('.page-manager-message')?.textContent.includes('verarbeitet') && !document.querySelector('.page-manager-message')?.textContent.includes('aktualisiert'))
const choose = async index => { await p.locator('.page-manager-select').nth(index).click(); await ready() }
const paper = () => p.locator('.page-preview-paper').boundingBox()
async function download(name, file) {
  const pending = p.waitForEvent('download'); await btn(name).click(); await (await pending).saveAs(join(out, file))
  return PDFDocument.load(readFileSync(join(out, file)))
}
async function expectSizes(doc, a4) {
  const sizes = doc.getPages().map(page => page.getSize())
  const expected = a4 ? [[W, H], [H, W], [H, W]] : [[612, 792], [700, 400], [700, 400]]
  assert.equal(sizes.length, expected.length)
  sizes.forEach((size, i) => { near(size.width, expected[i][0]); near(size.height, expected[i][1]) })
}
try {
  const source = await PDFDocument.create(), first = source.addPage([612, 792]), second = source.addPage([700, 400])
  const font = await source.embedFont(StandardFonts.Helvetica)
  first.drawText('Portrait fixture', { x: 30, y: 740, size: 18, font }); second.drawText('Landscape fixture', { x: 30, y: 340, size: 18, font })
  const field = source.getForm().createTextField('person.name'); field.setText('Ada'); field.addToPage(first, { x: 50, y: 650, width: 180, height: 24 })
  await p.goto(process.env.SMOKE_URL ?? 'http://localhost:5207')
  await p.locator('input[accept="application/pdf"]').setInputFiles({ name: 'mixed.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()) })
  await p.waitForFunction(() => document.querySelector('.pages .page canvas')?.width > 0)
  await btn('T Text').click()
  const area = await p.locator('.pages .page').first().boundingBox()
  await p.mouse.click(area.x + 200, area.y + 300); await p.locator('.textbox textarea').fill('Editable A4 text'); await p.locator('.textbox textarea').press('Escape')
  await btn('Seiten verwalten').click(); await ready()
  await btn('＋ Seiten einfügen').click()
  assert.equal(await p.getByLabel('Einfügeposition').inputValue(), '2')
  await p.locator('.page-insert-dialog input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(PNG_DATA_URL.split(',')[1], 'base64') })
  await p.locator('.page-insert-dialog').getByRole('button', { name: 'Einfügen', exact: true }).click(); await ready()
  await expectSizes(await download('Exportieren', 'before.pdf'), false)
  await btn('Alle Seiten auf A4 …').click(); await ready(); await choose(0)
  const portrait = await paper(); await p.screenshot({ path: join(out, 'a4-portrait.png') })
  await choose(1); const landscape = await paper(); near(landscape.width, portrait.height); near(landscape.height, portrait.width)
  assert.match(await p.locator('.page-manager-row').first().innerText(), /216 × 279/)
  await p.screenshot({ path: join(out, 'a4-landscape.png') })
  assert.equal(await btn('Exportieren').isDisabled(), true)
  await btn('Abbrechen').click(); await ready(); await expectSizes(await download('Exportieren', 'cancelled.pdf'), false)
  await btn('Alle Seiten auf A4 …').click(); await ready(); await p.keyboard.press('Escape'); await ready()
  await expectSizes(await download('Exportieren', 'escaped.pdf'), false)
  await btn('Alle Seiten auf A4 …').click(); await ready(); await btn('3 Seiten auf A4 setzen').click(); await ready()
  let exported = await download('Exportieren', 'a4.pdf'); await expectSizes(exported, true)
  assert.equal(exported.getForm().getTextField('person.name').getText(), 'Ada')
  exported.getForm().getTextField('person.name').setText('Grace'); const editedBytes = await exported.save()
  const parsed = await p.evaluate(async bytes => {
    const { getDocument, GlobalWorkerOptions } = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
    GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
    const task = getDocument({ data: new Uint8Array(bytes) }), doc = await task.promise
    const page = await doc.getPage(1), fields = await page.getAnnotations(), text = await page.getTextContent()
    await task.destroy()
    return { annotations: fields.map(a => [a.fieldName, a.fieldValue]), text: text.items.filter(a => a.str === 'Editable A4 text').map(a => a.transform) }
  }, Array.from(editedBytes))
  assert.deepEqual(parsed.annotations, [['person.name', 'Grace']])
  assert.equal(parsed.text.length, 1)
  near(parsed.text[0][4], 200 * W / 612); near(parsed.text[0][5], (792 - 300) * W / 612 + (H - 792 * W / 612) / 2)
  near(parsed.text[0][0], 14 * W / 612)
  await btn('Rückgängig').click(); await ready(); await expectSizes(await download('Exportieren', 'undone.pdf'), false)
  await btn('Wiederholen').click(); await ready(); await expectSizes(await download('Exportieren', 'redone.pdf'), true)
  await btn('Zur Dokumentbearbeitung').click()
  await p.waitForSelector('.pages .image-overlay')
  const image = p.locator('.pages .image-overlay'), width = await image.evaluate(el => parseFloat(el.style.width))
  near(width, 275 * H / 700)
  await p.getByRole('button', { name: /Auswahl/ }).click(); await image.click(); await image.focus(); await p.keyboard.press('Shift+ArrowRight')
  assert.equal(await p.locator('.image-handle').count(), 4)
  const imagePosition = await image.evaluate(el => el.style.left)
  const text = p.locator('.textbox').first()
  assert.equal(await text.locator('textarea').inputValue(), 'Editable A4 text')
  await text.click(); await text.focus(); await p.keyboard.press('ArrowRight')
  await btn('Speichern').click(); await p.waitForFunction(() => document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'))
  await p.reload(); await p.getByRole('button', { name: /Entwürfe/ }).click(); await p.locator('.draft-open').first().click()
  await p.waitForSelector('.pages .image-overlay'); assert.equal(await p.locator('.pages .image-overlay').evaluate(el => el.style.left), imagePosition)
  await btn('Seiten verwalten').click(); await ready(); await expectSizes(await download('Exportieren', 'restored.pdf'), true)
  await choose(0); await btn('Seite im Uhrzeigersinn drehen').click(); await ready()
  const extracted = await download('Extrahieren', 'rotated.pdf'); near(extracted.getPage(0).getRotation().angle, 90)
  assert.equal(extracted.getForm().getTextField('person.name').getText(), 'Ada')
  await btn('Rückgängig').click(); await ready()
  await p.setViewportSize({ width: 390, height: 1000 }); await btn('Alle Seiten auf A4 …').click(); await ready()
  await choose(0); const mobilePortrait = await paper(); await choose(1); const mobileLandscape = await paper(); near(mobileLandscape.width, mobilePortrait.height); near(mobileLandscape.height, mobilePortrait.width)
  await p.screenshot({ path: join(out, 'a4-mobile.png'), fullPage: true }); await btn('Abbrechen').click()
  // Enlarging a CropBox must not reveal hidden base content or widget appearances.
  await p.setViewportSize({ width: 1280, height: 1100 })
  const cropped = await PDFDocument.create(), cropPage = cropped.addPage([400, 600])
  cropPage.drawRectangle({ x: 20, y: 350, width: 40, height: 50, color: rgb(1, 0, 0) })
  const partial = cropped.getForm().createTextField('partial'); partial.setText('Visible')
  partial.addToPage(cropPage, { x: 30, y: 300, width: 100, height: 25, backgroundColor: rgb(0, 0, 1) })
  const hidden = cropped.getForm().createTextField('hidden'); hidden.setText('Outside')
  hidden.addToPage(cropPage, { x: 10, y: 50, width: 100, height: 25, backgroundColor: rgb(1, 0, 0) })
  cropPage.setCropBox(80, 100, 300, 450)
  await p.locator('input[accept="application/pdf"]').setInputFiles({ name: 'cropped.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await cropped.save()) })
  await btn('Seiten verwalten').click(); await ready()
  await btn('Alle Seiten auf A4 …').click(); await ready(); await btn('1 Seiten auf A4 setzen').click(); await ready()
  await download('Exportieren', 'cropped-a4.pdf')
  const raster = await p.evaluate(async bytes => {
    const { getDocument, GlobalWorkerOptions } = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
    GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
    const task = getDocument({ data: new Uint8Array(bytes) }), doc = await task.promise, page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 1 }), canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d'); await page.render({ canvasContext: ctx, viewport }).promise
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let marginInk = 0, red = 0, blue = 0
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4, r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]
      if (x < 16 && Math.min(r, g, b) < 230) marginInk++
      if (r > 220 && g < 80 && b < 80) red++
      if (b > 220 && r < 80 && g < 80) blue++
    }
    await task.destroy(); return { marginInk, red, blue }
  }, Array.from(readFileSync(join(out, 'cropped-a4.pdf'))))
  assert.equal(raster.marginInk, 0); assert.equal(raster.red, 0); assert.ok(raster.blue > 100)
  p.on('dialog', d => void d.accept())
  await btn('Seite löschen').click()
  await p.waitForSelector('.page-manager-empty')
  assert.equal(await btn('Alle Seiten auf A4 …').isDisabled(), true)
  assert.deepEqual(errors, [])
  console.log('PASS A4 common-scale portrait/landscape preview, cancel/Escape, atomic apply/undo/redo, real A4 exports, PDF.js native field edit, editable images/text, local draft reload, subsequent rotation/extraction, mobile preview; PDF.js raster confirms cropped base/widget contents stay hidden in white margins; no page errors.')
} finally { await browser.close() }
