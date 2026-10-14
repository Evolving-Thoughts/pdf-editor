import { fileURLToPath } from 'node:url'
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
// Real UI/command/export boundaries; isolated browser data, no fixture store injection.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, PDFName, PDFNumber, degrees, StandardFonts, rgb } from 'pdf-lib'
const base = process.env.SMOKE_URL ?? 'http://localhost:5203'
const artifacts = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-editor-t5-'))
mkdirSync(artifacts, { recursive: true })
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--no-sandbox'],
})
const errors = [],
  fixture = fileURLToPath(new URL('../tests/fixtures/zweiseitig.pdf', import.meta.url))
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
page.on('pageerror', (e) => errors.push(String(e)))
async function open(p) {
  await p.goto(base)
  await p.locator('input[accept="application/pdf"]').setInputFiles(fixture)
  await p.waitForFunction(() => document.querySelector('.page canvas')?.width > 0)
}
async function draw(p, label, a, b) {
  await p.getByRole('button', { name: label, exact: true }).click()
  assert.equal(await p.locator('.shape-toolbar').count(), 0)
  const r = await p.locator('.page').first().boundingBox()
  await p.mouse.move(r.x + a[0], r.y + a[1])
  await p.mouse.down()
  await p.mouse.move(r.x + b[0], r.y + b[1], { steps: 8 })
  await p.mouse.up()
  await p.waitForSelector('.shape-overlay.selected', { state: 'attached' })
  await p.waitForSelector('.shape-toolbar')
  // This legacy suite deliberately tests editing; creation itself now stays active.
  await p.getByRole('button', { name: '⬚ Auswahl', exact: true }).click()
}
async function geometry(p) {
  return p.locator('.shape-overlay.selected').evaluate((e) => ({
    x: parseFloat(e.style.left),
    y: parseFloat(e.style.top),
    w: parseFloat(e.style.width),
    h: parseFloat(e.style.height),
    angle: parseFloat(e.style.transform.slice(7)),
  }))
}
async function drag(p, l, dx, dy) {
  const r = await l.boundingBox()
  await p.mouse.move(r.x + r.width / 2, r.y + r.height / 2)
  await p.mouse.down()
  await p.mouse.move(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy, { steps: 8 })
  await p.mouse.up()
}
const undo = (p) => p.getByRole('button', { name: 'Rückgängig', exact: true }).click()
async function rotateArc(page, delta, { shift = false, cancel = false, touch = false } = {}) {
  const selected = await page.locator('.shape-overlay.selected').boundingBox()
  const grip = await page.getByRole('button', { name: 'Form frei drehen', exact: true }).boundingBox()
  const cx = selected.x + selected.width / 2,
    cy = selected.y + selected.height / 2
  const x = grip.x + grip.width / 2,
    y = grip.y + grip.height / 2
  const angle = Math.atan2(y - cy, x - cx),
    radius = Math.hypot(x - cx, y - cy)
  const next = (fraction) => ({
    x: cx + Math.cos(angle + ((delta * Math.PI) / 180) * fraction) * radius,
    y: cy + Math.sin(angle + ((delta * Math.PI) / 180) * fraction) * radius,
  })
  assert.equal(
    await page.getByRole('button', { name: 'Form frei drehen', exact: true }).evaluate((el) => {
      const r = el.getBoundingClientRect()
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === el
    }),
    true,
    'the rotation grip must be visible and not covered by the movable palette',
  )
  if (touch) {
    const session = await page.context().newCDPSession(page)
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let i = 1; i <= 12; i++)
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [next(i / 12)] })
    await session.send('Input.dispatchTouchEvent', {
      type: cancel ? 'touchCancel' : 'touchEnd',
      touchPoints: [],
    })
    await session.detach()
    return
  }
  await page.mouse.move(x, y)
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) {
    const point = next(i / 12)
    await page.mouse.move(point.x, point.y)
  }
  if (cancel) {
    await page
      .getByRole('button', { name: 'Form frei drehen', exact: true })
      .dispatchEvent('pointercancel', { pointerId: 1 })
  }
  await page.mouse.up()
  if (shift) await page.keyboard.up('Shift')
}
try {
  await open(page)
  await draw(page, 'Rechteck', [210, 250], [410, 350])
  assert.equal(await page.locator('.shape-overlay.selected [data-corner]').count(), 4)
  // Move the approved palette away from the rectangle for independent pointer tests.
  await drag(page, page.getByRole('button', { name: 'Formleiste verschieben', exact: true }), 20, 430)
  for (const [corner, dx, dy] of [
    ['nw', -15, -20],
    ['ne', 15, -20],
    ['sw', -15, 20],
    ['se', 15, 20],
  ]) {
    const before = await geometry(page)
    await drag(page, page.locator(`.shape-overlay.selected [data-corner="${corner}"]`), dx, dy)
    const after = await geometry(page)
    assert.equal(Math.round(after.w), Math.round(before.w + 15))
    assert.equal(Math.round(after.h), Math.round(before.h + 20))
    await undo(page)
    assert.deepEqual(await geometry(page), before)
  }
  const angle = page.getByRole('textbox', { name: 'Formwinkel in Grad', exact: true })
  await angle.fill('30')
  await angle.press('Enter')
  assert.equal((await geometry(page)).angle, 30)
  await rotateArc(page, 17, { shift: true })
  assert.equal((await geometry(page)).angle, 45)
  await undo(page)
  await rotateArc(page, 17, { cancel: true })
  assert.equal((await geometry(page)).angle, 30)
  await page.getByRole('button', { name: 'Form 90° im Uhrzeigersinn drehen', exact: true }).click()
  assert.equal((await geometry(page)).angle, 120)
  await undo(page)
  // Cancellation and one-step grouped keyboard corner edits.
  const corner = page.locator('.shape-overlay.selected [data-corner="ne"]')
  const before = await geometry(page)
  await corner.focus()
  await corner.press('ArrowRight')
  await corner.press('ArrowRight')
  assert.notDeepEqual(await geometry(page), before)
  await undo(page)
  assert.deepEqual(await geometry(page), before)
  const selected = page.locator('.shape-overlay.selected')
  const r = await selected.boundingBox()
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2)
  await page.mouse.down()
  await page.mouse.move(r.x + r.width / 2 + 30, r.y + r.height / 2 + 20)
  await selected.dispatchEvent('pointercancel', { pointerId: 1, isPrimary: true })
  await page.mouse.up()
  assert.deepEqual(await geometry(page), before)
  // Selected-only toolbar, no creation state leaking.
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.shape-toolbar').count(), 0)
  await page.getByRole('button', { name: 'Ellipse', exact: true }).click()
  assert.equal(await page.locator('.shape-toolbar').count(), 0)
  // Escape hides and cancels an unfinished creation, without adding history/state.
  const previewArea = await page.locator('.page').first().boundingBox()
  await page.mouse.move(previewArea.x + 100, previewArea.y + 420)
  await page.mouse.down()
  await page.mouse.move(previewArea.x + 220, previewArea.y + 480)
  assert.equal(await page.locator('.shape-preview').count(), 1)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.shape-preview,.stroke-preview').count(), 0)
  await page.mouse.up()
  assert.equal(await page.locator('.shape-overlay').count(), 1)
  await draw(page, 'Ellipse', [100, 420], [270, 490])
  assert.equal(await page.locator('.shape-overlay').count(), 2)
  await page.getByRole('button', { name: 'Füllung: Weiß', exact: true }).click()
  await page.getByRole('button', { name: 'Kontur: Keine Kontur', exact: true }).click()
  assert.equal(
    await page.locator('.shape-overlay.selected .shape-vector path').first().getAttribute('fill'),
    '#ffffff',
  )
  assert.equal(
    await page.locator('.shape-overlay.selected .shape-vector path').first().getAttribute('stroke'),
    'none',
  )
  await page.getByRole('button', { name: 'Kontur: Schwarz', exact: true }).click()
  await draw(page, 'Linie', [350, 430], [500, 430])
  assert.equal(await page.locator('.shape-overlay.selected [data-endpoint]').count(), 2)
  // Horizontal lines must remain visible and selectable even with a zero-height logical box.
  await page.keyboard.press('Escape')
  const pr = await page.locator('.page').first().boundingBox()
  await page.mouse.click(pr.x + 420, pr.y + 430)
  await page.waitForSelector('.shape-overlay.selected', { state: 'attached' })
  assert.equal(await page.locator('.shape-overlay.selected').getAttribute('aria-label'), 'Form: line')
  await drag(page, page.getByRole('button', { name: 'Form-Endpunkt: Ende', exact: true }), -20, 30)
  assert.equal(Math.round((await geometry(page)).h), 30)
  await draw(page, 'Pfeil', [360, 500], [500, 560])
  assert.equal(await page.locator('.shape-overlay.selected [data-endpoint]').count(), 2)
  await draw(page, 'Textmarker', [120, 560], [310, 560])
  assert.equal(await page.locator('.shape-overlay').count(), 5)
  assert.equal(
    await page.locator('.shape-toolbar').getByRole('group', { name: 'Füllung', exact: true }).count(),
    0,
  )
  await page.getByRole('button', { name: 'Farbe: Grün', exact: true }).click()
  await page.getByRole('button', { name: '36 pt Textmarkerbreite', exact: true }).click()
  await page.screenshot({ path: join(artifacts, 'desktop-marker.png') })
  const markerBefore = await geometry(page),
    markerId = await page.locator('.shape-overlay.selected').getAttribute('data-shape-id')
  await page.getByRole('button', { name: 'Radierer', exact: true }).click()
  const markerArea = await page.locator('.page').first().boundingBox()
  await page.mouse.click(
    markerArea.x + markerBefore.x + markerBefore.w / 2,
    markerArea.y + markerBefore.y + markerBefore.h / 2,
  )
  assert.equal(await page.locator('.shape-overlay').count(), 6)
  await undo(page)
  assert.equal(await page.locator('.shape-overlay').count(), 5)
  assert.equal(await page.locator(`[data-shape-id="${markerId}"]`).count(), 1)
  await page.getByRole('button', { name: 'Zeichnung löschen', exact: true }).click()
  assert.equal(await page.locator('.shape-overlay').count(), 4)
  await undo(page)
  assert.equal(await page.locator('.shape-overlay').count(), 5)
  // Real auto-save / reopen.
  await page.waitForTimeout(800)
  await page.reload()
  await page.getByRole('button', { name: /Entwürfe/ }).click()
  await page
    .getByRole('button', { name: /zweiseitig.pdf/ })
    .first()
    .click()
  await page.waitForSelector('.shape-overlay')
  assert.equal(await page.locator('.shape-overlay').count(), 5)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click(); await confirmDefaultExport(page)
  await (await download).saveAs(join(artifacts, 'shapes-export.pdf'))
  // Capture selected rectangle, then narrow light/dark controls with unchanged layout.
  await page.locator('.shape-overlay').first().focus()
  await page.waitForSelector('.shape-toolbar')
  await page.screenshot({ path: join(artifacts, 'desktop-shape.png') })
  await page.setViewportSize({ width: 390, height: 900 })
  await page.getByRole('button', { name: 'Formleiste zurücksetzen', exact: true }).click()
  await page.screenshot({ path: join(artifacts, 'mobile-light.png') })
  const bounds = await page.locator('.shape-toolbar').boundingBox()
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(artifacts, 'mobile-dark.png') })

  // Actual PDF.js rasterization: independently expected local CW rectangle corners,
  // original PDF blue background, marker Multiply opacity, later text over a white cover.
  const exported = await context.newPage()
  exported.on('pageerror', (e) => errors.push(String(e)))
  for (const rotation of [0, 90, 180, 270]) {
    const doc = await PDFDocument.create(),
      sheet = doc.addPage([600, 800])
    sheet.setCropBox(50, 70, 380, 370)
    sheet.setRotation(degrees(rotation))
    sheet.node.set(PDFName.of('UserUnit'), PDFNumber.of(2))
    await exported.goto(base)
    await exported.locator('input[accept="application/pdf"]').setInputFiles({
      name: 'cropped.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    })
    await exported.waitForFunction(() => document.querySelector('.page canvas')?.width > 0)
    await draw(exported, 'Rechteck', [210, 220], [390, 310])
    await exported.getByRole('button', { name: 'Füllung: Blau', exact: true }).click()
    await exported.getByRole('button', { name: 'Kontur: Keine Kontur', exact: true }).click()
    const input = exported.getByRole('textbox', { name: 'Formwinkel in Grad', exact: true })
    await input.fill('37.5')
    await input.press('Enter')
    const placed = await geometry(exported)
    const downloaded = exported.waitForEvent('download')
    await exported.getByRole('button', { name: 'Exportieren', exact: true }).click(); await confirmDefaultExport(exported)
    const path = join(artifacts, `shape-page-${rotation}.pdf`)
    await (await downloaded).saveAs(path)
    await exported.locator('input[accept="application/pdf"]').setInputFiles({
      name: `baked-${rotation}.pdf`,
      mimeType: 'application/pdf',
      buffer: readFileSync(path),
    })
    await exported.getByText(`baked-${rotation}.pdf · 1 Seite`, { exact: true }).waitFor()
    await exported.waitForFunction(({ x, y, w, h, angle }) => {
      const canvas = document.querySelector('.page canvas')
      if (!canvas?.width) return false
      const ctx = canvas.getContext('2d'),
        a = (angle * Math.PI) / 180
      const sample = (u, v) => {
        const dx = (u - 0.5) * w,
          dy = (v - 0.5) * h
        return ctx.getImageData(
          Math.round(x + w / 2 + Math.cos(a) * dx - Math.sin(a) * dy),
          Math.round(y + h / 2 + Math.sin(a) * dx + Math.cos(a) * dy),
          1,
          1,
        ).data
      }
      return (
        [
          [0.1, 0.1],
          [0.9, 0.1],
          [0.1, 0.9],
          [0.9, 0.9],
          [0.5, 0.5],
        ].every(([u, v]) => {
          const p = sample(u, v)
          return p[0] < 60 && p[1] < 110 && p[2] > 150
        }) && sample(1.15, 0.5)[0] > 240
      )
    }, placed)
    if (rotation === 90) await exported.screenshot({ path: join(artifacts, 'baked-shape.png') })
  }
  const document = await PDFDocument.create(),
    sheet = document.addPage([600, 800]),
    font = await document.embedFont(StandardFonts.Helvetica)
  sheet.drawRectangle({ x: 100, y: 500, width: 220, height: 80, color: rgb(0, 0, 1) })
  sheet.drawText('Alter Text', { x: 110, y: 530, size: 20, font })
  await exported.locator('input[accept="application/pdf"]').setInputFiles({
    name: 'correction.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await document.save()),
  })
  await exported.getByText('correction.pdf · 1 Seite', { exact: true }).waitFor()
  await draw(exported, 'Rechteck', [100, 220], [320, 300])
  await exported.getByRole('button', { name: 'Füllung: Weiß', exact: true }).click()
  await exported.getByRole('button', { name: 'Kontur: Keine Kontur', exact: true }).click()
  const coverId = await exported.locator('.shape-overlay').getAttribute('data-shape-id')
  await exported.getByRole('button', { name: 'T Text', exact: true }).click()
  const area = await exported.locator('.page').boundingBox()
  await exported.mouse.click(area.x + 110, area.y + 260)
  await exported.locator('.textbox textarea').fill('Neuer Text')
  await exported.locator('.textbox textarea').press('Escape')
  await exported.getByRole('button', { name: '⬚ Auswahl', exact: true }).click()
  await exported.locator(`[data-shape-id="${coverId}"]`).focus()
  await exported.screenshot({ path: join(artifacts, 'correction-layer.png') })
  // Later textbox stays after selected cover in DOM painting order (no selected z-index).
  assert.equal(
    await exported.evaluate(() => {
      const shape = document.querySelector('.shape-overlay'),
        text = document.querySelector('.textbox')
      return (
        !!(shape.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        getComputedStyle(shape).zIndex === 'auto'
      )
    }),
    true,
  )
  await draw(exported, 'Textmarker', [100, 330], [300, 330])
  const markerR = await geometry(exported)
  const download2 = exported.waitForEvent('download')
  await exported.getByRole('button', { name: 'Exportieren', exact: true }).click(); await confirmDefaultExport(exported)
  const baked = join(artifacts, 'correction-marker.pdf')
  await (await download2).saveAs(baked)
  await exported
    .locator('input[accept="application/pdf"]')
    .setInputFiles({ name: 'baked-correction.pdf', mimeType: 'application/pdf', buffer: readFileSync(baked) })
  await exported.getByText('baked-correction.pdf · 1 Seite', { exact: true }).waitFor()
  await exported.waitForFunction(({ x, y, w, h }) => {
    const c = document.querySelector('.page canvas')
    if (!c?.width) return false
    const ctx = c.getContext('2d')
    const white = ctx.getImageData(115, 235, 1, 1).data
    const marker = ctx.getImageData(Math.round(x + w / 2), Math.round(y + h / 2), 1, 1).data
    let dark = 0
    const t = ctx.getImageData(105, 240, 150, 40).data
    for (let i = 0; i < t.length; i += 4) if (t[i] < 80 && t[i + 1] < 80 && t[i + 2] < 80) dark++
    return (
      white[0] > 240 &&
      white[1] > 240 &&
      white[2] > 240 &&
      marker[0] > 230 &&
      marker[1] > 230 &&
      marker[2] > 160 &&
      marker[2] < 210 &&
      dark > 10
    )
  }, markerR)
  await exported.screenshot({ path: join(artifacts, 'baked-correction-marker.png') })
  // Touch creation / free rotation / cancellation, using real Chromium touch events.
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 900 },
    isMobile: true,
    hasTouch: true,
  })
  mobile.on('pageerror', (e) => errors.push(String(e)))
  await open(mobile)
  await mobile.getByRole('button', { name: 'Rechteck', exact: true }).click()
  const mobilePage = await mobile.locator('.page').first().boundingBox(),
    session = await mobile.context().newCDPSession(mobile)
  // At 390×900 the wrapped toolbar + save status leave only a narrow strip
  // above the bottom-clamped palette. Put this rotation fixture higher up,
  // keeping both the initial grip and the 30° grip center in that visible strip.
  // Keep the real touch gestures and the hit-test assertion in rotateArc: do
  // not bypass an occluded grip by dispatching synthetic pointer events to it.
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: mobilePage.x + 100, y: mobilePage.y + 50 }],
  })
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: mobilePage.x + 280, y: mobilePage.y + 140 }],
  })
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await mobile.waitForSelector('.shape-toolbar')
  await drag(mobile, mobile.getByRole('button', { name: 'Formleiste verschieben', exact: true }), 0, 320)
  await rotateArc(mobile, 30, { touch: true })
  assert.ok(Math.abs((await geometry(mobile)).angle - 30) < 1)
  const touchBefore = await geometry(mobile)
  await rotateArc(mobile, 20, { touch: true, cancel: true })
  assert.deepEqual(await geometry(mobile), touchBefore)
  await session.detach()
  await mobile.screenshot({ path: join(artifacts, 'touch-shape.png') })
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.deepEqual(errors, [])
  console.log('T5 shapes browser smoke passed:', artifacts)
} finally {
  await browser.close()
}
