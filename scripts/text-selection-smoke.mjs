// T19: the text layer must match the page at any zoom, rotation and crop, and
// must never get in the way of the other tools.
import { collectErrors, launchBrowser, pageReady, pdfInput } from './browser-helper.mjs'
import { PNG_DATA_URL } from '../tests/imageFixtures.js'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import assert from 'node:assert/strict'

const GERMAN = 'Größe prüfen: Äpfel, Öl und Straße'
const ENGLISH = 'The quick brown fox jumps'

async function textPdf({ rotate = 0, crop } = {}) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 500])
  page.drawText(GERMAN, { x: 50, y: 420, size: 14, font })
  page.drawText(ENGLISH, { x: 50, y: 395, size: 14, font })
  page.setRotation(degrees(rotate))
  if (crop) page.setCropBox(crop.x, crop.y, crop.width, crop.height)
  return doc.save()
}

async function scanPdf() {
  const doc = await PDFDocument.create()
  const image = await doc.embedPng(PNG_DATA_URL)
  doc.addPage([400, 500]).drawImage(image, { x: 40, y: 40, width: 320, height: 420 })
  return doc.save()
}

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
collectErrors(page, errors)
await page.goto(process.env.SMOKE_URL ?? 'http://localhost:5199')

let opened = 0
const open = async bytes => {
  const name = `text-${++opened}.pdf`
  await pdfInput(page).setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) })
  await page.waitForFunction(value => document.querySelector('.file-info')?.textContent.includes(value), name)
  await pageReady(page)
}
const span = text => page.locator('.textLayer span', { hasText: text }).first()
const selected = () => page.evaluate(() => window.getSelection().toString())
// Where the text really is: the dark pixels of the rendered canvas.
const inkBox = () => page.evaluate(() => {
  const canvas = document.querySelector('.page canvas'), scale = canvas.width / canvas.getBoundingClientRect().width
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  let left = Infinity, top = Infinity, right = -1, bottom = -1
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++)
    if (data[(y * canvas.width + x) * 4] < 128) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y) }
  return { left: left / scale, top: top / scale, right: right / scale, bottom: bottom / scale }
})
const layerBox = () => page.evaluate(() => {
  const host = document.querySelector('.page').getBoundingClientRect()
  const boxes = [...document.querySelectorAll('.textLayer span')].filter(item => item.textContent.trim()).map(item => item.getBoundingClientRect())
  return {
    left: Math.min(...boxes.map(box => box.left)) - host.left, top: Math.min(...boxes.map(box => box.top)) - host.top,
    right: Math.max(...boxes.map(box => box.right)) - host.left, bottom: Math.max(...boxes.map(box => box.bottom)) - host.top,
  }
})
// The layer covers line height, the ink only the glyphs: both must share one area.
const assertAligned = async (label, tolerance) => {
  await page.waitForFunction(() => document.querySelector('.textLayer .endOfContent'))
  const ink = await inkBox(), layer = await layerBox()
  for (const side of ['left', 'top', 'right', 'bottom'])
    assert.ok(Math.abs(ink[side] - layer[side]) <= tolerance, `${label}: ${side} ink ${ink[side]} layer ${layer[side]}`)
}

await open(await textPdf())
await assertAligned('100 %', 6)
await page.getByRole('button', { name: '+', exact: true }).click()
await page.getByRole('button', { name: '+', exact: true }).click()
await page.waitForTimeout(300)
await assertAligned('Zoom', 8)
await page.getByRole('button', { name: '−', exact: true }).click()
await page.getByRole('button', { name: '−', exact: true }).click()
await page.waitForTimeout(300)

// Mouse: drag across one line.
const line = await span('Größe').boundingBox()
await page.mouse.move(line.x + 2, line.y + line.height / 2)
await page.mouse.down()
await page.mouse.move(line.x + line.width - 2, line.y + line.height / 2, { steps: 8 })
await page.mouse.up()
assert.match(await selected(), /Größe prüfen: Äpfel, Öl und Straße/)
const notice = await page.evaluate(async () => {
  document.addEventListener('copy', event => { window.__copied = window.getSelection().toString(); event.preventDefault() }, { once: true })
  return document.execCommand('copy')
})
assert.equal(notice, true)
assert.match(await page.evaluate(() => window.__copied), /Straße/)

