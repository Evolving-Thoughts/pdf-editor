// Textbox move/copy/rotate, sticky text settings, the settings bar on top and comments, in a real browser.
// Usage: SMOKE_URL=http://localhost:5199 node scripts/textbox-tools-comments-smoke.mjs
import { PDFDocument, PDFName } from 'pdf-lib'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { clickExport, collectErrors, launchBrowser, pageReady, pdfInput } from './browser-helper.mjs'
import { confirmDefaultExport } from './export-smoke-helper.mjs'

const browser = await launchBrowser()
const p = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }), errors = []
collectErrors(p, errors)
const button = name => p.getByRole('button', { name, exact: true })
const page0 = () => p.locator('.pages .page').first()
const boxes = () => p.locator('.textbox')
const selectedBox = () => p.locator('.textbox.selected')
const bar = () => p.locator('.minibar')
const stored = () => p.evaluate(() => [...document.querySelectorAll('.textbox')].map(el => ({
  text: el.querySelector('textarea').value, left: parseFloat(el.style.left), top: parseFloat(el.style.top), transform: el.style.transform,
  font: getComputedStyle(el).fontFamily, weight: getComputedStyle(el).fontWeight,
})))
try {
  const doc = await PDFDocument.create(); doc.addPage([600, 800]); doc.addPage([600, 800])
  await p.goto(process.env.SMOKE_URL ?? 'http://localhost:5199')
  await pdfInput(p).setInputFiles({ name: 'werkzeuge.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) })
  await pageReady(p)

  // 1. Place a box and type: it moves at once with the grip, without switching to „Auswahl".
  await button('T Text').click()
  await page0().click({ position: { x: 100, y: 120 } })
  await p.keyboard.type('Erste')
  const grip = selectedBox().getByRole('button', { name: 'Textbox verschieben' })
  const start = await grip.boundingBox()
  await p.mouse.move(start.x + 11, start.y + 11); await p.mouse.down()
  await p.mouse.move(start.x + 91, start.y + 61, { steps: 5 }); await p.mouse.up()
  assert.equal(await p.getByRole('button', { name: 'T Text', exact: true }).getAttribute('aria-pressed'), 'true', 'Text tool stays active')
  const [moved] = await stored()
  assert.equal(moved.text, 'Erste', 'Typed text is kept while moving')
  const placed = await selectedBox().boundingBox()
  assert.ok(Math.abs(placed.x - (start.x + 28 + 80)) < 6 && placed.y > start.y + 45, `Box followed the grip ${JSON.stringify({ start, placed })}`)

  // 4. Settings carry over: bold + Times + 24 for the next box in this document.
  await bar().getByRole('combobox', { name: 'Schriftart' }).selectOption('times')
  await bar().getByRole('button', { name: 'Fett' }).click()
  await bar().getByRole('button', { name: 'Schriftgröße', exact: true }).click()
  await bar().locator('.font-size-popover button', { hasText: /^24$/ }).dispatchEvent('pointerdown')
  await page0().click({ position: { x: 300, y: 400 } })
  assert.equal(await bar().getByRole('combobox', { name: 'Schriftart' }).inputValue(), 'times', 'Next box uses the last font')
  assert.equal(await bar().getByRole('button', { name: 'Fett' }).getAttribute('aria-pressed'), 'true', 'Next box is bold')
  assert.match(await bar().getByRole('button', { name: 'Schriftgröße', exact: true }).innerText(), /^24/, 'Next box uses the last size')
  await p.keyboard.type('Zweite')

  // 2. Strg+C / Strg+V copies the selected box (also straight from typing, without a text selection).
  await p.keyboard.press('Control+c')
  await p.keyboard.press('Escape')
  await p.keyboard.press('Control+v')
  await p.waitForFunction(() => document.querySelectorAll('.textbox').length === 3)
  const copies = (await stored()).filter(box => box.text === 'Zweite')
  assert.equal(copies.length, 2, 'Pasted copy has the same text')
  assert.ok(copies[1].left > copies[0].left && copies[1].top > copies[0].top, 'Copy is offset down-right')
  assert.equal(copies[1].weight, copies[0].weight, 'Copy keeps the style')
  await p.keyboard.press('Control+v')
  await p.waitForFunction(() => document.querySelectorAll('.textbox').length === 4)
  await p.keyboard.press('Control+z')
  await p.waitForFunction(() => document.querySelectorAll('.textbox').length === 3)

  await boxes().nth(2).locator('textarea').click()
  // 3. Rotate with the handle (Shift snaps) and with the keyboard; one undo step each.
  const rotate = selectedBox().getByRole('button', { name: 'Textbox drehen' })
  const handle = await rotate.boundingBox(), anchor = await selectedBox().boundingBox()
  await p.keyboard.down('Shift')
  await p.mouse.move(handle.x + 11, handle.y + 11); await p.mouse.down()
  await p.mouse.move(anchor.x + 10, anchor.y + 200, { steps: 8 }); await p.mouse.up()
  await p.keyboard.up('Shift')
  const turned = await selectedBox().evaluate(el => el.style.transform)
  const angle = Number(/rotate\(([-\d.]+)deg\)/.exec(turned)[1])
  assert.ok(angle > 0 && angle % 15 === 0, `Shift-drag snaps to 15° steps (${turned})`)
  await rotate.focus(); await p.keyboard.press('ArrowRight')
  assert.equal(await selectedBox().evaluate(el => el.style.transform), `rotate(${(angle + 1) % 360}deg)`, 'Arrow key turns by 1°')
  assert.equal(await bar().getByRole('button', { name: 'Drehung zurücksetzen' }).innerText(), `${Math.round(angle + 1)}°`)
  await p.keyboard.press('Control+z')
  assert.equal(await selectedBox().evaluate(el => el.style.transform), turned, 'Undo restores the dragged angle')

  // 5. The settings bar stays on top and visible, also at the top edge below the save notice.
  await button('⬚ Auswahl').click()
  await p.locator('.pages').evaluate(el => { el.scrollTop = 0 })
  await boxes().first().locator('.drag-surface').click()
  await p.locator('.pages').evaluate(el => { el.scrollTop += el.querySelector('.page').getBoundingClientRect().top - el.getBoundingClientRect().top + 30 })
  await p.waitForTimeout(150)
  const geometry = await p.evaluate(() => {
    const barBox = document.querySelector('.minibar').getBoundingClientRect()
    const notice = document.querySelector('.draft-save-status').getBoundingClientRect()
    const top = document.elementFromPoint(barBox.left + 8, barBox.top + barBox.height / 2)
    return { barTop: barBox.top, noticeBottom: notice.bottom, onTop: !!top?.closest('.minibar'), hidden: getComputedStyle(document.querySelector('.minibar')).visibility === 'hidden' }
  })
  assert.equal(geometry.hidden, false, 'Bar is visible while its box is on screen')
  {
    assert.ok(geometry.barTop >= geometry.noticeBottom, 'Bar is not covered by the save notice')
    assert.ok(geometry.onTop, 'Bar is the topmost element where it is drawn')
  }
  await p.locator('.pages').evaluate(el => { el.scrollTop = 0 })

  // 6. Comments: place, type, list, jump, move, delete with undo, persist in the export as text annotations.
  await button('💬 Kommentar').click()
  await page0().click({ position: { x: 400, y: 200 } })
  await p.getByRole('textbox', { name: 'Kommentartext' }).fill('Bitte Zahl prüfen')
  await p.getByRole('button', { name: 'Fertig' }).click()
  await page0().click({ position: { x: 150, y: 600 } })
  await p.keyboard.type('Zweiter Hinweis')
  await page0().click({ position: { x: 500, y: 700 } })
  // Clicking elsewhere keeps the typed note; the new, empty one is removed when left.
  await p.keyboard.press('Escape')
  await p.waitForFunction(() => document.querySelectorAll('.comment-pin').length === 2)
  await p.getByRole('button', { name: /^Kommentarliste/ }).click()
  const list = p.getByRole('complementary', { name: 'Kommentare' })
  assert.deepEqual(await list.locator('.comment-jump').allInnerTexts(), ['#1 · Seite 1\nBitte Zahl prüfen', '#2 · Seite 1\nZweiter Hinweis'])
  await list.locator('.comment-jump').nth(1).click()
  assert.equal(await p.getByRole('textbox', { name: 'Kommentartext' }).inputValue(), 'Zweiter Hinweis', 'Jump opens the note')
  await p.getByRole('textbox', { name: 'Kommentartext' }).fill('Zweiter Hinweis, ergänzt')
  await p.getByRole('textbox', { name: 'Kommentartext' }).press('Control+Enter')
  await button('⬚ Auswahl').click()
  const pin = p.locator('.comment-pin').first()
  await pin.evaluate(el => el.scrollIntoView({ block: 'center' }))
  const pinBox = await pin.boundingBox()
  await p.mouse.move(pinBox.x + 5, pinBox.y + 5); await p.mouse.down()
  await p.mouse.move(pinBox.x + 45, pinBox.y + 25, { steps: 4 }); await p.mouse.up()
  const after = await pin.boundingBox()
  assert.ok(Math.abs(after.x - pinBox.x - 40) < 3, `Pin can be moved ${JSON.stringify({ pinBox, after, hit: await p.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [pinBox.x + 5, pinBox.y + 5]) })}`)
  await list.getByRole('button', { name: 'Kommentar 1 löschen' }).click()
  assert.equal(await p.locator('.comment-pin').count(), 1)
  await p.keyboard.press('Control+z')
  assert.equal(await p.locator('.comment-pin').count(), 2, 'Undo brings the comment back')

  // Export: comments become /Text annotations with their notes.
  const downloadPromise = p.waitForEvent('download')
  await clickExport(p); await confirmDefaultExport(p)
  const download = await downloadPromise
  const exported = await PDFDocument.load(readFileSync(await download.path()))
  const notes = exported.getPage(0).node.Annots().asArray().map(ref => exported.context.lookup(ref))
    .filter(dict => dict.get(PDFName.of('Subtype')) === PDFName.of('Text')).map(dict => dict.get(PDFName.of('Contents')).decodeText())
  assert.deepEqual(notes.sort(), ['Bitte Zahl prüfen', 'Zweiter Hinweis, ergänzt'])

  assert.deepEqual(errors, [])
  console.log('PASS textbox moves while typing, copy/paste, rotation, sticky settings, settings bar on top; comments with list, edit, move, undo and PDF text annotations.')
} finally { await browser.close() }
