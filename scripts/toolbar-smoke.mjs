import { fileURLToPath } from 'node:url'
import { collectErrors, launchBrowser, pdfInput } from './browser-helper.mjs'
// Focused regression checks for the labelled top grip, width buttons and
// document-wide, undoable drawing deletion. Uses a disposable browser context.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const browser = await launchBrowser()
const artifacts = process.env.SMOKE_ARTIFACT_DIR
if (artifacts) mkdirSync(artifacts, { recursive: true })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  collectErrors(page, errors)
  await page.goto(process.env.SMOKE_URL ?? 'http://localhost:5201')
  await pdfInput(page).setInputFiles(fileURLToPath(new URL('../tests/fixtures/zweiseitig.pdf', import.meta.url)))
  await page.waitForSelector('.page canvas')
  await page.getByRole('button', { name: 'Stift', exact: true }).click()
  const bar = page.getByRole('group', { name: 'Zeichenoptionen', exact: true })
  const grip = page.getByRole('button', { name: 'Kontextleiste verschieben', exact: true })
  assert.match(await grip.innerText(), /Leiste ziehen/, 'Der ganze obere Griff ist verständlich beschriftet')
  const reset = page.getByRole('button', { name: 'Position zurücksetzen', exact: true })
  assert.equal((await reset.innerText()).trim(), '', 'Reset bleibt ein Symbolbutton')
  assert.equal(await reset.getAttribute('title'), 'Position zurücksetzen', 'Reset erklärt sich beim Hover')
  const colors = page.getByRole('group', { name: 'Stiftfarbe', exact: true })
  const widths = page.getByRole('group', { name: 'Strichstärke', exact: true })
  assert.equal(await widths.getByRole('button').count(), 3)
  assert.equal(await page.getByRole('combobox', { name: 'Strichstärke', exact: true }).count(), 0)
  const colorsBox = await colors.boundingBox()
  const widthsBox = await widths.boundingBox()
  const resetBox = await reset.boundingBox()
  assert.equal(colorsBox.y, widthsBox.y, 'Farben und Stärken stehen nebeneinander')
  assert.equal(resetBox.y, widthsBox.y, 'Reset steht in derselben Optionszeile')
  const gripBox = await grip.boundingBox()
  assert.ok(gripBox.y + gripBox.height <= colorsBox.y, 'Griff und Optionen sind getrennt')
  assert.ok(gripBox.width > (await bar.boundingBox()).width - 4, 'Die ganze Kopfzeile ist der Griff')
  assert.equal(await page.getByRole('button', { name: 'Schwarz', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.getByRole('button', { name: 'Schwarz', exact: true }).innerText(), '✓')
  const clear = page.getByRole('button', { name: 'Zeichnung löschen', exact: true })
  assert.ok(await clear.isDisabled(), 'Ohne Striche ist Löschen deaktiviert')

  const strokes = page.locator('.stroke')
  const draw = async (index, y) => {
    const sheet = await page.locator('.page').nth(index).boundingBox()
    await page.mouse.move(sheet.x + 100, sheet.y + y)
    await page.mouse.down()
    await page.mouse.move(sheet.x + 260, sheet.y + y, { steps: 10 })
    await page.mouse.up()
  }
  for (const [index, width] of [1, 3, 6].entries()) {
    const button = page.getByRole('button', { name: `${width} pt Strichstärke`, exact: true })
    await button.click()
    assert.equal(await button.getAttribute('aria-pressed'), 'true')
    assert.equal(await widths.locator('[aria-pressed=true]').count(), 1)
    assert.equal(await button.locator('svg path').getAttribute('stroke-width'), String(width))
    await draw(0, 300 + index * 60)
    assert.equal(await strokes.nth(index).getAttribute('stroke-width'), String(width))
  }
  console.log('PASS Kopfgriff, Farbhervorhebung, drei Stärkenbuttons und Inline-Reset')
  // Existing keyboard and pointer behavior is also exercised in drawing-smoke.
  await grip.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  await reset.hover()
  if (artifacts) await page.screenshot({ path: join(artifacts, 'toolbar-desktop.png') })
  await reset.click()

  await page.getByRole('button', { name: /T Text/, exact: true }).click()
  await page.locator('.page').first().click({ position: { x: 420, y: 500 } })
  await page.keyboard.type('Text bleibt erhalten')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Stift', exact: true }).click()
  await page.locator('.pages').evaluate(container => {
    container.scrollTop = container.querySelectorAll('.page')[1].offsetTop - 16
  })
  await draw(1, 300)
  const before = await strokes.evaluateAll(paths => paths.map(p => ({
    d: p.getAttribute('d'), color: p.getAttribute('stroke'), width: p.getAttribute('stroke-width'),
  })))
  assert.equal(before.length, 4)
  assert.ok(await clear.isEnabled())
  await clear.click()
  assert.equal(await strokes.count(), 0, 'Löschen entfernt die Zeichnung auf allen Seiten')
  assert.equal(await page.locator('.textbox textarea').inputValue(), 'Text bleibt erhalten')
  assert.equal(await page.locator('.page canvas').count(), 2, 'Das PDF bleibt geöffnet')
  assert.ok(await clear.isDisabled(), 'Ohne Zeichnung erzeugt der Button keine leeren Undo-Schritte')
  await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
  assert.deepEqual(await strokes.evaluateAll(paths => paths.map(p => ({
    d: p.getAttribute('d'), color: p.getAttribute('stroke'), width: p.getAttribute('stroke-width'),
  }))), before, 'Ein Undo stellt alle Striche exakt wieder her')
  await page.getByRole('button', { name: 'Wiederholen', exact: true }).click()
  assert.equal(await strokes.count(), 0)
  await page.waitForTimeout(900)
  await page.reload()
  await page.getByRole('button', { name: /Entwürfe/ }).click()
  await page.locator('.draft-open').first().click()
  await page.waitForSelector('.textbox textarea')
  assert.equal(await strokes.count(), 0, 'Gelöschte Zeichnung bleibt nach Auto-Save und Reload gelöscht')
  assert.equal(await page.locator('.textbox textarea').inputValue(), 'Text bleibt erhalten')
  assert.ok(await clear.isDisabled())
  console.log('PASS Zeichnung löschen: alle Seiten, Texte/PDF bleiben, ein Undo/Redo, Auto-Save')

  await page.getByRole('button', { name: 'Stift', exact: true }).click()
  await draw(0, 350)
  assert.equal(await strokes.count(), 1)
  if (artifacts) await page.screenshot({ path: join(artifacts, 'toolbar-home.png') })
  await page.getByRole('button', { name: 'Radierer', exact: true }).click()
  const eraserSizes = page.getByRole('group', { name: 'Radierergröße', exact: true })
  assert.equal(await eraserSizes.getByRole('button').count(), 3, 'Radierergröße hat drei Vorschau-Buttons')
  assert.equal(await page.getByRole('combobox', { name: 'Radierergröße', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '16 pt Radierergröße', exact: true }).getAttribute('aria-pressed'), 'true')
  const originalPath = await strokes.getAttribute('d')
  const eraserSheet = await page.locator('.page').first().boundingBox()
  // Width 3 pt adds half its thickness to each eraser radius: 8, 16, 24 pt.
  // Independent worked expectations for a cut centred at x=180.
  for (const [diameter, leftEnd, rightStart] of [[16, 170.5, 189.5], [32, 162.5, 197.5], [48, 154.5, 205.5]]) {
    const button = page.getByRole('button', { name: `${diameter} pt Radierergröße`, exact: true })
    await button.focus()
    await page.keyboard.press('Enter')
    assert.equal(await button.getAttribute('aria-pressed'), 'true')
    assert.equal(await eraserSizes.locator('[aria-pressed=true]').count(), 1)
    assert.ok((await button.getAttribute('title')).includes(`${diameter} pt Durchmesser`))
    await page.mouse.move(eraserSheet.x + 180, eraserSheet.y + 350)
    await page.mouse.down()
    assert.equal(await page.locator('.stroke-preview').getAttribute('stroke-width'), String(diameter),
      'Die ausgewählte Größe wird an die Radiergeste weitergegeben')
    await page.mouse.up()
    assert.equal(await strokes.count(), 2)
    const parts = await strokes.evaluateAll(paths => paths.map(path =>
      path.getAttribute('d').match(/-?\d+(?:\.\d+)?/g).map(Number)))
    assert.ok(Math.abs(parts[0].at(-2) - leftEnd) < 0.000001)
    assert.ok(Math.abs(parts[1][0] - rightStart) < 0.000001)
    await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
    assert.equal(await strokes.getAttribute('d'), originalPath, 'Ein Undo stellt den Strich exakt wieder her')
  }
  await page.getByRole('button', { name: '32 pt Radierergröße', exact: true }).click()
  if (artifacts) await bar.screenshot({ path: join(artifacts, 'eraser-detail.png') })
  console.log('PASS Radiererbuttons: drei Größen, Tastatur, Vorschau, tatsächliche Radierbreite und Undo')
  await page.getByRole('button', { name: 'Stift', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(100)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  const smallBar = await bar.boundingBox()
  const work = await page.locator('.workspace').boundingBox()
  assert.ok(smallBar.x >= work.x && smallBar.x + smallBar.width <= work.x + work.width)
  assert.equal((await reset.boundingBox()).y, (await widths.boundingBox()).y,
    'Auch mobil bleibt Reset bei den Stärkenbuttons statt in einer eigenen Zeile')
  for (const control of await bar.locator('button').all()) {
    const box = await control.boundingBox()
    assert.ok(box.width >= 44 && box.height >= 44, 'Alle Bedienelemente haben ausreichende Touchflächen')
    assert.ok(box.x >= smallBar.x && box.x + box.width <= smallBar.x + smallBar.width)
  }
  if (artifacts) await page.screenshot({ path: join(artifacts, 'toolbar-mobile.png') })
  await page.getByRole('button', { name: 'Radierer', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '32 pt Radierergröße', exact: true }).getAttribute('aria-pressed'), 'true',
    'Werkzeugwechsel behält die Radierergröße')
  for (const control of await bar.locator('button').all()) {
    const box = await control.boundingBox()
    assert.ok(box.width >= 44 && box.height >= 44)
    assert.ok(box.x >= smallBar.x && box.x + box.width <= smallBar.x + smallBar.width)
  }
  if (artifacts) await page.screenshot({ path: join(artifacts, 'toolbar-mobile-eraser.png') })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('button', { name: 'Stift', exact: true }).click()
  await reset.click()
  if (artifacts) await page.screenshot({ path: join(artifacts, 'toolbar-dark.png') })
  await page.getByRole('button', { name: 'Radierer', exact: true }).click()
  if (artifacts) await bar.screenshot({ path: join(artifacts, 'eraser-dark-detail.png') })
  assert.deepEqual(errors, [], 'Keine Laufzeitfehler')
  console.log('PASS Mobil: kein Overflow, Touchflächen und Radierer')
} finally {
  await browser.close()
}