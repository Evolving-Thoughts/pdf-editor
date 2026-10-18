// Regression coverage for the Notion Bugs ticket: normal row selection and crop fit/scale.
import { chromium } from 'playwright'
import { PDFDocument } from 'pdf-lib'
import { chromiumPath } from './browser-helper.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-bugs-'))
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
const p = await browser.newPage({ acceptDownloads: true }), errors = []
p.on('pageerror', e => errors.push(String(e)))
const button = name => p.getByRole('button', { name, exact: true })
const mm = 72 / 25.4
async function ready() {
  const state = await p.evaluateHandle(() => ({ snapshot: null, frames: 0 }))
  try {
    await p.waitForFunction(({ state, viewport }) => {
      const snapshot = () => {
        if (innerWidth !== viewport.width || innerHeight !== viewport.height) return null
        const preview = document.querySelector('.page-manager-preview')
        const paper = preview?.querySelector('.page-preview-paper')
        const canvas = paper?.querySelector('canvas')
        if (!paper || !canvas || canvas.dataset.renderState !== 'ready' ||
            preview.querySelector('[role="status"]') || document.querySelector('header')?.inert) return null
        const style = getComputedStyle(preview)
        const contentWidth = preview.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        const contentHeight = preview.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
        // Wait until the fit calculation has consumed this viewport's observer
        // measurement, including after mounting/restoring a draft.
        const fitWidth = Number(preview.dataset.fitWidth), fitHeight = Number(preview.dataset.fitHeight)
        if (!Number.isFinite(fitWidth) || !Number.isFinite(fitHeight) ||
            Math.abs(fitWidth - contentWidth) >= 1 || Math.abs(fitHeight - contentHeight) >= 1) return null
        const bounds = paper.getBoundingClientRect(), raster = canvas.getBoundingClientRect()
        if (Math.abs(bounds.width - raster.width) >= 1 || Math.abs(bounds.height - raster.height) >= 1) return null
        return JSON.stringify([bounds.width, bounds.height, canvas.width, canvas.height, preview.clientWidth, preview.clientHeight])
      }
      const current = snapshot()
      // ResizeObserver, React layout and PDF.js rendering complete independently.
      // Do not accept a previously allocated canvas or a single transient frame.
      if (!current || current !== state.snapshot) {
        state.snapshot = current
        state.frames = 0
        return false
      }
      return ++state.frames >= 3
    }, { state, viewport: p.viewportSize() })
  } finally { await state.dispose() }
}
try {
  const doc = await PDFDocument.create()
  doc.addPage([210 * mm, 297 * mm]); doc.addPage([210 * mm, 297 * mm])
  await p.goto(process.env.SMOKE_URL ?? 'http://localhost:5207')
  await p.locator('input[accept="application/pdf"]').setInputFiles({ name: 'a4.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) })
  await p.waitForFunction(() => document.querySelector('.pages .page canvas')?.width > 0)
  await button('Seiten verwalten').click(); await ready()
  await p.locator('.page-manager-select').nth(1).click()
  assert.equal(await p.getByRole('checkbox', { name: 'Seite 2 auswählen', exact: true }).isChecked(), true)
  assert.equal(await p.getByRole('checkbox', { name: 'Seite 1 auswählen', exact: true }).isChecked(), false)
  assert.equal(await button('Zuschneiden').isDisabled(), false)
  // Leave only one page: another full-size page would conceal a fit-scale regression.
  await p.locator('.page-manager-select').first().click()
  await button('Seite löschen').click(); await button('1 Seite löschen').click(); await ready()
  await p.locator('.page-manager-select').first().click()
  assert.equal(await p.locator('.page-manager-row').count(), 1)
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1024, height: 600 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await p.setViewportSize(viewport); await ready()
    await button('Zuschneiden').click()
    await p.waitForSelector('.page-manager.cropping')
    const gripStyle = await p.locator('.page-crop-grip').first().evaluate(el => ({ target: el.getBoundingClientRect().width, visible: getComputedStyle(el, '::after').width }))
    assert.equal(gripStyle.visible, '8px'); assert.ok(gripStyle.target >= 44)
    const controls = await p.locator('.page-manager-controls').boundingBox()
    const apply = await button('Zuschnitt anwenden').boundingBox()
    assert.ok(apply.y >= controls.y && apply.y + apply.height <= controls.y + controls.height + 1,
      `Crop confirmation is visible without scrolling controls at ${viewport.width}×${viewport.height}`)
    assert.ok(apply.y >= 0 && apply.y + apply.height <= viewport.height,
      `Crop confirmation is inside viewport at ${viewport.width}×${viewport.height}`)
    assert.equal(await p.locator('.page-manager-controls').evaluate(el => el.scrollTop), 0)
    await p.screenshot({ path: join(out, `crop-${viewport.width}.png`) })
    await button('Abbrechen').click()
  }
  await p.setViewportSize({ width: 1280, height: 900 }); await ready()
  const before = await p.locator('.page-preview-paper').boundingBox()
  await button('Zuschneiden').click()
  await p.getByLabel('Oben · mm', { exact: true }).fill('99')
  await button('Zuschnitt anwenden').click(); await ready()
  const after = await p.locator('.page-preview-paper').boundingBox()
  assert.ok(Math.abs(after.width - before.width) < 1, `Top crop does not visually enlarge width: before=${before.width}, after=${after.width}`)
  assert.ok(Math.abs(after.height / before.height - 2 / 3) < 0.005, `Top crop preserves height ratio: before=${before.height}, after=${after.height}`)
  const event = p.waitForEvent('download'); await button('Extrahieren').click()
  const path = join(out, 'crop.pdf'); await (await event).saveAs(path)
  const exported = await PDFDocument.load(readFileSync(path)), box = exported.getPage(0).getCropBox()
  assert.ok(Math.abs(box.width / mm - 210) < 0.01, 'Export stays 210 mm wide')
  assert.ok(Math.abs(box.height / mm - 198) < 0.01)
  await button('Rückgängig').click(); await ready()
  assert.ok(Math.abs((await p.locator('.page-preview-paper').boundingBox()).height - before.height) < 1)
  await button('Wiederholen').click(); await ready()
  await button('Speichern').click()
  await p.waitForFunction(() => document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'))
  await p.reload(); await p.getByRole('button', { name: /Entwürfe/ }).click()
  await p.locator('.draft-open').first().click()
  await p.waitForFunction(() => document.querySelector('.pages .page canvas')?.width > 0)
  await button('Seiten verwalten').click(); await ready()
  assert.ok(Math.abs((await p.locator('.page-preview-paper').boundingBox()).width - before.width) < 1, 'Draft reload preserves preview scale')
  assert.deepEqual(errors, [])
  console.log('PASS normal click selects the focused page; crop confirmation fits desktop/mobile without scrolling; top-third crop keeps preview scale and exported 210mm width; undo restores height.')
} finally { await browser.close() }
