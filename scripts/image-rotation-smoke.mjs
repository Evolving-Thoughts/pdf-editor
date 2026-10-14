import { confirmDefaultExport } from './export-smoke-helper.mjs'
// Approved rotation UI + draft/export/geometry regression checks in Chromium.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { degrees, PDFDocument, PDFName, PDFNumber } from 'pdf-lib'
import { PNG_DATA_URL } from '../tests/imageFixtures.js'
const url = process.env.SMOKE_URL ?? 'http://localhost:5202'
const artifacts = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-editor-rotation-'))
mkdirSync(artifacts, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), args: ['--no-sandbox'] })
const file = { name: 'angle.png', mimeType: 'image/png', buffer: Buffer.from(PNG_DATA_URL.split(',')[1], 'base64') }
const errors = []
const watch = page => page.on('pageerror', e => errors.push(String(e)))
const near = (a, b, tolerance = .05) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`)
const geometry = page => page.locator('.image-overlay').evaluate(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height), angle: Number(/rotate\(([^d]+)deg/.exec(el.style.transform)[1]) }))
const angleInput = page => page.getByRole('spinbutton', { name: 'Winkel in Grad', exact: true })
async function setAngle(page, value) { await angleInput(page).fill(String(value)); await angleInput(page).press('Enter') }
async function openAndInsert(page, pdf) {
  await page.goto(url)
  await page.locator('input[accept="application/pdf"]').setInputFiles(pdf)
  await page.waitForFunction(() => document.querySelector('.page canvas')?.width > 0)
  await page.locator('input[accept="image/png,image/jpeg"]').setInputFiles(file)
  await page.waitForSelector('.image-options', { state: 'visible' })
}
async function rotateArc(page, delta, { shift = false, cancel = false, touch = false } = {}) {
  const selected = await page.locator('.image-overlay').boundingBox()
  const grip = await page.getByRole('button', { name: 'Bild frei drehen', exact: true }).boundingBox()
  const cx = selected.x + selected.width / 2, cy = selected.y + selected.height / 2
  const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2
  const angle = Math.atan2(y - cy, x - cx), radius = Math.hypot(x - cx, y - cy)
  const next = fraction => ({ x: cx + Math.cos(angle + delta * Math.PI / 180 * fraction) * radius,
    y: cy + Math.sin(angle + delta * Math.PI / 180 * fraction) * radius })
  if (touch) {
    const session = await page.context().newCDPSession(page)
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let i = 1; i <= 12; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [next(i / 12)] })
    await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] })
    await session.detach()
    return
  }
  await page.mouse.move(x, y); if (shift) await page.keyboard.down('Shift')
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) { const point = next(i / 12); await page.mouse.move(point.x, point.y) }
  if (cancel) {
    await page.getByRole('button', { name: 'Bild frei drehen', exact: true }).dispatchEvent('pointercancel', { pointerId: 1 })
  }
  await page.mouse.up(); if (shift) await page.keyboard.up('Shift')
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); watch(page)
  // Count observer registrations: moving/rotating should only reposition, not re-subscribe.
  await page.addInitScript(() => {
    const Original = window.ResizeObserver
    window.observerCount = 0
    window.ResizeObserver = class extends Original { constructor(callback) { super(callback); window.observerCount++ } }
  })
  await openAndInsert(page, new URL('../tests/fixtures/zweiseitig.pdf', import.meta.url).pathname)
  const original = await geometry(page)
  await page.locator('.image-overlay').focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  near((await geometry(page)).x, original.x + 3)
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
  assert.deepEqual(await geometry(page), original, 'Repeated movement is one undo step')
  const left = page.getByRole('button', { name: '90° gegen den Uhrzeigersinn drehen', exact: true })
  const right = page.getByRole('button', { name: '90° im Uhrzeigersinn drehen', exact: true })
  const lock = page.getByRole('button', { name: 'Proportionen beibehalten', exact: true })
  const lb = await lock.boundingBox(), cb = await left.boundingBox(), rb = await right.boundingBox()
  assert.equal(lb.y, cb.y); assert.equal(cb.y, rb.y); assert.ok(lb.x < cb.x && cb.x < rb.x)
  await right.click(); near((await geometry(page)).angle, 90)
  assert.equal((await geometry(page)).w, original.w); assert.equal((await geometry(page)).h, original.h)
  await left.click(); near((await geometry(page)).angle, 0)
  await setAngle(page, 37.5); near((await geometry(page)).angle, 37.5)
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click(); near((await geometry(page)).angle, 0)
  await page.getByRole('button', { name: 'Wiederholen', exact: true }).click(); near((await geometry(page)).angle, 37.5)
  await setAngle(page, -30); near((await geometry(page)).angle, 330)
  await angleInput(page).fill('12'); await angleInput(page).press('Escape'); near((await geometry(page)).angle, 330)
  await setAngle(page, 0)
  const before = await page.evaluate(() => window.observerCount)
  await rotateArc(page, 38); near((await geometry(page)).angle, 38)
  assert.equal(await page.evaluate(() => window.observerCount), before, 'Observer is not recreated for rotation frames')
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click(); near((await geometry(page)).angle, 0)
  await rotateArc(page, 38, { shift: true }); near((await geometry(page)).angle, 45)
  const grip = page.getByRole('button', { name: 'Bild frei drehen', exact: true })
  await grip.focus(); await page.keyboard.press('ArrowRight'); near((await geometry(page)).angle, 46)
  await page.keyboard.press('Shift+ArrowLeft'); near((await geometry(page)).angle, 31)
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click(); near((await geometry(page)).angle, 45)
  await page.getByRole('button', { name: 'Wiederholen', exact: true }).click(); near((await geometry(page)).angle, 31)
  await setAngle(page, 30)
  await rotateArc(page, 20, { cancel: true }); near((await geometry(page)).angle, 30)
  console.log('PASS adjacent 90° buttons, exact/negative angles, drag, Shift snapping, keyboard, cancel and stable observer registration')
  // Drag/resize remain usable after rotation, and each gesture is one undo entry.
  const beforeDrag = await geometry(page), box = await page.locator('.image-overlay').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20); await page.mouse.up()
  near((await geometry(page)).x, beforeDrag.x + 30); near((await geometry(page)).y, beforeDrag.y + 20)
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click(); assert.deepEqual(await geometry(page), beforeDrag)
  await page.getByRole('button', { name: 'Bild skalieren: unten rechts', exact: true }).focus()
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  assert.ok((await geometry(page)).w > beforeDrag.w)
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
  assert.deepEqual(await geometry(page), beforeDrag, 'Repeated corner resize is one undo step')
  const corner = await page.getByRole('button', { name: 'Bild skalieren: unten rechts', exact: true }).boundingBox()
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2); await page.mouse.down()
  await page.mouse.move(corner.x + corner.width / 2 + 25, corner.y + corner.height / 2 + 20); await page.mouse.up()
  near((await geometry(page)).w / (await geometry(page)).h, 2)
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click(); assert.deepEqual(await geometry(page), beforeDrag)
  await page.screenshot({ path: join(artifacts, 'rotation-desktop.png') })
  await page.waitForTimeout(800); await page.reload()
  await page.getByRole('button', { name: /Entwürfe/ }).click(); await page.locator('.draft-open').first().click()
  await page.waitForSelector('.image-overlay'); near((await geometry(page)).angle, 30)
  await page.locator('.image-overlay').click()
  await page.getByRole('button', { name: 'Bild löschen', exact: true }).click()
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click(); near((await geometry(page)).angle, 30)
  console.log('PASS rotated dragging/resizing, undo, draft reopen and reversible deletion preserve angle/source')

  // Export pixels independently expected from CSS clockwise transforms, not export helpers.
  const exportedPage = await browser.newPage({ viewport: { width: 1280, height: 900 } }); watch(exportedPage)
  for (const rotation of [0, 90, 180, 270]) {
    const doc = await PDFDocument.create(), sheet = doc.addPage([600, 800])
    sheet.setCropBox(50, 70, 380, 370); sheet.setRotation(degrees(rotation))
    sheet.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))
    await openAndInsert(exportedPage, { name: 'rotated.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) })
    await setAngle(exportedPage, 37.5)
    const placed = await geometry(exportedPage)
    const download = exportedPage.waitForEvent('download')
    await exportedPage.getByRole('button', { name: 'Exportieren', exact: true }).click(); await confirmDefaultExport(exportedPage)
    const output = join(artifacts, `angle-page-${rotation}.pdf`); await (await download).saveAs(output)
    await exportedPage.locator('input[accept="application/pdf"]').setInputFiles({ name: `baked-${rotation}.pdf`, mimeType: 'application/pdf', buffer: readFileSync(output) })
    await exportedPage.getByText(`baked-${rotation}.pdf · 1 Seite`, { exact: true }).waitFor()
    await exportedPage.waitForFunction(({ x, y, w, h, angle }) => {
      const canvas = document.querySelector('.page canvas'); if (!canvas?.width) return false
      const context = canvas.getContext('2d'), a = angle * Math.PI / 180
      const sample = (u, v) => {
        const dx = (u - .5) * w, dy = (v - .5) * h
        return context.getImageData(Math.round(x + w / 2 + Math.cos(a) * dx - Math.sin(a) * dy),
          Math.round(y + h / 2 + Math.sin(a) * dx + Math.cos(a) * dy), 1, 1).data
      }
      const blue = sample(.25, .5), red = sample(.75, .25), clear = sample(.75, .75)
      return blue[2] > 180 && blue[0] < 60 && red[0] > 180 && red[2] < 60 && clear[0] > 240 && clear[1] > 240 && clear[2] > 240
    }, placed)
    if (rotation === 90) await exportedPage.screenshot({ path: join(artifacts, 'rotation-baked-export.png') })
  }
  console.log('PASS arbitrary angle export matches placement/orientation/alpha with page rotations, CropBox and UserUnit')

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); watch(mobile)
  await openAndInsert(mobile, new URL('../tests/fixtures/zweiseitig.pdf', import.meta.url).pathname)
  await rotateArc(mobile, 30, { touch: true }); near((await geometry(mobile)).angle, 30, 1)
  await rotateArc(mobile, 20, { touch: true, cancel: true }); near((await geometry(mobile)).angle, 30, 1)
  await setAngle(mobile, 30)
  await mobile.screenshot({ path: join(artifacts, 'rotation-mobile.png') })
  const bar = await mobile.locator('.image-options').boundingBox()
  assert.ok(bar.x >= 0 && bar.x + bar.width <= 390)
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await mobile.emulateMedia({ colorScheme: 'dark' }); await mobile.screenshot({ path: join(artifacts, 'rotation-mobile-dark.png') })
  console.log('PASS real touch rotation/cancel, responsive controls and dark mode')
  assert.deepEqual(errors, [])
  console.log('PASS no uncaught browser errors')
} finally { await browser.close() }
