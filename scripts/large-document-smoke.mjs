// T20: long documents must hold only a few canvases, whatever the page count.
import { collectErrors, launchBrowser, pdfInput } from './browser-helper.mjs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const out = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-large-'))
mkdirSync(out, { recursive: true })
const PAGES = 400, MAX_CANVASES = 8

async function makePdf(pages, marker) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= pages; index++)
    doc.addPage([595, 842]).drawText(`${marker} Seite ${index}`, { x: 50, y: 780, size: 20, font })
  return doc.save()
}

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
collectErrors(page, errors)
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
await page.goto(process.env.SMOKE_URL ?? 'http://localhost:5199')

const open = async (bytes, name) => {
  await pdfInput(page).setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) })
  await page.waitForFunction(() => document.querySelector('.page canvas[data-render-state="ready"]'))
}
const metrics = () => page.evaluate(() => ({
  canvases: document.querySelectorAll('.pages canvas').length,
  slots: document.querySelectorAll('.pages .page-slot').length,
  height: document.querySelector('.pages').scrollHeight,
  top: document.querySelector('.pages').scrollTop,
}))
const scrollTo = async top => {
  await page.evaluate(value => { document.querySelector('.pages').scrollTop = value }, top)
  await page.waitForTimeout(120)
}

const started = Date.now()
await open(await makePdf(PAGES, 'Lang'), 'lang.pdf')
const opened = Date.now() - started
const first = await metrics()
assert.equal(first.slots, PAGES, 'every page keeps its place in the scroll area')
assert.ok(first.canvases <= MAX_CANVASES, `opening holds ${first.canvases} canvases`)

// Fast scrolling must not pile up canvases; the height never depends on what is mounted.
let peak = 0
for (let step = 0; step < 30; step++) {
  await page.evaluate(value => { document.querySelector('.pages').scrollTop = value }, first.height * step / 30)
  await page.waitForTimeout(20)
  peak = Math.max(peak, (await metrics()).canvases)
}
assert.ok(peak <= MAX_CANVASES, `fast scrolling peaked at ${peak} canvases`)
assert.equal((await metrics()).height, first.height, 'scroll height stays stable')

// A search jump lands on a page that was only a placeholder before.
await scrollTo(0)
await page.keyboard.press('Control+f')
await page.getByRole('textbox', { name: 'Suchtext', exact: true }).fill('Lang Seite 321')
await page.waitForSelector('[data-search-active="true"]', { state: 'attached', timeout: 20000 })
assert.ok(await page.locator('.page[data-page-index="320"] canvas').count(), 'search jump mounts the hit page')
await page.getByRole('button', { name: 'Suche schließen' }).click().catch(() => page.keyboard.press('Escape'))
await page.keyboard.press('Escape')

// Overlays live in the store: leaving and returning restores them.
await scrollTo(0)
await page.getByRole('button', { name: 'T Text', exact: true }).click()
await page.locator('.page[data-page-index="0"]').click({ position: { x: 200, y: 300 } })
await page.keyboard.type('Bleibt erhalten')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
assert.equal(await page.locator('.page[data-page-index="0"] .textbox').count(), 1)
await scrollTo(first.height / 2)
await page.waitForFunction(() => !document.querySelector('.page[data-page-index="0"] canvas'))
await scrollTo(0)
await page.waitForFunction(() => document.querySelector('.page[data-page-index="0"] .textbox'))
assert.equal(await page.locator('.page[data-page-index="0"] textarea').inputValue(), 'Bleibt erhalten')

// A selected overlay keeps its page mounted while it is scrolled away.
await page.locator('.page[data-page-index="0"] .textbox .drag-surface').click({ force: true })
await scrollTo(first.height / 2)
await page.waitForTimeout(200)
assert.equal(await page.locator('.page[data-page-index="0"] textarea').count(), 1, 'selected textbox stays mounted')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')

// Switching documents leaves nothing of the old one behind.
await scrollTo(first.height / 2)
await open(await makePdf(2, 'Kurz'), 'kurz.pdf')
await page.waitForFunction(() => document.querySelectorAll('.pages .page-slot').length === 2)
assert.equal(await page.locator('.page[data-page-index="399"]').count(), 0)

// An oversized page count is refused and keeps the open document.
await pdfInput(page).setInputFiles({ name: 'zu-lang.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdf(5001, 'Zu')) })
await page.waitForSelector('[role="alert"].error', { timeout: 60000 })
const message = await page.locator('[role="alert"].error').textContent()
assert.match(message, /5\.001 Seiten/)
assert.equal((await metrics()).slots, 2, 'the open document stays')

const blocking = errors.filter(error => !/AbortError|Rendering cancelled/.test(error))
assert.deepEqual(blocking, [])
writeFileSync(join(out, 'measurements.json'), JSON.stringify({ pages: PAGES, openedMs: opened, firstCanvases: first.canvases, peakCanvases: peak }, null, 2))
console.log(`PASS large document: ${PAGES} Seiten, geöffnet in ${opened} ms, höchstens ${peak} Canvas-Flächen`)
await browser.close()
