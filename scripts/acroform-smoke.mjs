import { collectErrors, launchBrowser, pdfInput } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'
// T9 variant C: real fields + overlay text, undo, drafts, page operations and live export.
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const out = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-acroform-'))
mkdirSync(out, { recursive: true })
const browser = await launchBrowser()
const p = await browser.newPage({ viewport: { width: 1280, height: 1100 }, acceptDownloads: true }), errors = []
collectErrors(p, errors)
const btn = name => p.getByRole('button', { name, exact: true })
const name = () => p.locator('.pages').getByRole('textbox', { name: 'Name', exact: true }).first()
const ready = () => p.waitForFunction(() => document.querySelector('.page-manager-preview canvas')?.width > 0 && !document.querySelector('.page-manager-message')?.textContent.includes('aktualisiert') && !document.querySelector('.page-manager-message')?.textContent.includes('verarbeitet'))
async function exportDoc(button, file) {
  const event = p.waitForEvent('download'); await btn(button).click(); if (button === 'Exportieren') await confirmDefaultExport(p); await (await event).saveAs(join(out, file)); return PDFDocument.load(readFileSync(join(out, file)))
}
async function parsed(bytes) {
  return p.evaluate(async data => {
    const { getDocument, GlobalWorkerOptions } = await import('/node_modules/pdfjs-dist/build/pdf.mjs'); GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
    const task = getDocument({ data: new Uint8Array(data) }), doc = await task.promise, result = []
    for (let i = 1; i <= doc.numPages; i++) { const page = await doc.getPage(i); result.push({ text: (await page.getTextContent()).items.map(x => x.str).join(' '), widgets: (await page.getAnnotations()).filter(a => a.subtype === 'Widget').map(a => [a.fieldName, a.fieldValue]) }) }
    await task.destroy(); return result
  }, Array.from(bytes))
}
function checkValues(doc, expected = 'Grace') {
  const form = doc.getForm(); assert.equal(form.getTextField('Name').getText(), expected); assert.equal(form.getCheckBox('Consent').isChecked(), true)
  assert.equal(form.getRadioGroup('Contact').getSelected(), 'Phone'); assert.deepEqual(form.getDropdown('Choice').getSelected(), ['Second']); assert.deepEqual(form.getOptionList('Multi').getSelected(), ['B', 'C'])
  assert.equal(form.getTextField('Reference').getText(), 'LOCK'); assert.equal(form.getTextField('Reference').isReadOnly(), true)
}
try {
  const doc = await PDFDocument.create(), a = doc.addPage([600, 800]), b = doc.addPage([600, 800]), font = await doc.embedFont(StandardFonts.Helvetica), f = doc.getForm()
  a.drawText('AcroForm fixture 1', { x: 40, y: 755, size: 20, font }); b.drawText('AcroForm fixture 2', { x: 40, y: 755, size: 20, font })
  const text = f.createTextField('Name'); text.setText('Ada'); text.addToPage(a, { x: 40, y: 690, width: 250, height: 28 }); text.addToPage(b, { x: 40, y: 690, width: 250, height: 28 })
  const notes = f.createTextField('Notes'); notes.enableMultiline(); notes.addToPage(a, { x: 40, y: 570, width: 300, height: 70 }); notes.setFontSize(14)
  const consent = f.createCheckBox('Consent'); consent.addToPage(a, { x: 40, y: 530, width: 18, height: 18 })
  const contact = f.createRadioGroup('Contact'); contact.addOptionToPage('Email', a, { x: 40, y: 485, width: 18, height: 18 }); contact.addOptionToPage('Phone', a, { x: 90, y: 485, width: 18, height: 18 }); contact.select('Email')
  const choice = f.createDropdown('Choice'); choice.addOptions(['First', 'Second']); choice.select('First'); choice.addToPage(a, { x: 40, y: 440, width: 160, height: 26 })
  const multi = f.createOptionList('Multi'); multi.addOptions(['A', 'B', 'C']); multi.enableMultiselect(); multi.addToPage(a, { x: 370, y: 570, width: 110, height: 70 })
  const ref = f.createTextField('Reference'); ref.setText('LOCK'); ref.enableReadOnly(); ref.addToPage(a, { x: 40, y: 385, width: 160, height: 26 })
  const unsupported = f.createButton('Button'); unsupported.addToPage('No script', a, { x: 40, y: 340, width: 100, height: 25 })
  const original = await doc.save()
  await p.goto(process.env.SMOKE_URL ?? 'http://localhost:5219')
  await pdfInput(p).setInputFiles({ name: 'native.pdf', mimeType: 'application/pdf', buffer: Buffer.from(original) })
  await name().waitFor(); assert.equal(await p.locator('.pages').getByRole('textbox', { name: 'Name', exact: true }).count(), 2)
  await name().fill('Grace'); assert.equal(await p.locator('.pages').getByRole('textbox', { name: 'Name', exact: true }).nth(1).inputValue(), 'Grace')
  await btn('Rückgängig').click(); assert.equal(await name().inputValue(), 'Ada'); await btn('Wiederholen').click(); assert.equal(await name().inputValue(), 'Grace')
  await name().fill('Typing'); await name().press('End'); await p.keyboard.type(' grouped'); await btn('Rückgängig').click(); assert.equal(await name().inputValue(), 'Grace')
  await p.getByRole('textbox', { name: 'Notes', exact: true }).fill('Erste Zeile\nZweite Zeile')
  await p.getByRole('checkbox', { name: 'Consent', exact: true }).check(); await p.getByRole('radio', { name: 'Contact: Phone', exact: true }).check()
  await p.getByRole('combobox', { name: 'Choice', exact: true }).selectOption('Second'); await p.getByRole('listbox', { name: 'Multi', exact: true }).selectOption(['B', 'C'])
  assert.equal(await p.getByRole('textbox', { name: 'Reference', exact: true }).isDisabled(), true)
  await btn('T Text').click(); await name().fill('Grace'); assert.equal(await p.locator('.textbox').count(), 0)
  const r = await p.locator('.pages .page').first().boundingBox(); await p.mouse.click(r.x + 450, r.y + 520)
  await p.locator('.textbox textarea').fill('Overlay bleibt separat'); await p.locator('.textbox textarea').press('Escape')
  await p.getByRole('checkbox', { name: 'Felder hervorheben', exact: true }).uncheck(); assert.equal(await p.locator('.native-form-layer.highlighted').count(), 0)
  let full = await exportDoc('Exportieren', 'mixed.pdf'); checkValues(full)
  assert.equal(full.getForm().getTextField('Notes').getText(), 'Erste Zeile\nZweite Zeile')
  let independent = await parsed(await full.save()); assert.ok(independent[0].text.includes('Overlay bleibt separat')); assert.ok(independent.every(page => page.widgets.some(([key, value]) => key === 'Name' && value === 'Grace')))
  full.getForm().getTextField('Name').setText('Edited after export'); independent = await parsed(await full.save()); assert.ok(independent[0].widgets.some(([key, value]) => key === 'Name' && value === 'Edited after export'))
  await btn('Speichern').click(); await p.waitForFunction(() => document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'))
  await p.reload(); await p.getByRole('button', { name: /Entwürfe/ }).click(); await p.locator('.draft-open').first().click(); await name().waitFor(); assert.equal(await name().inputValue(), 'Grace')
  assert.equal(await p.locator('.textbox textarea').inputValue(), 'Overlay bleibt separat'); assert.equal(await p.getByRole('checkbox', { name: 'Consent', exact: true }).isChecked(), true)
  await p.screenshot({ path: join(out, 'desktop.png') })
  await btn('Seiten verwalten').click(); await ready(); await btn('1 Seite im Uhrzeigersinn drehen').click(); await ready()
  const extracted = await exportDoc('Extrahieren', 'rotated-subset.pdf'); checkValues(extracted); assert.equal(extracted.getPageCount(), 1); assert.equal(extracted.getPage(0).getRotation().angle, 90)
  await btn('Zur Dokumentbearbeitung').click(); await name().waitFor(); await name().fill('Rotated edit'); full = await exportDoc('Exportieren', 'rotated-edit.pdf'); checkValues(full, 'Rotated edit')
  await btn('Seiten verwalten').click(); await ready(); await btn('Alle Seiten auf A4 …').click(); await p.waitForFunction(() => document.querySelector('.page-manager-message')?.textContent.includes('A4-Vorschau:'))
  await btn('2 Seiten auf A4 setzen').click(); await ready(); full = await exportDoc('Exportieren', 'a4.pdf'); checkValues(full, 'Rotated edit')
  await btn('Zur Dokumentbearbeitung').click(); await name().waitFor(); assert.equal(await name().inputValue(), 'Rotated edit'); await name().fill('After A4'); full = await exportDoc('Exportieren', 'a4-edit.pdf'); checkValues(full, 'After A4')
  await btn('Speichern').click(); await p.waitForFunction(() => document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'))
  await p.reload(); await p.getByRole('button', { name: /Entwürfe/ }).click(); await p.locator('.draft-open').first().click(); await name().waitFor(); assert.equal(await name().inputValue(), 'After A4')
  await p.setViewportSize({ width: 390, height: 1000 }); await name().fill('Mobile edit'); await p.screenshot({ path: join(out, 'mobile.png'), fullPage: true }); full = await exportDoc('Exportieren', 'mobile.pdf'); checkValues(full, 'Mobile edit')
  // A value outside the standard font must remain recoverable in a local draft.
  await name().fill('Unsupported 🙂'); await btn('Speichern').click(); await p.waitForFunction(() => document.querySelector('.draft-save-status')?.textContent.includes('Entwurf gespeichert'))
  await p.reload(); await p.getByRole('button', { name: /Entwürfe/ }).click(); await p.locator('.draft-open').first().click(); await name().waitFor(); assert.equal(await name().inputValue(), 'Unsupported 🙂')
  await btn('Exportieren').click(); await confirmDefaultExport(p); await p.getByRole('alert').filter({ hasText: 'Standardschrift' }).waitFor(); await p.keyboard.press('Escape')
  await name().fill('Recovered'); full = await exportDoc('Exportieren', 'recovered.pdf'); checkValues(full, 'Recovered')
  assert.equal((await PDFDocument.load(original)).getForm().getTextField('Name').getText(), 'Ada'); assert.deepEqual(errors, [])
  console.log('PASS T9 variant C: real native text/multiline/check/radio/single+multi-choice/read-only/shared widgets, grouped undo/redo, mixed overlay text, independent PDF.js values and later native edit, draft reload, rotation/subset export, A4 + subsequent edit/reload, mobile viewport; no page errors. Original immutable.')
} finally { await browser.close() }
