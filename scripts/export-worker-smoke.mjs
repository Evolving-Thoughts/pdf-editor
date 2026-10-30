// T21: export runs in its own worker, stops on cancel, and the page stays alive.
import { chromiumPath } from './browser-helper.mjs'
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const PAGES = 1500
async function long() {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= PAGES; index++) doc.addPage([400, 500]).drawText(`Seite ${index}`, { x: 50, y: 420, size: 14, font })
  return doc.save()
}

const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
const errors = [], logged = []
page.on('pageerror', error => errors.push(String(error)))
page.on('console', message => logged.push(message.text()))
const exportWorkers = new Set()
page.on('worker', worker => {
  if (!/export\.worker/.test(worker.url())) return
  exportWorkers.add(worker)
  worker.on('close', () => exportWorkers.delete(worker))
})
await page.goto(process.env.SMOKE_URL ?? 'http://localhost:5199')
await page.locator('input[accept="application/pdf"]').setInputFiles({ name: 'lang.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await long()) })
await page.waitForSelector('.page canvas[data-render-state="ready"]')

// A heavy rebuild: every page is copied into a new document.
await page.getByRole('button', { name: 'Seiten verwalten', exact: true }).click()
await page.locator('.page-manager-row').nth(1).locator('button').first().waitFor()
await page.getByRole('button', { name: 'Zur Dokumentbearbeitung', exact: true }).click()

const dialog = () => page.getByRole('dialog', { name: 'PDF exportieren', exact: true })
const openExport = async () => {
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click()
  await dialog().locator('.export-check .export-detail').first().waitFor()
}
const beat = () => page.evaluate(() => {
  window.__gap = 0
  let last = performance.now()
  window.__beat = setInterval(() => { const now = performance.now(); window.__gap = Math.max(window.__gap, now - last); last = now }, 16)
})

// Cancel while running: nothing arrives, the worker is gone, and the editor is usable.
await openExport()
await beat()
let downloads = 0
page.on('download', () => { downloads += 1 })
await page.getByRole('radio', { name: /Struktur optimieren/ }).check()
await page.getByRole('button', { name: 'Export vorbereiten', exact: true }).click()
await page.getByRole('progressbar', { name: 'Exportfortschritt' }).waitFor()
await page.waitForFunction(() => document.querySelector('[role="status"][aria-live="polite"]')?.textContent.includes('vorbereitet'))
assert.equal(exportWorkers.size, 1, 'the job runs in its own worker')
await page.getByRole('button', { name: 'Abbrechen', exact: true }).click()
await page.waitForFunction(() => !document.querySelector('.export-dialog'))
await page.waitForTimeout(300)
assert.equal(exportWorkers.size, 0, 'cancelling ends the worker')
assert.equal(downloads, 0, 'no file after cancelling')
assert.equal(await page.evaluate(() => document.querySelector('.toolbar').inert), false)

// The next export works, and the page stayed responsive while it ran.
await openExport()
await page.getByRole('radio', { name: /Struktur optimieren/ }).check()
await page.evaluate(() => {
  window.__gap = 0
  window.__long = []
  new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__long.push(Math.round(entry.duration)) }).observe({ entryTypes: ['longtask'] })
})
await page.getByRole('button', { name: 'Export vorbereiten', exact: true }).click()
await page.getByRole('dialog', { name: 'Export vorbereitet' }).waitFor({ timeout: 120000 })
const gap = await page.evaluate(() => window.__gap)
console.log('Lange Aufgaben im Hauptthread (ms):', await page.evaluate(() => window.__long))
assert.ok(gap < 1000, `longest main thread stall ${Math.round(gap)} ms`)
await page.waitForTimeout(200)
assert.equal(exportWorkers.size, 0, 'a finished job ends its worker')
const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.export-primary').click()])
const task = getDocument({ data: new Uint8Array(readFileSync(await download.path())) })
const pdf = await task.promise
assert.equal(pdf.numPages, PAGES)
await task.destroy()

assert.deepEqual(errors, [])
assert.equal(logged.some(line => /Seite 1\b|%PDF/.test(line)), false, 'no document content in the console')
console.log(`PASS export worker: Abbruch, Neustart, längste Blockade ${Math.round(gap)} ms`)
await browser.close()
