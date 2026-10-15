// Real public blank forms; scan/encryption are explicitly labelled derivatives.
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
import { chromium } from 'playwright'
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFDocument as ProtectedDocument } from '@cantoo/pdf-lib'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const out = process.env.SMOKE_ARTIFACT_DIR ?? 'qa-artifacts/mvp-real-smoke'
mkdirSync(out, { recursive: true })
const fixtures = JSON.parse(
  readFileSync(new URL('./real-fixtures.json', import.meta.url), 'utf8'),
).fixtures
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--no-sandbox'],
})
const context = await browser.newContext({
  viewport: { width: 1280, height: 1100 },
  acceptDownloads: true,
})
let p = await context.newPage()
const errors = []
const listen = (page) => page.on('pageerror', (e) => errors.push(String(e)))
listen(p)
const url = process.env.SMOKE_URL ?? 'http://127.0.0.1:5234'
const btn = (name) => p.getByRole('button', { name, exact: true })
async function open(bytes, name) {
  if (bytes.length > 50 * 1024 * 1024) {
    // Playwright forbids >50 MiB inline payloads; exercise an actual local file.
    const file = join(out, name)
    writeFileSync(file, bytes)
    await p.locator('input[accept="application/pdf"]').setInputFiles(file)
  } else {
    await p
      .locator('input[accept="application/pdf"]')
      .setInputFiles({
        name,
        mimeType: 'application/pdf',
        buffer: Buffer.from(bytes),
      })
  }
  await p
    .getByText(
      new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' · '),
    )
    .waitFor()
  await p.waitForFunction(() => !document.querySelector('.toolbar')?.inert)
  await p.waitForFunction(
    () => document.querySelector('.pages .page canvas')?.width > 0,
  )
}
async function exportTo(file) {
  const event = p.waitForEvent('download')
  await btn('Exportieren').click()
  await confirmDefaultExport(p)
  const path = join(out, file)
  await (await event).saveAs(path)
  return PDFDocument.load(readFileSync(path), { updateMetadata: false })
}
async function textOf(doc) {
  // Independent parser works for dev AND production; no dev-only browser import.
  const task = getDocument({
    data: await doc.save({ updateFieldAppearances: false }),
  })
  const pdf = await task.promise,
    pages = []
  try {
    for (let i = 1; i <= pdf.numPages; i++)
      pages.push(
        (await (await pdf.getPage(i)).getTextContent()).items
          .map((x) => x.str)
          .join(' '),
      )
  } finally {
    await task.destroy()
  }
  return pages
}

