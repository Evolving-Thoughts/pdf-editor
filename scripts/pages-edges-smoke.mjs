import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument } from 'pdf-lib'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
const browser = await chromium.launch({
  executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
  args: ['--no-sandbox'],
})
const p = await browser.newPage({ viewport: { width: 1200, height: 1000 } }),
  errors = []
p.on('pageerror', (e) => errors.push(String(e)))
p.on('dialog', (d) => void d.accept())
const btn = (name) => p.getByRole('button', { name, exact: true })
const settled = () =>
  p.waitForFunction(
    () => !document.querySelector('.page-manager-message')?.textContent.includes('aktualisiert'),
  )
try {
  const doc = await PDFDocument.create()
  doc.addPage([600, 800])
  await p.goto(process.env.SMOKE_URL ?? 'http://localhost:5207')
  await p.locator('input[accept="application/pdf"]').setInputFiles({
    name: 'empty-test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  })
  await p.waitForFunction(() => document.querySelector('.page canvas')?.width > 0)
  await btn('Seiten verwalten').click()
  await settled()
  await btn('Seite löschen').click(); await btn('1 Seite löschen').click()
  await p.waitForSelector('.page-manager-empty')
  assert(await btn('Exportieren').isDisabled())
  await btn('Rückgängig').click()
  await settled()
  assert.equal(await p.locator('.page-manager-row').count(), 1)
  await btn('Seite löschen').click(); await btn('1 Seite löschen').click()
  await p.waitForSelector('.page-manager-empty')
  await btn('Speichern').click()
  await p.waitForFunction(() =>
    document.querySelector('.draft-save-status').textContent.includes('Entwurf gespeichert'),
  )
  await p.reload()
  await p.getByRole('button', { name: /Entwürfe/ }).click()
  await p.locator('.draft-open').first().click()
  await p.waitForFunction(() => document.querySelector('.file-info')?.textContent.includes('0 Seiten'))
  await btn('Seiten verwalten').click()
  await p.waitForSelector('.page-manager-empty')
  await btn('＋ Seiten einfügen').click()
  assert.equal(await p.getByLabel('Einfügeposition').inputValue(), '0')
  assert.deepEqual(await p.getByLabel('Einfügeposition').locator('option').allTextContents(), ['Am Ende anhängen'])
  await p
    .locator('.page-insert-dialog input[type=file]')
    .setInputFiles({ name: 'bad.pdf', mimeType: 'application/pdf', buffer: Buffer.from('broken') })
  await p.locator('.page-insert-dialog').getByRole('button', { name: 'Einfügen', exact: true }).click()
  await p.locator('.page-insert-dialog [role=alert]').waitFor()
  assert.equal(await p.locator('.page-manager-row').count(), 0)
  await p.keyboard.press('Escape')
  assert.equal(await p.locator('.page-insert-dialog').count(), 0)
  await btn('＋ Seiten einfügen').click()
  await p.locator('.page-insert-dialog').getByRole('button', { name: 'Einfügen', exact: true }).click()
  assert.match(await p.locator('.page-insert-dialog [role=alert]').textContent(), /auswählen/)
  await p.getByLabel('Quelle', { exact: true }).selectOption('text')
  await p.getByLabel('Text', { exact: true }).fill('Wiederhergestellte Seite')
  await p.locator('.page-insert-dialog').getByRole('button', { name: 'Einfügen', exact: true }).click()
  await p.locator('.page-insert-dialog').waitFor({ state: 'detached' })
  await settled()
  assert.equal(await p.locator('.page-manager-row').count(), 1)
  await btn('＋ Seiten einfügen').click()
  assert.equal(await p.getByLabel('Einfügeposition').inputValue(), '1')
  assert.deepEqual(await p.getByLabel('Einfügeposition').locator('option').allTextContents(), ['Am Ende anhängen', 'Am Anfang einfügen'])
  await p.keyboard.press('Escape')
  // Native desktop crop drag and cancellation, not direct store injection.
  await btn('Zuschneiden').click()
  const grip = await p.getByRole('button', { name: 'Zuschnitt-Ecke tl', exact: true }).boundingBox()
  await p.mouse.move(grip.x + 12, grip.y + 12)
  await p.mouse.down()
  await p.mouse.move(grip.x + 60, grip.y + 70, { steps: 8 })
  await p.mouse.up()
  assert(Number(await p.getByLabel('Links · mm').inputValue()) > 0)
  await btn('Abbrechen').click()
  await btn('Zuschneiden').click()
  assert.equal(await p.getByLabel('Links · mm').inputValue(), '0')
  await p.keyboard.press('Escape')
  await p.locator('.page-manager-row').dragTo(p.locator('.page-manager-row'))
  const formDoc = await PDFDocument.create(),
    formPage = formDoc.addPage([200, 300])
  const field = formDoc.getForm().createTextField('name')
  field.setText('Ada Lovelace')
  field.addToPage(formPage, { x: 20, y: 180, width: 150, height: 25 })
  await btn('＋ Seiten einfügen').click()
  await p.getByLabel('Quelle', { exact: true }).selectOption('file')
  await p.locator('.page-insert-dialog input[type=file]').setInputFiles({
    name: 'form.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await formDoc.save()),
  })
  await p.locator('.page-insert-dialog').getByRole('button', { name: 'Einfügen', exact: true }).click()
  await p.locator('.page-insert-dialog').waitFor({ state: 'detached' })
  await settled()
  assert.match(await p.locator('.page-manager-panel').textContent(), /im Export bearbeitbar/)
  const pending = p.waitForEvent('download')
  await btn('Extrahieren').click()
  const download = await pending
  const file = join(mkdtempSync(join(tmpdir(), 't7-form-')), 'form.pdf')
  await download.saveAs(file)
  assert.match(execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }), /Ada Lovelace/)
  const editable = await PDFDocument.load(readFileSync(file))
  assert.equal(editable.getForm().getTextField('name').getText(), 'Ada Lovelace')
  editable.getForm().getTextField('name').setText('Grace Hopper')
  assert.equal((await PDFDocument.load(await editable.save())).getForm().getTextField('name').getText(), 'Grace Hopper')
  assert.deepEqual(errors, [])
  console.log(
    'PASS last-page deletion/undo, empty draft save/reload, invalid import preserves empty state, recovery via text insertion, crop corner drag/cancel/Escape.',
  )
} finally {
  await browser.close()
}
