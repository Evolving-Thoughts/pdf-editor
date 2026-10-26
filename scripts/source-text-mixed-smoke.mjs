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
  if (index)
    await page.getByLabel('Seite', { exact: true }).selectOption({ index })
  await page.waitForFunction(
    () => !document.querySelector('#source-run')?.disabled,
  )
  const options = await page
      .locator('#source-run option')
      .evaluateAll((list) =>
        list.map((o) => ({ value: o.value, text: o.textContent })),
      ),
    target = options.find((o) => o.text.includes(find))
  assert.ok(
    target,
    'source typo is offered, not rejected as an entire document',
  )
  await page
    .getByLabel('Textstelle', { exact: true })
    .selectOption(target.value)
  const old = await page.getByLabel('Ersatztext', { exact: true }).inputValue(),
    updated = old.replace(find, replacement)
  await page.getByLabel('Ersatztext', { exact: true }).fill(updated)
  await page
    .getByRole('button', { name: 'PDF-Vorschau erzeugen', exact: true })
    .click()
  await page
    .getByText(
      'PDF-Vorschau bereit. Absatz und Übergang zum Folgeabsatz prüfen.',
      { exact: true },
    )
    .waitFor()
  await page
    .locator('.source-pdf-preview canvas[data-render-state="ready"]')
    .waitFor()
  await page
    .getByRole('checkbox', { name: /Absatz, Abstände und Übergang/ })
    .check()
  await page.screenshot({
    path: artifacts + '/mixed-preview.png',
    fullPage: true,
  })
  await page
    .getByRole('button', { name: 'Korrektur übernehmen', exact: true })
    .click()
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
    'PASS mixed original text: selected page, tagged/TJ source, real worker/candidate, explicit review, apply and independently read export' +
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
