import { PNG_DATA_URL } from '../tests/imageFixtures.js'
import { chromium } from 'playwright'
import { PDFDocument } from 'pdf-lib'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const base = process.env.SMOKE_URL ?? 'http://localhost:5207'
const out = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-editor-pages-'))
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({
  executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
  args: ['--no-sandbox'],
})
const p = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
const errors = []
p.on('pageerror', (e) => errors.push(String(e)))
p.on('dialog', (d) => void d.accept())
const button = (name) => p.getByRole('button', { name, exact: true })
async function settled() {
  await p.waitForFunction(
    () =>
      !document.querySelector('.page-manager-message')?.textContent?.includes('aktualisiert') &&
      document.querySelector('.page-manager-preview canvas')?.width > 0,
  )
}
async function download(name, file) {
  const pending = p.waitForEvent('download')
  await button(name).click()
  const d = await pending
  await d.saveAs(`${out}/${file}`)
  return new Uint8Array(readFileSync(`${out}/${file}`))
}
async function parsed(bytes) {
  return p.evaluate(async (data) => {
    const { getDocument, GlobalWorkerOptions } = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
    GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
    const task = getDocument({ data: new Uint8Array(data) })
    const doc = await task.promise
    const result = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const viewport = page.getViewport({ scale: 1 })
      result.push({
        width: viewport.width,
        height: viewport.height,
        text: content.items
          .filter((x) => 'str' in x)
          .map((x) => ({
            str: x.str,
            point: viewport.convertToViewportPoint(x.transform[4], x.transform[5]),
            transform: x.transform,
          })),
      })
    }
    await task.destroy()
    return result
  }, Array.from(bytes))
}
async function insertFile(name, mimeType, buffer, position) {
  await button('＋ Seiten einfügen').click()
  await p.locator('.page-insert-dialog input[type=file]').setInputFiles({ name, mimeType, buffer })
  if (position !== undefined) await p.getByLabel('Einfügeposition').selectOption(String(position))
  await p.locator('.page-insert-dialog').getByRole('button', { name: 'Einfügen', exact: true }).click()
  await p
    .locator('.page-insert-dialog')
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(async (e) => {
      console.error(await p.locator('.page-insert-dialog').textContent())
      throw e
    })
  await settled()
}
try {
  await p.goto(base)
  const fixture = readFileSync(new URL('../tests/fixtures/zweiseitig.pdf', import.meta.url))
  await p
    .locator('input[accept="application/pdf"]')
    .setInputFiles({ name: 'zweiseitig.pdf', mimeType: 'application/pdf', buffer: fixture })
  await p.waitForFunction(() => document.querySelector('.pages .page canvas')?.width > 0)
  await button('T Text').click()
  const r = await p.locator('.pages .page').first().boundingBox()
  await p.mouse.click(r.x + 100, r.y + 240)
  await p.locator('.textbox textarea').fill('Drehbarer Korrekturtext')
  await p.locator('.textbox textarea').press('Escape')
  await button('Seiten verwalten').click()
  await settled()
  assert.equal(await p.locator('.page-manager-row').count(), 2)
  // A selected page must not override append-at-end as the fresh dialog default.
  await button('＋ Seiten einfügen').click()
  assert.equal(await p.getByLabel('Einfügeposition').inputValue(), '2')
  assert.deepEqual(await p.getByLabel('Einfügeposition').locator('option').allTextContents(),
    ['Am Ende anhängen', 'Am Anfang einfügen', 'Zwischen Seite 1 und 2'])
  await p.getByLabel('Einfügeposition').selectOption('0')
  await p.keyboard.press('Escape')
  await button('＋ Seiten einfügen').click()
  assert.equal(await p.getByLabel('Einfügeposition').inputValue(), '2')
  await p.keyboard.press('Escape')
  await button('Seite im Uhrzeigersinn drehen').click()
  await settled()
  assert.match(await p.locator('.page-manager-row.selected').textContent(), /90°/)
  assert.match(await p.locator('.page-manager-preview .textbox').getAttribute('style'), /rotate\(90deg\)/)
  const rotation = await download('Extrahieren', 'rotated.pdf'),
    rotationDoc = await PDFDocument.load(rotation)
  assert.equal(rotationDoc.getPageCount(), 1)
  assert.equal(rotationDoc.getPage(0).getRotation().angle, 90)
  const textItem = (await parsed(rotation))[0].text.find((x) => x.str === 'Drehbarer Korrekturtext')
  assert(textItem)
  // PDF.js returns the post-rotation displayed baseline. Compare DOM's local transform origin.
  const dom = await p.locator('.page-manager-preview .textbox').evaluate((el) => {
    const style = getComputedStyle(el),
      origin = style.transformOrigin.split(' ').map(parseFloat)
    return { x: parseFloat(el.style.left) + origin[0], y: parseFloat(el.style.top) + origin[1] }
  })
  const preview = await p
    .locator('.page-manager-preview canvas')
    .evaluate((el) => ({ width: parseFloat(el.style.width), height: parseFloat(el.style.height) }))
  const size = (await parsed(rotation))[0]
  assert(Math.abs((dom.x / preview.width) * size.width - textItem.point[0]) < 1)
  assert(Math.abs((dom.y / preview.height) * size.height - textItem.point[1]) < 1)
  const beforeCrop = await p.locator('.page-preview-paper').boundingBox()
  await button('Zuschneiden').click()
  assert.equal(await p.locator('dialog[open]').count(), 0)
  assert.equal((await p.locator('.page-preview-paper').boundingBox()).width, beforeCrop.width)
  await p.getByLabel('Links · mm').fill('10')
  await p.getByLabel('Oben · mm').fill('5')
  await p.screenshot({ path: `${out}/crop-desktop.png` })
  await button('Zuschnitt anwenden').click()
  await settled()
  assert.equal(await p.locator('.page-crop-controls').count(), 0)
  const cropped = await download('Extrahieren', 'cropped.pdf')
  const croppedDoc = await PDFDocument.load(cropped)
  assert(croppedDoc.getPage(0).getCropBox().width < rotationDoc.getPage(0).getCropBox().width)
  assert((await parsed(cropped))[0].text.some((x) => x.str === 'Drehbarer Korrekturtext'))
  await button('Rückgängig').click()
  await settled()
  await button('Wiederholen').click()
  await settled()
  await button('Zuschneiden').click()
  await p.getByLabel('Links · mm').fill('9999')
  await button('Zuschnitt anwenden').click()
  assert.match(await p.locator('.page-manager-error').textContent(), /20 × 20/)
  await button('Abbrechen').click()
  await insertFile('anlage.pdf', 'application/pdf', fixture, 1)
  assert.equal(await p.locator('.page-manager-row').count(), 4)
  await p.getByRole('button', { name: 'Seite 2 nach unten', exact: true }).click()
  await settled()
  await button('Rückgängig').click()
  await settled()
  const png = Buffer.from(PNG_DATA_URL.split(',')[1], 'base64')
  await insertFile('foto.png', 'image/png', png, 4)
  assert.equal(await p.locator('.page-manager-row').count(), 5)
  await button('＋ Seiten einfügen').click()
  await p.getByLabel('Quelle', { exact: true }).selectOption('text')
  await p.locator('.page-insert-dialog').getByRole('button', { name: 'Einfügen', exact: true }).click()
  assert.match(await p.locator('.page-insert-dialog [role=alert]').textContent(), /Text eingeben/)
  await p.getByLabel('Text', { exact: true }).fill('Notizen zum Antrag')
  await p.getByLabel('Einfügeposition').selectOption('0')
  await p.locator('.page-insert-dialog').getByRole('button', { name: 'Einfügen', exact: true }).click()
  await settled()
  assert.equal(await p.locator('.page-manager-row').count(), 6)
  const all = await download('Exportieren', 'all-pages.pdf')
  assert.equal((await PDFDocument.load(all)).getPageCount(), 6)
  assert((await parsed(all))[0].text.some((x) => x.str === 'Notizen zum Antrag'))
  await button('Speichern').click()
  await p.waitForFunction(() =>
    document.querySelector('.draft-save-status').textContent.includes('Entwurf gespeichert'),
  )
  await p.reload()
  await p.getByRole('button', { name: /Entwürfe/ }).click()
  await p.locator('.draft-open').first().click()
  await p.waitForFunction(() => document.querySelector('.file-info')?.textContent.includes('6 Seiten'))
  await button('Seiten verwalten').click()
  await settled()
  assert.equal(await p.locator('.page-manager-row').count(), 6)
  await button('Seite löschen').click(); await button('1 Seite löschen').click()
  await settled()
  assert.equal(await p.locator('.page-manager-row').count(), 5)
  await button('Rückgängig').click()
  await settled()
  assert.equal(await p.locator('.page-manager-row').count(), 6)
  await p.setViewportSize({ width: 390, height: 844 })
  await button('Zuschneiden').click()
  assert.equal(await p.locator('.page-manager-panel .page-crop-controls').count(), 1)
  await p.screenshot({ path: `${out}/crop-mobile.png`, fullPage: true })
  await p.keyboard.press('Escape')
  assert.equal(await p.locator('.page-crop-controls').count(), 0)
  await p.setViewportSize({ width: 1280, height: 1000 })
  await button('Zur Dokumentbearbeitung').click()
  await p.waitForFunction(() => document.querySelectorAll('.pages .page').length === 6)
  await p.screenshot({ path: `${out}/editor-pages.png` })
  assert.deepEqual(errors, [])
  console.log(
    'PASS actual UI: textbox page rotation/export baseline, sidebar crop/undo/validation, PDF+image+text insertion at gaps, reorder, valid extraction/full export, durable draft reopen, deletion/undo, mobile cancel, return to editing. No page errors.',
  )
} finally {
  await browser.close()
}
