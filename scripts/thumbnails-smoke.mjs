import { confirmDefaultExport } from './export-smoke-helper.mjs'
// T8: real PDF thumbnails, native HTML drag/drop, export and draft ordering.
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const out = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-thumbnails-'))
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), args: ['--no-sandbox'] })
const p = await browser.newPage({ viewport: { width: 1280, height: 1100 }, acceptDownloads: true }), errors = []
p.on('pageerror', e => errors.push(String(e)))
const btn = name => p.getByRole('button', { name, exact: true })
const ready = () => p.waitForFunction(() => document.querySelector('.page-manager-preview canvas')?.width > 0 && !document.querySelector('.page-manager-message')?.textContent.includes('aktualisiert'))
const rows = () => p.locator('.page-manager-row')
async function parsed(bytes) {
  return p.evaluate(async data => {
    const { getDocument, GlobalWorkerOptions } = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
    GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
    const task = getDocument({ data: new Uint8Array(data) }), doc = await task.promise, result = []
    for (let i = 1; i <= doc.numPages; i++) result.push((await (await doc.getPage(i)).getTextContent()).items.map(item => item.str).join(' '))
    await task.destroy(); return result
  }, Array.from(bytes))
}
async function exportOrder(file) {
  const pending = p.waitForEvent('download'); await btn('Exportieren').click(); await confirmDefaultExport(p); await (await pending).saveAs(join(out, file))
  return parsed(readFileSync(join(out, file)))
}
const thumbnailColor = canvas => canvas.evaluate(el => Array.from(el.getContext('2d').getImageData(5, 5, 1, 1).data).slice(0, 3))
try {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 80; i++) {
    const page = doc.addPage(i === 80 ? [792, 612] : [612, 792])
    page.drawRectangle({ x: 0, y: 0, width: page.getWidth(), height: page.getHeight(), color: i === 80 ? rgb(0, 0, 1) : rgb(1, 1, 1) })
    page.drawText(`Fixture ${i}`, { x: 40, y: page.getHeight() - 80, size: 20, font })
  }
  await p.goto(process.env.SMOKE_URL ?? 'http://localhost:5218')
  await p.locator('input[accept="application/pdf"]').setInputFiles({ name: 'long.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) })
  await p.waitForFunction(() => document.querySelector('.pages .page canvas')?.width > 0)
  await btn('T Text').click(); const first = await p.locator('.pages .page').first().boundingBox()
  await p.mouse.click(first.x + 100, first.y + 240); await p.locator('.textbox textarea').fill('Overlay on original page one'); await p.locator('.textbox textarea').press('Escape')
  await btn('Seiten verwalten').click(); await ready(); assert.equal(await rows().count(), 80)
  await p.waitForFunction(() => document.querySelector('.page-miniature canvas')?.width > 0)
  assert.ok(await p.locator('.page-miniature canvas').count() < 20, 'Offscreen pages must not all allocate thumbnail canvases')
  assert.match(await rows().first().locator('.textbox').textContent(), /Overlay on original page one/)
  await rows().nth(0).dragTo(rows().nth(2)); await ready()
  let text = await exportOrder('drag-down.pdf')
  assert.deepEqual(text.slice(0, 4).map(s => /Fixture \d+/.exec(s)[0]), ['Fixture 2', 'Fixture 3', 'Fixture 1', 'Fixture 4'])
  assert.ok(text[2].includes('Overlay on original page one')); assert.ok(!text[0].includes('Overlay on original page one'))
  await btn('Rückgängig').click(); await ready(); text = await exportOrder('undo.pdf'); assert.match(text[0], /Fixture 1\b/)
  await btn('Wiederholen').click(); await ready(); await rows().nth(2).dragTo(rows().nth(0)); await ready()
  text = await exportOrder('drag-up.pdf'); assert.deepEqual(text.slice(0, 3).map(s => /Fixture \d+/.exec(s)[0]), ['Fixture 1', 'Fixture 2', 'Fixture 3'])
  await rows().nth(0).dragTo(rows().nth(2)); await ready()
  // A foreign text drag cannot mutate page order.
  const foreign = await p.evaluateHandle(() => { const data = new DataTransfer(); data.setData('text/plain', 'foreign'); return data })
  await rows().nth(1).dispatchEvent('drop', { dataTransfer: foreign }); await foreign.dispose()
  const fixed = await p.locator('.page-manager-controls').boundingBox()
  await p.locator('.page-manager-list').evaluate(el => el.scrollTop = el.scrollHeight)
  await p.waitForFunction(() => document.querySelector('.page-manager-row:last-child .page-miniature canvas')?.width > 0)
  assert.equal((await p.locator('.page-manager-controls').boundingBox()).y, fixed.y)
  assert.ok(await p.locator('.page-miniature canvas').count() < 20)
  await p.waitForFunction(() => { const canvas = document.querySelector('.page-manager-row:last-child .page-miniature canvas'); return canvas?.width > 5 && canvas.getContext('2d').getImageData(5, 5, 1, 1).data[0] === 0 })
  assert.deepEqual(await thumbnailColor(rows().last().locator('.page-miniature canvas')), [0, 0, 255])
  const bounds = await rows().last().locator('.page-miniature canvas').boundingBox(); assert.ok(bounds.width > bounds.height, 'Landscape thumbnail must keep its aspect ratio')
  await rows().last().locator('.page-manager-select').click(); await ready()
  await btn('Speichern').click(); await p.waitForFunction(() => document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'))
  await p.reload(); await p.getByRole('button', { name: /Entwürfe/ }).click(); await p.locator('.draft-open').first().click(); await p.waitForFunction(() => document.querySelector('.pages .page canvas')?.width > 0)
  await btn('Seiten verwalten').click(); await ready(); text = await exportOrder('reopened.pdf'); assert.deepEqual(text.slice(0, 3).map(s => /Fixture \d+/.exec(s)[0]), ['Fixture 2', 'Fixture 3', 'Fixture 1']); assert.match(text[2], /Overlay on original page one/); assert.match(text[79], /Fixture 80\b/)
  await p.screenshot({ path: join(out, 'desktop.png') })
  await p.setViewportSize({ width: 390, height: 1000 }); await p.locator('.page-manager-list').evaluate(el => el.scrollTop = el.scrollHeight)
  await p.waitForFunction(() => document.querySelector('.page-manager-row:last-child .page-miniature canvas')?.width > 0)
  assert.ok(await p.locator('.page-miniature canvas').count() < 20)
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await p.screenshot({ path: join(out, 'mobile.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log('PASS T8: bounded 80-page thumbnail rendering, overlay/aspect/pixel fidelity, native drag up/down, external-drop rejection, export order and overlay attachment, undo/redo, saved draft reopening, desktop/mobile independent scroll; no page errors.')
} finally { await browser.close() }