try {
  await p.goto(url)
  for (const fixture of fixtures) {
    const source = readFileSync(
      new URL(`../tests/fixtures/real/${fixture.file}`, import.meta.url),
    )
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      fixture.sha256,
      'Pinned real fixture; run npm run fixtures:real first',
    )
    await open(source, fixture.file)
    if (fixture.file !== 'dod_character.pdf') {
      // The public German form is permission-encrypted with an empty password
      // AND has XFA. Do not call upstream getForm(): that would strip XFA in the checker.
      assert.equal(await p.locator('.password-dialog').count(), 0)
      await p
        .getByText(
          /Nicht unterstützte Formularfelder bleiben unverändert: XFA-Formular/,
        )
        .waitFor()
      assert.equal(
        await p.locator('.pages input[type=text], .pages textarea').count(),
        0,
      )
      const output = await exportTo(`${fixture.file}-preserved.pdf`)
      assert.equal(output.getPageCount(), fixture.file === 'kg1.pdf' ? 5 : 6)
      assert.ok(
        output.catalog
          .lookupMaybe(PDFName.of('AcroForm'), PDFDict)
          ?.has(PDFName.of('XFA')),
      )
      assert.equal(
        createHash('sha256').update(source).digest('hex'),
        fixture.sha256,
      )
      console.log(
        `PASS real ${fixture.file}: XFA limitation disclosed; pages/XFA retained on unchanged export`,
      )
      continue
    }
    const before = await PDFDocument.load(source, { updateMetadata: false })
    const field = p.locator('.pages input[type=text], .pages textarea').first()
    await field.waitFor()
    const label = await field.getAttribute('aria-label')
    assert.ok(label, 'Native field has accessible name')
    await field.fill('MVP REAL FORM')
    await field.press('Tab')
    const exported = await exportTo(`${fixture.file}-edited.pdf`)
    assert.equal(exported.getPageCount(), before.getPageCount())
    assert.equal(
      exported.getForm().getFields().length,
      before.getForm().getFields().length,
    )
    const edited = exported
      .getForm()
      .getFields()
      .find((f) => f.getText?.() === 'MVP REAL FORM')
    assert.ok(edited, `Real ${fixture.file} native value survives`)
    edited.setText('EDITED IN SECOND READER')
    const reopened = await PDFDocument.load(await exported.save())
    assert.equal(
      reopened.getForm().getTextField(edited.getName()).getText(),
      'EDITED IN SECOND READER',
    )
    await btn('Speichern').click()
    await p.waitForFunction(() =>
      document
        .querySelector('.draft-save-status')
        ?.textContent.includes('Entwurf gespeichert'),
    )
    // Close the actual tab, retaining only browser storage. No React/store memory survives.
    await p.close()
    p = await context.newPage()
    listen(p)
    await p.goto(url)
    await p.getByRole('button', { name: /Entwürfe/ }).click()
    await p
      .locator('.draft-open')
      .filter({ hasText: fixture.file })
      .first()
      .click()
    await p
      .locator('.pages input[type=text], .pages textarea')
      .first()
      .waitFor()
    assert.equal(
      await p
        .locator('.pages input[type=text], .pages textarea')
        .first()
        .inputValue(),
      'MVP REAL FORM',
    )
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      fixture.sha256,
    )
    console.log(
      `PASS real blank form ${fixture.file}: native edit/export/second edit/fresh-tab draft/original hash`,
    )
  }
  // Scan-style derivative of real character-sheet page 1, generated from rendered pixels only.
  const scan = await PDFDocument.create()
  const canvas = p.locator('.pages .page canvas').first()
  const pixels = await canvas.evaluate((c) => ({
    url: c.toDataURL('image/png'),
    width: c.width,
    height: c.height,
  }))
  const image = await scan.embedPng(pixels.url)
  const page = scan.addPage([612, 792])
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 })
  const scanBytes = await scan.save()
  writeFileSync(join(out, 'derived-character-scan.pdf'), scanBytes)
  await open(scanBytes, 'derived-character-scan.pdf')
  assert.deepEqual(
    await textOf(scan),
    [''],
    'No OCR invented for image-only scan',
  )
  assert.equal(await p.locator('.pages input[type=text]').count(), 0)
  await btn('T Text').click()
  await p
    .locator('.pages .page')
    .first()
    .click({ position: { x: 100, y: 700 } })
  await p.locator('.textbox textarea').fill('SCAN OVERLAY SEARCHABLE')
  await p.keyboard.press('Escape')
  const scanOut = await exportTo('scan-with-text.pdf')
  assert.ok((await textOf(scanOut))[0].includes('SCAN OVERLAY SEARCHABLE'))
  // Large *valid* document: put padding before final EOF, preserving xref offsets.
  const end = Buffer.from(scanBytes).lastIndexOf('%%EOF')
  assert.ok(end > 0)
  const large = Buffer.concat([
    Buffer.from(scanBytes).subarray(0, end),
    Buffer.alloc(51 * 1024 * 1024, 32),
    Buffer.from(scanBytes).subarray(end),
  ])
  await open(large, 'large-valid.pdf')
  await p.getByText(/Große Datei \(über 50 MB\)/).waitFor()
  assert.ok(await btn('Exportieren').isEnabled())
  console.log(
    'PASS image-only real-form derivative: overlay searchable; >50 MiB valid input warns without crash',
  )
  const protectedDoc = await ProtectedDocument.load(
    readFileSync(
      new URL('../tests/fixtures/real/dod_character.pdf', import.meta.url),
    ),
  )
  protectedDoc.encrypt({
    userPassword: 'fixture-only',
    ownerPassword: 'fixture-only',
    algorithm: 'AES-256',
  })
  const protectedBytes = await protectedDoc.save({
    updateFieldAppearances: false,
  })
  writeFileSync(join(out, 'derived-character-encrypted.pdf'), protectedBytes)
  await p.locator('input[accept="application/pdf"]').setInputFiles({
    name: 'derived-character-encrypted.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(protectedBytes),
  })
  const dialog = p.locator('.password-dialog')
  await dialog.waitFor()
  assert.match(
    await dialog.locator('.password-warning').innerText(),
    /Mit Passwort schützen/,
  )
  await dialog.locator('input[type=password]').fill('wrong')
  await dialog.getByRole('button', { name: 'PDF öffnen', exact: true }).click()
  await dialog.getByText(/Passwort ist falsch/).waitFor()
  await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click()
  assert.ok(
    await p.getByText('large-valid.pdf · 1 Seite', { exact: true }).count(),
  )
  await p.locator('input[accept="application/pdf"]').setInputFiles({
    name: 'derived-character-encrypted.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(protectedBytes),
  })
  await dialog.waitFor()
  await dialog.locator('input[type=password]').fill('fixture-only')
  await dialog.getByRole('button', { name: 'PDF öffnen', exact: true }).click()
  await p.locator('.pages input[type=text]').first().waitFor()
  const unlocked = await exportTo('character-unlocked.pdf')
  assert.equal(unlocked.getPageCount(), 1)
  assert.equal(unlocked.getForm().getFields().length, 14)
  assert.deepEqual(errors, [])
  console.log(
    'PASS AES-256 derivative: wrong password/cancel preserve current doc; correct unlock/export keeps 14 fields / 16 widgets; no page errors',
  )
} catch (error) {
  await p
    .screenshot({ path: join(out, 'failure.png'), fullPage: true })
    .catch(() => {})
  writeFileSync(join(out, 'failure.txt'), await p.locator('body').innerText())
  throw error
} finally {
  await browser.close()
}
