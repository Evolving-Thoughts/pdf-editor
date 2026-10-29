// Optional local real fixture: SOURCE_TEXT_PDF, SOURCE_TEXT_FIND and
// SOURCE_TEXT_REPLACE. No supplied document or extracted fonts enter the repo.
import { chromium } from 'playwright'
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { applyButton, caret, checkInPdf, fit, inlineInput } from './source-inline-helper.mjs'
const real = process.env.SOURCE_TEXT_PDF,
  find = process.env.SOURCE_TEXT_FIND ?? 'small typo',
  replacement = process.env.SOURCE_TEXT_REPLACE ?? 'fixed typo'
const artifacts = process.env.SMOKE_ARTIFACT_DIR ?? '/tmp/pdf-editor-mixed-text'
mkdirSync(artifacts, { recursive: true })
async function fixture() {
  const d = await PDFDocument.create(),
    p = d.addPage([600, 800]),
    f = await d.embedFont(StandardFonts.Helvetica),
    n = PDFName.of
  p.node.set(n('Resources'), d.context.obj({ Font: { F1: f.ref } }))
  p.node.set(
    n('Contents'),
    d.context.register(
      d.context.flateStream(
        '/Span << /MCID 0 /Lang (de) >> BDC q BT /F1 12 Tf 1 0 0 1 60 700 Tm [(A small typo) 5 ( here)] TJ 0 -50 Td (Following paragraph stays fixed.) Tj ET Q EMC 300 500 20 20 re f',
      ),
    ),
  )
  d.catalog.set(
    n('StructTreeRoot'),
    d.context.obj({ Type: 'StructTreeRoot', K: [] }),
  )
  p.node.set(n('StructParents'), d.context.obj(0))
  const other = d.addPage([600, 800])
  other.node.set(
    n('Contents'),
    d.context.register(d.context.flateStream('unsupportedPaint')),
  )
  return Buffer.from(await d.save())
}
const bytes = real ? readFileSync(real) : await fixture(),
  sourceDoc = await PDFDocument.load(bytes),
  index = real ? sourceDoc.getPageCount() - 1 : 0
const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ['--no-sandbox'],
  }),
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  }),
  errors = []
page.on('pageerror', (e) => errors.push(String(e)))
try {
  await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5237')
  await page
    .locator('input[accept="application/pdf"]')
    .setInputFiles({
      name: 'local-source.pdf',
      mimeType: 'application/pdf',
      buffer: bytes,
    })
  await page
    .locator('.page canvas[data-render-state="ready"]')
    .first()
    .waitFor()
  await page
    .getByRole('button', { name: 'Originaltext korrigieren', exact: true })
    .click()
  if (index) await page.getByRole('button', { name: `Seite ${index + 1} anzeigen`, exact: true }).click()
  await page.locator('.source-run-hit').first().waitFor()
  const target = page.locator('.source-run-hit').filter({ hasText: find }).first()
  assert.equal(await target.count(), 1, 'source typo can be selected directly')
  await target.scrollIntoViewIfNeeded()
  const original = await target.textContent(), from = original.indexOf(find)
  const a = await target.locator('span').nth(from).boundingBox(), b = await target.locator('span').nth(from + find.length - 1).boundingBox()
  await page.mouse.move(a.x + .05, a.y + a.height * .55)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width - .05, b.y + b.height * .55, { steps: 15 })
  await page.mouse.up()
  // The drag opens the inline editor with exactly the marked characters selected.
  await page.locator('.source-inline').waitFor()
  const text = await inlineInput(page).inputValue(), [s0, s1] = await caret(page)
  assert.equal(text.slice(s0, s1), find, 'mixed-font/TJ source selection marks the exact substring')
  await page.keyboard.insertText(replacement)
  assert.equal(await inlineInput(page).inputValue(), text.slice(0, s0) + replacement + text.slice(s1))
  assert.match(await fit(page), /^Passt/)
  await checkInPdf(page)
  await page.screenshot({ path: artifacts + '/mixed-preview.png', fullPage: true })
  await applyButton(page).click()
  await page
    .locator('.page canvas[data-render-state="ready"]')
    .first()
    .waitFor()
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Exportieren', exact: true }).click()
  await confirmDefaultExport(page)
  const download = await pending,
    output = readFileSync(await download.path())
  const task = getDocument({
    data: Uint8Array.from(output),
    standardFontDataUrl:
      resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
  })
  try {
    const d = await task.promise,
      items = (
        await (await d.getPage(index + 1)).getTextContent()
      ).items.filter((x) => 'str' in x),
      text = items.map((x) => x.str).join('')
    assert.ok(text.includes(replacement))
    assert.ok(!text.includes(find))
    assert.equal(d.numPages, sourceDoc.getPageCount())
  } finally {
    await task.destroy()
  }
  assert.deepEqual(errors, [])
  console.log(
    'PASS mixed original text: selected page, tagged/TJ source, inline editor, real worker check, apply and independently read export' +
      (real ? ' (local supplied PDF)' : ''),
  )
} catch (error) {
  console.error('Browser errors:', errors)
  console.error((await page.locator('body').innerText()).slice(-1400))
  await page.screenshot({
    path: artifacts + '/mixed-failure.png',
    fullPage: true,
  })
  throw error
} finally {
  await browser.close()
}
