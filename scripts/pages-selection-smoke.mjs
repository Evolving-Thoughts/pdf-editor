import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
// Approved sidebar: independently scrollable list + checkbox/Shift/Ctrl selection.
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const out = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-selection-'))
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const p = await browser.newPage({ viewport: { width: 1280, height: 1100 }, acceptDownloads: true }), errors = []
p.on('pageerror', e => errors.push(String(e)))
const btn = name => p.getByRole('button', { name, exact: true })
const ready = () => p.waitForFunction(() => document.querySelector('.page-manager-preview canvas')?.width > 0 && !document.querySelector('.page-manager-message')?.textContent.includes('aktualisiert') && !document.querySelector('.page-manager-message')?.textContent.includes('verarbeitet'))
const title = (index, modifiers = []) => p.locator('.page-manager-select').nth(index - 1).click({ modifiers })
const checked = () => p.locator('.page-manager-check input').evaluateAll(inputs => inputs.flatMap((el, i) => el.checked ? [i + 1] : []))
async function rotationNames(count) {
  for (const direction of ['im', 'gegen den']) {
    const name = `${count} ${count === 1 ? 'Seite' : 'Seiten'} ${direction} Uhrzeigersinn drehen`
    assert.equal(await btn(name).count(), 1, `Accessible rotation name: ${name}`)
    assert.equal(await btn(name).isDisabled(), count === 0)
  }
}
const checkbox = index => p.getByRole('checkbox', { name: `Seite ${index} auswählen`, exact: true })
async function download(name, file) { const event = p.waitForEvent('download'); await btn(name).click(); if (name === 'Exportieren') await confirmDefaultExport(p); await (await event).saveAs(join(out, file)); return PDFDocument.load(readFileSync(join(out, file))) }
async function textPages(bytes) {
  return p.evaluate(async data => {
    const { getDocument, GlobalWorkerOptions } = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
    GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
    const task = getDocument({ data: new Uint8Array(data) }), doc = await task.promise, result = []
    for (let i = 1; i <= doc.numPages; i++) { const page = await doc.getPage(i); result.push({ text: (await page.getTextContent()).items.map(x => x.str).join(' '), widgets: (await page.getAnnotations()).filter(a => a.subtype === 'Widget').map(a => [a.fieldName, a.fieldValue]) }) }
    await task.destroy(); return result
  }, Array.from(bytes))
}
try {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica), field = doc.getForm().createTextField('shared')
  field.setText('Ada')
  for (let i = 1; i <= 32; i++) { const page = doc.addPage([612, 792]); page.drawText(`Fixture page ${i}`, { x: 30, y: 740, size: 18, font }); if ([2, 4, 32].includes(i)) field.addToPage(page, { x: 50, y: 600, width: 180, height: 24 }) }
  await p.goto(process.env.SMOKE_URL ?? 'http://localhost:5207')
  await p.locator('input[accept="application/pdf"]').setInputFiles({ name: 'many.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) })
  await p.waitForFunction(() => document.querySelector('.pages .page canvas')?.width > 0)
  await btn('Seiten verwalten').click(); await ready(); assert.equal(await p.locator('.page-manager-row').count(), 32)
  // T14 sidebar A: all nine actions remain; at least half the panel is list.
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 1280, height: 944 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
    { width: 320, height: 844 },
  ]) {
    await p.setViewportSize(viewport)
    await p.locator('.page-manager-panel').scrollIntoViewIfNeeded()
    const panel = await p.locator('.page-manager-panel').boundingBox()
    const list = await p.locator('.page-manager-list').boundingBox()
    assert.ok(list.height >= panel.height * 0.5,
      `At least 50% list height at ${viewport.width}×${viewport.height}: ${list.height}/${panel.height}`)
    const controls = p.locator('.page-manager-controls')
    assert.equal(await controls.getByRole('button').count(), 9)
    const gridButtons = p.locator('.page-manager-action-grid button')
    assert.equal(await gridButtons.count(), 6)
    const boxes = await gridButtons.evaluateAll(nodes => nodes.map(node => {
      const { x, y, width, height } = node.getBoundingClientRect()
      return { x, y, width, height }
    }))
    assert.ok(Math.abs(boxes[0].y - boxes[2].y) < 1, 'Three columns in first action row')
    assert.ok(boxes[3].y > boxes[0].y && Math.abs(boxes[3].y - boxes[5].y) < 1,
      'Three columns in second action row')
    for (const box of boxes) {
      assert.ok(box.height >= 44, 'Action buttons keep 44px targets')
      assert.ok(box.x >= panel.x && box.x + box.width <= panel.x + panel.width,
        'Action buttons stay within sidebar')
    }
    const fixedY = (await controls.boundingBox()).y
    await p.locator('.page-manager-list').evaluate(el => el.scrollTop = el.scrollHeight)
    assert.ok(await p.locator('.page-manager-list').evaluate(el => el.scrollTop) > 0)
    assert.equal((await controls.boundingBox()).y, fixedY)
    // Short panels may scroll controls, but every action must remain reachable.
    for (const button of await controls.getByRole('button').all()) {
      await button.scrollIntoViewIfNeeded()
      const box = await button.boundingBox(), frame = await controls.boundingBox()
      assert.ok(box.y >= frame.y - 1 && box.y + box.height <= frame.y + frame.height + 1,
        `Action can be reached: ${await button.innerText()}`)
    }
    await controls.evaluate(el => el.scrollTop = 0)
    await p.locator('.page-manager-list').evaluate(el => el.scrollTop = 0)
    await p.screenshot({ path: join(out, `sidebar-${viewport.width}.png`) })
  }
  await p.setViewportSize({ width: 1280, height: 1100 })
  await rotationNames(1)
  await title(2); assert.deepEqual(await checked(), [2])
  await title(4, ['Shift']); assert.deepEqual(await checked(), [2, 3, 4])
  await title(15, ['Control']); assert.deepEqual(await checked(), [2, 3, 4, 15])
  await title(3, ['Control']); assert.deepEqual(await checked(), [2, 4, 15])
  await title(20, ['Meta']); assert.deepEqual(await checked(), [2, 4, 15, 20]); await title(20, ['Control'])
  await title(21); await checkbox(24).click({ modifiers: ['Shift'] }); assert.deepEqual(await checked(), [21, 22, 23, 24])
  await title(26, ['Control', 'Shift']); assert.deepEqual(await checked(), [21, 22, 23, 24, 25, 26])
  await checkbox(30).click({ modifiers: ['Control'] }); assert.deepEqual(await checked(), [21, 22, 23, 24, 25, 26, 30])
  await title(2); await title(4, ['Shift']); assert.deepEqual(await checked(), [2, 3, 4])
  await rotationNames(3)
  assert.equal(await btn('Zuschneiden').isDisabled(), true)
  const fixed = await p.locator('.page-manager-controls').boundingBox()
  await p.locator('.page-manager-list').evaluate(el => el.scrollTop = el.scrollHeight)
  const scroll = await p.locator('.page-manager-list').evaluate(el => el.scrollTop)
  assert.ok(scroll > 1000); assert.equal((await p.locator('.page-manager-controls').boundingBox()).y, fixed.y)
  await btn('3 Seiten im Uhrzeigersinn drehen').click(); await ready()
  assert.equal(await p.locator('.page-manager-list').evaluate(el => el.scrollTop), scroll)
  let output = await download('Exportieren', 'rotated.pdf')
  assert.deepEqual(output.getPages().map(page => page.getRotation().angle), Array.from({ length: 32 }, (_, i) => [1, 2, 3].includes(i) ? 90 : 0))
  const subset = await download('Extrahieren', 'subset.pdf')
  assert.equal(subset.getPageCount(), 3); assert.equal(subset.getForm().getTextField('shared').acroField.getWidgets().length, 2)
  subset.getForm().getTextField('shared').setText('Grace')
  const parsed = await textPages(await subset.save())
  assert.deepEqual(parsed.map(page => /Fixture page \d+/.exec(page.text)[0]), ['Fixture page 2', 'Fixture page 3', 'Fixture page 4'])
  assert.deepEqual(parsed.flatMap(page => page.widgets), [['shared', 'Grace'], ['shared', 'Grace']])
  await btn('Rückgängig').click(); await ready(); output = await download('Exportieren', 'undone.pdf'); assert.ok(output.getPages().every(page => page.getRotation().angle === 0))
  await btn('Wiederholen').click(); await ready()
  await btn('3 Seiten löschen').click(); await p.keyboard.press('Escape'); assert.equal(await p.locator('.page-manager-row').count(), 32)
  await btn('3 Seiten löschen').click(); await btn('3 Seiten löschen').click(); await ready(); assert.equal(await p.locator('.page-manager-row').count(), 29); assert.deepEqual(await checked(), [])
  await btn('Rückgängig').click(); await ready(); assert.equal(await p.locator('.page-manager-row').count(), 32); assert.deepEqual(await checked(), [2, 3, 4])
  await btn('Seite 2 nach unten').click(); await ready(); assert.deepEqual(await checked(), [2, 3, 4])
  await title(3); await title(4, ['Shift']); assert.deepEqual(await checked(), [3, 4])
  await download('Extrahieren', 'reordered.pdf'); assert.deepEqual((await textPages(readFileSync(join(out, 'reordered.pdf')))).map(page => /Fixture page \d+/.exec(page.text)[0]), ['Fixture page 2', 'Fixture page 4'])
  await btn('Auswahl aufheben').click(); await rotationNames(0); assert.equal(await btn('Extrahieren').isDisabled(), true)
  await checkbox(32).focus(); await p.keyboard.press('Space'); assert.deepEqual(await checked(), [32]); assert.equal(await btn('Zuschneiden').isDisabled(), false)
  await p.screenshot({ path: join(out, 'desktop.png') })
  await p.setViewportSize({ width: 390, height: 1000 })
  await p.locator('.page-manager-panel').scrollIntoViewIfNeeded()
  const mobileFixed = await p.locator('.page-manager-controls').boundingBox()
  await p.locator('.page-manager-list').evaluate(el => el.scrollTop = 0)
  await p.locator('.page-manager-list').evaluate(el => el.scrollTop = el.scrollHeight)
  assert.equal((await p.locator('.page-manager-controls').boundingBox()).y, mobileFixed.y)
  for (const name of ['Zuschneiden', 'Extrahieren', 'Seite löschen']) { const bounds = await btn(name).boundingBox(); assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 1000, `${name} must remain visible`) }
  assert.ok(await p.locator('.page-manager-list').evaluate(el => el.scrollTop) > 1000)
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await p.screenshot({ path: join(out, 'mobile.png'), fullPage: true })
  await p.setViewportSize({ width: 1280, height: 1100 })
  await btn('Alle auswählen').click(); assert.equal((await checked()).length, 32); await rotationNames(32)
  await btn('32 Seiten löschen').click(); await btn('32 Seiten löschen').click(); await p.waitForSelector('.page-manager-empty')
  assert.equal(await btn('Exportieren').isDisabled(), true); assert.equal(await btn('Alle auswählen').isDisabled(), true)
  await btn('Rückgängig').click(); await ready(); assert.equal((await checked()).length, 32)
  output = await download('Exportieren', 'before-save.pdf'); const rotations = output.getPages().map(page => page.getRotation().angle)
  await btn('Speichern').click(); await p.waitForFunction(() => document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'))
  await p.reload(); await p.getByRole('button', { name: /Entwürfe/ }).click(); await p.locator('.draft-open').first().click(); await p.waitForFunction(() => document.querySelector('.pages .page canvas')?.width > 0)
  await btn('Seiten verwalten').click(); await ready(); output = await download('Exportieren', 'restored.pdf')
  assert.deepEqual(output.getPages().map(page => page.getRotation().angle), rotations); assert.equal(output.getForm().getTextField('shared').getText(), 'Ada')
  assert.deepEqual(errors, [])
  console.log('PASS 32-page PDF: independent desktop/mobile list scroll; Shift/Ctrl/Meta/checkbox selection, inclusive ranges/current order, keyboard; atomic rotate/delete undo/redo; confirmation/Escape/empty; multi-extraction with real text and edited native widgets parsed by PDF.js; durable drafts; no page errors.')
} finally { await browser.close() }
