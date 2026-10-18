import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
// Compare actual editor glyph pixels against exported PDF.js pixels after arrow nudges.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, PDFArray, PDFRawStream, StandardFonts, decodePDFRawStream } from 'pdf-lib'
const base = process.env.SMOKE_URL ?? 'http://localhost:5203'
const artifacts = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-editor-text-position-'))
mkdirSync(artifacts, { recursive: true })
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--no-sandbox'],
})
const errors = []
async function glyphBounds(page, image) {
  return page.evaluate(async (encoded) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + encoded
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let left = Infinity,
      top = Infinity,
      right = -1,
      bottom = -1
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        if (d[i] < 200 && d[i + 1] < 200 && d[i + 2] < 200) {
          left = Math.min(left, x)
          top = Math.min(top, y)
          right = Math.max(right, x)
          bottom = Math.max(bottom, y)
        }
      }
    return { left, top, right, bottom }
  }, image.toString('base64'))
}
async function capture(page, name, zoom = 1, top = 360) {
  const r = await page.locator('.page').boundingBox()
  return page.screenshot({
    path: join(artifacts, name),
    clip: { x: r.x + 175 * zoom, y: r.y + top * zoom, width: 220 * zoom, height: 80 * zoom },
  })
}
const cases = [
  { name: 'two-textboxes', font: 'helvetica', zoom: 1, second: true, text: 'testtesttesta asfasf' },
  { name: 'two-textboxes-75', font: 'helvetica', zoom: 0.75, second: true, text: 'testtesttesta asfasf' },
  { name: 'two-textboxes-125', font: 'helvetica', zoom: 1.25, second: true, text: 'testtesttesta asfasf' },
  { name: 'fractional-small', font: 'helvetica', zoom: 1, size: 9.3, text: 'testtesttesta asfasf' },
  { name: 'fractional-large', font: 'helvetica', zoom: 1, size: 13.7, text: 'testtesttesta asfasf' },
  { name: 'helvetica', font: 'helvetica', zoom: 1 },
  { name: 'zoom-half', font: 'helvetica', zoom: 0.5 },
  { name: 'zoom-double', font: 'helvetica', zoom: 2 },
  { name: 'times', font: 'times', zoom: 1 },
  { name: 'courier', font: 'courier', zoom: 1 },
  { name: 'noto-sans-False-False', font: 'noto-sans', zoom: 1, bold: false, italic: false },
  { name: 'noto-sans-True-False', font: 'noto-sans', zoom: 1, bold: true, italic: false },
  { name: 'noto-sans-False-True', font: 'noto-sans', zoom: 1, bold: false, italic: true },
  { name: 'noto-sans-True-True', font: 'noto-sans', zoom: 1, bold: true, italic: true },
  { name: 'noto-serif-False-False', font: 'noto-serif', zoom: 1, bold: false, italic: false },
  { name: 'noto-serif-True-False', font: 'noto-serif', zoom: 1, bold: true, italic: false },
  { name: 'noto-serif-False-True', font: 'noto-serif', zoom: 1, bold: false, italic: true },
  { name: 'noto-serif-True-True', font: 'noto-serif', zoom: 1, bold: true, italic: true },
  { name: 'bold-italic', font: 'helvetica', zoom: 1, bold: true, italic: true },
  { name: 'multiline', font: 'helvetica', zoom: 1, text: 'HgE Korrektur\nHgE zweite Zeile' },
  {
    name: 'underline-multiline',
    font: 'helvetica',
    zoom: 1,
    text: 'HgE Korrektur\nHgE zweite Zeile',
    underline: true,
  },
]
try {
  for (const test of cases) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1400 }, acceptDownloads: true })
    page.on('pageerror', (e) => errors.push(String(e)))
    const pdf = await PDFDocument.create()
    const sheet = pdf.addPage([600, 800]),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    sheet.drawText('Originaltext', { x: 190, y: 400, size: 16, font })
    await page.goto(base)
    await page.locator('input[accept="application/pdf"]').setInputFiles({
      name: 'position.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    })
    await page.waitForFunction(() => document.querySelector('.page canvas')?.width > 0)
    await page.getByRole('button', { name: 'Rechteck', exact: true }).click()
    const area = await page.locator('.page').boundingBox()
    await page.mouse.move(area.x + 180, area.y + 360)
    await page.mouse.down()
    await page.mouse.move(area.x + 380, area.y + 440)
    await page.mouse.up()
    await page.waitForSelector('.shape-toolbar')
    await page.getByRole('button', { name: 'Füllung: Weiß', exact: true }).click()
    await page.getByRole('button', { name: 'Kontur: Keine Kontur', exact: true }).click()
    await page.getByRole('button', { name: 'T Text', exact: true }).click()
    await page.mouse.click(area.x + 200, area.y + 400)
    await page.locator('.textbox textarea').fill(test.text ?? 'HgE Korrektur')
    await page.locator('.textbox textarea').press('Escape')
    if (test.size) {
      await page.getByRole('button', { name: 'Schriftgröße', exact: true }).click()
      const picker = page.getByRole('textbox', { name: 'Schriftgröße eingeben', exact: true })
      await picker.fill(String(test.size))
      await picker.press('Enter')
    }
    await page.getByRole('combobox', { name: 'Schriftart', exact: true }).selectOption(test.font)
    if (test.bold) await page.getByRole('button', { name: 'Fett', exact: true }).click()
    if (test.italic) await page.getByRole('button', { name: 'Kursiv', exact: true }).click()
    if (test.underline) await page.getByRole('button', { name: 'Unterstrichen', exact: true }).click()
    for (let i = 0; i < Math.abs(test.zoom - 1) / 0.25; i++)
      await page.getByRole('button', { name: test.zoom < 1 ? '−' : '+', exact: true }).click()
    await page.waitForFunction(
      (zoom) => document.querySelector('.page canvas')?.width === 600 * zoom,
      test.zoom,
    )
    await page.getByRole('button', { name: '⬚ Auswahl', exact: true }).click()
    await page.locator('.textbox .drag-surface').click()
    if (test.second) {
      await page.getByRole('button', { name: 'T Text', exact: true }).click()
      const currentArea = await page.locator('.page').boundingBox()
      await page.mouse.click(currentArea.x + 200 * test.zoom, currentArea.y + 250 * test.zoom)
      await page.locator('.textbox textarea').last().fill('test')
      await page.locator('.textbox textarea').last().press('Escape')
      await page.getByRole('button', { name: '⬚ Auswahl', exact: true }).click()
      await page.locator('.textbox .drag-surface').first().click()
    }
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(100) // Font completion remeasures the textarea baseline.
    // Only glyph paint is compared; the edit minibar is outside document content.
    await page.addStyleTag({ content: '.minibar { visibility: hidden; }' })
    const before = await glyphBounds(page, await capture(page, test.name + '-editor-before.png', test.zoom))
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp')
    const editor = await glyphBounds(page, await capture(page, test.name + '-editor-after.png', test.zoom))
    assert.ok(Math.abs(editor.left - before.left - 10 * test.zoom) <= 1)
    assert.ok(Math.abs(editor.top - before.top + 5 * test.zoom) <= 1)
    await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
    assert.deepEqual(await glyphBounds(page, await capture(page, test.name + '-undo.png', test.zoom)), before)
    await page.getByRole('button', { name: 'Wiederholen', exact: true }).click()
    assert.deepEqual(await glyphBounds(page, await capture(page, test.name + '-redo.png', test.zoom)), editor)
    // Check the native CSS baseline, independently of the implementation's probe.
    const delta = await page
      .locator('.textbox textarea')
      .first()
      .evaluate((el, zoom) => {
        const css = getComputedStyle(el)
        const line = document.createElement('div')
        line.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${css.font};line-height:${css.lineHeight}`
        const marker = document.createElement('span')
        marker.style.cssText =
          'display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline'
        line.append('Mg', marker)
        document.body.append(line)
        const baseline = marker.getBoundingClientRect().top - line.getBoundingClientRect().top
        line.remove()
        const renderedBaseline =
          el.getBoundingClientRect().top +
          parseFloat(css.paddingTop) +
          parseFloat(css.borderTopWidth) +
          baseline
        const expected = document.querySelector('.page').getBoundingClientRect().top + 395 * zoom
        return renderedBaseline - expected
      }, test.zoom)
    assert.ok(
      Math.abs(delta) <= 1 / 64,
      `native CSS baseline differs from stored/exported baseline by ${delta}px`,
    )
    if (test.second) await page.locator('.textbox .drag-surface').last().click()
    const live = await glyphBounds(page, await capture(page, test.name + '-live.png', test.zoom))
    assert.deepEqual(live, editor, 'deselecting must not shift the lower correction')
    const upper = test.second
      ? await glyphBounds(page, await capture(page, test.name + '-upper-editor.png', test.zoom, 210))
      : null
    if (test.second) await page.screenshot({ path: join(artifacts, test.name + '-scene.png') })
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Exportieren', exact: true }).click(); await confirmDefaultExport(page)
    const output = join(artifacts, test.name + '-nudged.pdf')
    await (await pending).saveAs(output)
    const parsed = await PDFDocument.load(readFileSync(output)),
      value = parsed.getPage(0).node.Contents(),
      stream = (value instanceof PDFArray ? value.asArray() : [value])
        .map((ref) =>
          new TextDecoder().decode(decodePDFRawStream(parsed.context.lookup(ref, PDFRawStream)).decode()),
        )
        .join('\n')
    assert.match(
      stream,
      /1 0 0 1 210 405 Tm/,
      'export contains the nudged model baseline, not the old coordinates',
    )
    await page.locator('input[accept="application/pdf"]').setInputFiles({
      name: 'baked-position.pdf',
      mimeType: 'application/pdf',
      buffer: readFileSync(output),
    })
    await page.getByText('baked-position.pdf · 1 Seite', { exact: true }).waitFor()
    await page.waitForFunction((zoom) => {
      const c = document.querySelector('.page canvas')
      if (!c?.width || c.dataset.renderState !== 'ready') return false
      const d = c.getContext('2d').getImageData(200 * zoom, 380 * zoom, 150 * zoom, 60 * zoom).data
      return d.some((v, i) => i % 4 !== 3 && v < 100)
    }, test.zoom)
    const baked = await glyphBounds(page, await capture(page, test.name + '-export-after.png', test.zoom))
    console.log(test.name, { before, editor, baked })
    assert.ok(
      Math.abs(editor.left - baked.left) <= 1,
      `editor/export x differs: ${editor.left} vs ${baked.left}`,
    )
    assert.ok(
      Math.abs(editor.bottom - baked.bottom) <= 1,
      `editor/export baseline differs: ${editor.bottom} vs ${baked.bottom}`,
    )
    if (upper) {
      assert.match(stream, /1 0 0 1 200 550 Tm/, 'the upper textbox keeps its own baseline')
      const upperBaked = await glyphBounds(
        page,
        await capture(page, test.name + '-upper-export.png', test.zoom, 210),
      )
      assert.ok(Math.abs(upper.left - upperBaked.left) <= 1, 'upper textbox x remains aligned')
      assert.ok(Math.abs(upper.bottom - upperBaked.bottom) <= 1, 'upper textbox baseline remains aligned')
    }
    await page.waitForTimeout(800)
    await page.reload()
    await page.getByRole('button', { name: /Entwürfe/ }).click()
    await page
      .getByRole('button', { name: /^position\.pdf/ })
      .first()
      .click()
    await page.waitForSelector('.textbox')
    for (let i = 0; i < Math.abs(test.zoom - 1) / 0.25; i++)
      await page.getByRole('button', { name: test.zoom < 1 ? '−' : '+', exact: true }).click()
    await page.waitForFunction(
      (zoom) => document.querySelector('.page canvas')?.width === 600 * zoom,
      test.zoom,
    )
    assert.deepEqual(
      await glyphBounds(page, await capture(page, test.name + '-restored.png', test.zoom)),
      editor,
    )
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log('PASS actual correction glyphs, nudges, undo/redo, drafts, zoom, fonts and multiline export')
} finally {
  await browser.close()
}
