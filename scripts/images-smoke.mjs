import { fileURLToPath } from 'node:url'
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
// Real-browser integration checks for T6. Isolated contexts: no user data.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { degrees, PDFName, PDFNumber, PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { PNG_DATA_URL, JPEG_DATA_URL, EXIF_JPEG_DATA_URL } from '../tests/imageFixtures.js'
const base = process.env.SMOKE_URL ?? 'http://localhost:5202'
const artifacts = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-editor-t6-'))
mkdirSync(artifacts, { recursive: true })
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const errors = []
const fixture = fileURLToPath(new URL('../tests/fixtures/zweiseitig.pdf', import.meta.url))
const png = { name: 'transparent.png', mimeType: 'image/png', buffer: Buffer.from(PNG_DATA_URL.split(',')[1], 'base64') }
const jpg = { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(JPEG_DATA_URL.split(',')[1], 'base64') }
const watch = page => { page.on('pageerror', error => errors.push(String(error))) }
async function openPdf(page) {
  await page.goto(base)
  await page.locator('input[accept="application/pdf"]').setInputFiles(fixture)
  await page.waitForSelector('.page canvas')
  await page.waitForFunction(() => document.querySelector('.page canvas').width > 0)
}
async function importFile(page, file) {
  await page.locator('input[accept="image/png,image/jpeg"]').setInputFiles(file)
  await page.waitForSelector('.image-overlay.selected')
  await page.waitForFunction(() => document.querySelector('.image-options')?.style.visibility === 'visible')
}
async function imageRect(page, index = 0) {
  return page.locator('.image-overlay').nth(index).evaluate(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }))
}
async function assetCount(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('pdf-editor-drafts')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('image-assets', 'readonly')
      const keys = tx.objectStore('image-assets').getAllKeys()
      tx.oncomplete = () => { db.close(); resolve(keys.result.length) }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
  }))
}
async function drag(page, locator, dx, dy) {
  const rect = await locator.boundingBox()
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy, { steps: 8 }); await page.mouse.up()
}
const near = (a, b, tolerance = .1) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`)
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); watch(page)
  await openPdf(page); await importFile(page, png)
  assert.equal(await page.locator('.image-handle').count(), 4)
  assert.equal(await page.getByRole('toolbar', { name: /Bildoptionen/ }).count(), 1)
  const original = await imageRect(page)
  near(original.w / original.h, 2)
  await page.screenshot({ path: join(artifacts, 'desktop-selected.png') })
  await drag(page, page.locator('.image-overlay'), 40, 30)
  const moved = await imageRect(page); near(moved.x, original.x + 40); near(moved.y, original.y + 30)
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
  assert.deepEqual(await imageRect(page), original)
  await page.getByRole('button', { name: 'Wiederholen', exact: true }).click()
  await drag(page, page.getByRole('button', { name: 'Bild skalieren: unten rechts', exact: true }), 60, 0)
  const resized = await imageRect(page); near(resized.w / resized.h, 2); near(resized.w, original.w + 60)
  await page.getByRole('button', { name: 'Proportionen beibehalten', exact: true }).click()
  const width = page.getByRole('spinbutton', { name: 'Breite in Millimetern', exact: true })
  const height = page.getByRole('spinbutton', { name: 'Höhe in Millimetern', exact: true })
  await width.fill('50.8'); await width.press('Enter')
  near((await imageRect(page)).w, 144)
  const beforeInvalid = await imageRect(page)
  await width.fill('-3'); await width.press('Enter'); assert.deepEqual(await imageRect(page), beforeInvalid)
  await width.fill('90'); await width.press('Escape'); assert.deepEqual(await imageRect(page), beforeInvalid)
  await height.fill('25.4'); await height.press('Enter'); near((await imageRect(page)).h, 72)
  await page.locator('.image-overlay').focus(); const beforeNudge = await imageRect(page)
  await page.keyboard.press('Shift+ArrowRight'); near((await imageRect(page)).x, beforeNudge.x + 10)
  console.log('PASS PNG import, floating A controls, drag/undo, resize, mm fields and keyboard')

  // Pointer cancellation leaves both state and history unchanged.
  const beforeCancel = await imageRect(page)
  await page.locator('.image-overlay').evaluate(el => el.addEventListener('pointerdown', event => {
    el.dataset.testPointerId = String(event.pointerId)
  }, { once: true }))
  const cancelRect = await page.locator('.image-overlay').boundingBox()
  await page.mouse.move(cancelRect.x + cancelRect.width / 2, cancelRect.y + cancelRect.height / 2)
  await page.mouse.down(); await page.mouse.move(cancelRect.x + cancelRect.width / 2 + 30, cancelRect.y + cancelRect.height / 2 + 30)
  const pointerId = Number(await page.locator('.image-overlay').getAttribute('data-test-pointer-id'))
  await page.locator('.image-overlay').dispatchEvent('pointercancel', { pointerId })
  await page.mouse.up()
  assert.deepEqual(await imageRect(page), beforeCancel)

  // A real export includes the image once at the edited geometry.
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click(); await confirmDefaultExport(page)
  const download = await downloadPromise; await download.saveAs(join(artifacts, 'images-export.pdf'))
  const exported = await PDFDocument.load(readFileSync(join(artifacts, 'images-export.pdf')))
  const value = exported.getPage(0).node.Contents()
  const streams = value instanceof PDFArray ? value.asArray() : [value]
  const text = streams.map(ref => Buffer.from(decodePDFRawStream(exported.context.lookup(ref, PDFRawStream)).decode()).toString()).join('\n')
  assert.match(text, /144 0 0 72 0 0 cm/)
  const placement = text.match(/1 0 0 1 (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) cm/)
  assert.ok(placement, 'The image placement matrix is present in the export')
  near(Number(placement[1]), beforeCancel.x)
  near(Number(placement[2]), 842 - beforeCancel.y - beforeCancel.h)
  assert.match(text, /\/Image-\S+ Do/)
  await page.waitForTimeout(800)
  await page.reload()
  await page.getByRole('button', { name: /Entwürfe/ }).click()
  await page.locator('.draft-open').first().click(); await page.waitForSelector('.image-overlay')
  assert.deepEqual(await imageRect(page), beforeCancel)
  assert.equal(await page.locator('.image-overlay img').evaluate(el => el.naturalWidth), 120)
  await page.locator('.image-overlay').click()
  await page.getByRole('button', { name: 'Bild löschen', exact: true }).click()
  assert.equal(await page.locator('.image-overlay').count(), 0)
  await page.waitForTimeout(800)
  assert.equal(await assetCount(page), 0, 'Autosave removes deleted image data')
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
  await page.waitForTimeout(800)
  assert.equal(await assetCount(page), 1, 'Undo rewrites the source on autosave')
  assert.equal(await page.locator('.image-overlay').count(), 1)
  console.log('PASS cancelled gesture, real PDF export, IndexedDB reopen and reversible deletion')

  // Invalid image files neither create overlays nor disturb existing state.
  await page.locator('input[accept="image/png,image/jpeg"]').setInputFiles({ name: 'not.png', mimeType: 'image/png', buffer: Buffer.from('bad image') })
  await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /PNG|JPG/)
  assert.equal(await page.locator('.image-overlay').count(), 1)
  await importFile(page, jpg)
  assert.equal(await page.locator('.image-overlay').count(), 2)
  assert.equal(await page.locator('.image-overlay img').last().evaluate(el => el.naturalWidth), 120)
  // Drop on page two, while it is visible.
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded()
  await page.locator('.page').nth(1).evaluate((el, data) => {
    const rect = el.getBoundingClientRect(); const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'drop.png', { type: 'image/png' }))
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 180, clientY: rect.top + 180 }))
  }, PNG_DATA_URL.split(',')[1])
  await page.waitForFunction(() => document.querySelectorAll('.image-overlay').length === 3)
  assert.equal(await page.locator('.page').nth(1).locator('.image-overlay').count(), 1)
  await page.getByRole('button', { name: 'Stift', exact: true }).click()
  assert.equal(await page.locator('.image-options').count(), 0)
  const sheet = await page.locator('.page').nth(1).boundingBox()
  await page.mouse.move(sheet.x + 100, Math.max(350, sheet.y + 300)); await page.mouse.down()
  await page.mouse.move(sheet.x + 200, Math.max(350, sheet.y + 300)); await page.mouse.up()
  await page.getByRole('button', { name: 'Zeichnung löschen', exact: true }).click()
  assert.equal(await page.locator('.image-overlay').count(), 3)
  console.log('PASS invalid inputs, JPEG, second-page drop and drawing deletion preserves images')

  // Slow decoding must never insert into a newly opened document.
  const race = await browser.newPage({ viewport: { width: 1280, height: 900 } }); watch(race)
  await openPdf(race)
  await race.evaluate(() => {
    const original = window.createImageBitmap.bind(window)
    window.createImageBitmap = async (...args) => {
      await new Promise(resolve => { window.releaseImageDecode = resolve })
      return original(...args)
    }
  })
  await race.locator('input[accept="image/png,image/jpeg"]').setInputFiles(png)
  await race.waitForFunction(() => typeof window.releaseImageDecode === 'function')
  const replacement = await PDFDocument.create(); replacement.addPage([400, 500])
  await race.locator('input[accept="application/pdf"]').setInputFiles({ name: 'new-document.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await replacement.save()) })
  await race.getByText('new-document.pdf · 1 Seite', { exact: true }).waitFor()
  await race.evaluate(() => window.releaseImageDecode())
  await race.waitForTimeout(400)
  assert.equal(await race.locator('.image-overlay').count(), 0)
  console.log('PASS document-switch race does not leak a pending import into another draft')

  // Validate baked export pixels against displayed geometry, independently of exporter transforms.
  const rotated = await browser.newPage({ viewport: { width: 1280, height: 900 } }); watch(rotated)
  for (const rotation of [0, 90, 180, 270]) {
    const doc = await PDFDocument.create(); const sheet = doc.addPage([600, 800])
    sheet.setCropBox(50, 70, 380, 370); sheet.setRotation(degrees(rotation))
    sheet.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))
    await rotated.goto(base)
    await rotated.locator('input[accept="application/pdf"]').setInputFiles({ name: `rotated-${rotation}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) })
    await rotated.waitForSelector('.page canvas')
    await importFile(rotated, png)
    const placed = await imageRect(rotated)
    const downloadPromise = rotated.waitForEvent('download')
    await rotated.getByRole('button', { name: 'Exportieren', exact: true }).click(); await confirmDefaultExport(rotated)
    const exported = await downloadPromise
    const output = join(artifacts, `rotated-${rotation}-export.pdf`); await exported.saveAs(output)
    await rotated.locator('input[accept="application/pdf"]').setInputFiles({ name: `baked-${rotation}.pdf`, mimeType: 'application/pdf', buffer: readFileSync(output) })
    await rotated.getByText(`baked-${rotation}.pdf · 1 Seite`, { exact: true }).waitFor()
    await rotated.waitForFunction(({ x, y, w, h }) => {
      const canvas = document.querySelector('.page canvas'); if (!canvas || !canvas.width) return false
      const ctx = canvas.getContext('2d')
      const blue = ctx.getImageData(Math.round(x + w * .25), Math.round(y + h * .5), 1, 1).data
      const red = ctx.getImageData(Math.round(x + w * .75), Math.round(y + h * .25), 1, 1).data
      const transparent = ctx.getImageData(Math.round(x + w * .75), Math.round(y + h * .75), 1, 1).data
      return blue[2] > 180 && blue[0] < 60 && red[0] > 180 && red[2] < 60 && transparent[0] > 240 && transparent[1] > 240 && transparent[2] > 240
    }, placed)
    if (rotation === 90) await rotated.screenshot({ path: join(artifacts, 'rotated-export.png') })
  }
  console.log('PASS real PDF.js export rendering matches placement/size/alpha at 0/90/180/270°, CropBox and UserUnit')

  const exif = await browser.newPage({ viewport: { width: 1280, height: 900 } }); watch(exif)
  await openPdf(exif)
  await importFile(exif, { name: 'oriented.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(EXIF_JPEG_DATA_URL.split(',')[1], 'base64') })
  assert.deepEqual(await exif.locator('.image-overlay img').evaluate(el => [el.naturalWidth, el.naturalHeight]), [60, 120])
  const exifRect = await imageRect(exif); near(exifRect.w / exifRect.h, .5)
  console.log('PASS JPEG EXIF orientation is normalized before preview and export')

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); watch(mobile)
  await openPdf(mobile); await importFile(mobile, png)
  const options = await mobile.locator('.image-options').boundingBox()
  assert.ok(options.x >= 0 && options.x + options.width <= 390)
  const mobileBefore = await imageRect(mobile)
  const rect = await mobile.locator('.image-overlay').boundingBox()
  const session = await mobile.context().newCDPSession(mobile)
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }] })
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: rect.x + rect.width / 2 + 25, y: rect.y + rect.height / 2 + 25 }] })
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  near((await imageRect(mobile)).x, mobileBefore.x + 25, 1)
  await mobile.screenshot({ path: join(artifacts, 'mobile-selected.png') })
  await mobile.emulateMedia({ colorScheme: 'dark' }); await mobile.screenshot({ path: join(artifacts, 'mobile-dark.png') })
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  console.log('PASS responsive A toolbar and real touch drag')
  assert.deepEqual(errors, [])
  console.log('PASS no uncaught browser errors; artifacts:', artifacts)
} finally { await browser.close() }