// Keyboard: reach the layer, select the page, leave with Escape.
await page.locator('.textLayer').focus()
await page.keyboard.press('Control+a')
const all = await selected()
assert.match(all, /Straße/)
assert.match(all, /quick brown fox/)
assert.doesNotMatch(all, /Exportieren/, 'select all stays inside the page')
await page.keyboard.press('Escape')
assert.equal(await selected(), '')

// Every drawing tool removes the layer, so a drag draws instead of selecting.
await page.getByRole('button', { name: 'Stift', exact: true }).click()
assert.equal(await page.locator('.textLayer').count(), 0)
const box = await page.locator('.page').boundingBox()
await page.mouse.move(box.x + 60, box.y + 90)
await page.mouse.down()
await page.mouse.move(box.x + 220, box.y + 110, { steps: 5 })
await page.mouse.up()
assert.equal(await selected(), '')
assert.equal(await page.locator('.stroke-layer').count(), 1)
await page.keyboard.press('Escape')

// The text tool still creates a box on top of existing text.
await page.getByRole('button', { name: 'T Text', exact: true }).click()
assert.equal(await page.locator('.textLayer').count(), 0)
await page.locator('.page').click({ position: { x: 100, y: 90 } })
await page.keyboard.type('Neu')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
assert.equal(await page.locator('.textbox').count(), 1)

// A textbox above page text still moves with the select tool.
await page.waitForSelector('.textLayer .endOfContent', { state: 'attached' })
await page.locator('.textbox .drag-surface').click({ force: true })
assert.ok(await page.locator('.textbox textarea').count())
const before = await page.locator('.textbox').boundingBox()
await page.mouse.move(before.x + 4, before.y + before.height / 2)
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')

// Fast switching leaves exactly one finished layer.
for (let round = 0; round < 6; round++) {
  await page.getByRole('button', { name: 'Stift', exact: true }).click()
  await page.getByRole('button', { name: '⬚ Auswahl', exact: true }).click()
}
await page.waitForSelector('.textLayer .endOfContent', { state: 'attached' })
assert.equal(await page.locator('.textLayer').count(), 1)
assert.equal(await page.locator('.textLayer .endOfContent').count(), 1)
assert.equal(await page.locator('.textLayer span', { hasText: 'Größe' }).count(), 1)

// Rotation and crop: the layer follows the composed page.
await open(await textPdf({ rotate: 90 }))
await assertAligned('Rotation', 8)
assert.match(await page.locator('.textLayer').textContent(), /Straße/)
await open(await textPdf({ crop: { x: 30, y: 370, width: 300, height: 80 } }))
await assertAligned('Crop', 8)

// Scan: no selectable text and an explanation, by mouse and by keyboard.
await open(await scanPdf())
await page.waitForSelector('.textLayer .endOfContent', { state: 'attached' })
assert.equal(await page.locator('.textLayer span').count(), 0)
const scan = await page.locator('.page').boundingBox()
await page.mouse.move(scan.x + 80, scan.y + 80)
await page.mouse.down()
await page.mouse.move(scan.x + 200, scan.y + 160, { steps: 4 })
await page.mouse.up()
await page.waitForSelector('.page-no-text')
assert.match(await page.locator('.page-no-text').textContent(), /keine Textebene/)
assert.equal(await page.locator('.textLayer').getAttribute('aria-label'), 'Seite 1: keine Textebene')

// A new document shows only its own text.
await open(await textPdf())
await page.waitForSelector('.textLayer .endOfContent', { state: 'attached' })
assert.equal(await page.locator('.page-no-text').count(), 0)
assert.match(await page.locator('.textLayer').textContent(), /Straße/)

assert.deepEqual(errors, [])
console.log('PASS text selection: Zoom, Rotation, Crop, Maus, Tastatur, Werkzeuge, Scan')
await browser.close()
