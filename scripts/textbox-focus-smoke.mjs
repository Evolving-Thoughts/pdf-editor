import { PDFDocument } from 'pdf-lib'
import assert from 'node:assert/strict'
import { collectErrors, launchBrowser, pdfInput } from './browser-helper.mjs'
const browser = await launchBrowser()
const p = await browser.newPage({ viewport: { width: 1440, height: 1100 }, hasTouch: true }), errors = []
collectErrors(p, errors)
const button = name => p.getByRole('button', { name, exact: true })
async function place(pageIndex, x, y) {
  await p.locator('.pages .page').nth(pageIndex).click({ position: { x, y } })
}
async function activeBox() {
  const box = p.locator('.textbox.selected')
  assert.equal(await box.count(), 1, 'Exactly the newly created/focused textbox stays selected')
  assert.equal(await box.locator('.minibar').count(), 1, 'Formatting bar is present immediately')
  assert.equal(await box.locator('textarea').evaluate(el => el === document.activeElement), true, 'Textbox has typing focus')
  return box
}
try {
  const doc = await PDFDocument.create(); doc.addPage([600, 800]); doc.addPage([600, 800])
  await p.goto(process.env.SMOKE_URL ?? 'http://localhost:5208')
  await pdfInput(p).setInputFiles({ name: 'focus.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) })
  await p.waitForFunction(() => document.querySelector('.page canvas')?.dataset.renderState === 'ready')
  await button('T Text').click()
  await place(0, 120, 200); await activeBox()
  // No typing and no Escape: blur cleanup must not clear the *next* box selection.
  for (const [x, y] of [[300, 320], [120, 420], [300, 520]]) {
    await place(0, x, y); await activeBox()
    assert.equal(await p.locator('.textbox').count(), 1, 'Previous empty box is cleaned up')
  }
  await p.keyboard.type('Erster Text')
  await place(0, 120, 240); let box = await activeBox()
  assert.equal(await p.locator('.textbox').count(), 2, 'Completed textbox remains')
  assert.equal(await p.locator('.textbox textarea').first().inputValue(), 'Erster Text')
  // A font change in an empty textbox must keep it alive and return typing focus.
  await box.getByRole('combobox', { name: 'Schriftart', exact: true }).selectOption('carlito')
  box = await activeBox(); await p.keyboard.type('Carlito direkt tippen')
  assert.equal(await box.locator('textarea').inputValue(), 'Carlito direkt tippen')
  // Changing an existing text preserves the insertion point, rather than replacing content.
  await box.locator('textarea').press('Home')
  await box.getByRole('combobox', { name: 'Schriftart', exact: true }).selectOption('lato')
  box = await activeBox(); await p.keyboard.type('Neu: ')
  assert.equal(await box.locator('textarea').inputValue(), 'Neu: Carlito direkt tippen')
  // Keyboard selection also restores text focus; Caveat retains its native-style rules.
  const font = box.getByRole('combobox', { name: 'Schriftart', exact: true })
  await font.focus(); await p.keyboard.press('Home'); await p.keyboard.press('ArrowDown')
  box = await activeBox()
  await box.getByRole('combobox', { name: 'Schriftart', exact: true }).selectOption('caveat')
  box = await activeBox(); assert.equal(await box.getByRole('button', { name: 'Kursiv', exact: true }).isDisabled(), true)
  await p.keyboard.type('!')
  assert.ok((await box.locator('textarea').inputValue()).includes('!'))
  await place(1, 120, 220); await activeBox()
  await place(0, 320, 620); box = await activeBox()
  assert.equal(await p.locator('.textbox').count(), 3, 'Cross-page empty cleanup preserves nonempty textboxes')
  await p.keyboard.press('Escape')
  assert.equal(await p.locator('.textbox').count(), 2, 'Escape still cleans up the selected empty box')
  await p.setViewportSize({ width: 390, height: 844 })
  await button('T Text').click()
  await p.locator('.pages .page').first().tap({ position: { x: 80, y: 320 } })
  box = await activeBox()
  await box.getByRole('combobox', { name: 'Schriftart', exact: true }).selectOption('eb-garamond')
  box = await activeBox(); await p.keyboard.type('Mobil')
  assert.equal(await box.locator('textarea').inputValue(), 'Mobil')
  await p.locator('.pages .page').first().tap({ position: { x: 80, y: 420 } })
  await activeBox()
  await p.locator('.pages .page').first().tap({ position: { x: 80, y: 620 } })
  await activeBox()
  assert.deepEqual(errors, [])
  console.log('PASS repeated text creation, empty cleanup and cross-page focus keep the minibar; font selection returns typing focus/caret for empty and existing text; keyboard selection, Caveat and Escape work.')
} finally { await browser.close() }
