// T14: observable grouped toolbar, responsive controls, and existing entry points.
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { collectErrors, launchBrowser } from './browser-helper.mjs'

const out = process.env.SMOKE_ARTIFACT_DIR
if (out) mkdirSync(out, { recursive: true })
const browser = await launchBrowser()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = []
  collectErrors(page, errors)
  await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5240')
  await page
    .locator('input[type=file][accept="application/pdf"]')
    .setInputFiles(
      fileURLToPath(
        new URL('../tests/fixtures/zweiseitig.pdf', import.meta.url),
      ),
    )
  await page.waitForSelector('.page canvas')
  const primary = page.getByRole('group', {
    name: 'Datei und Navigation',
    exact: true,
  })
  const tools = page.getByRole('group', {
    name: 'Bearbeitungswerkzeuge',
    exact: true,
  })
  assert.equal(
    await primary.count(),
    1,
    'File actions and navigation have their own labelled top row',
  )
  const expected = {
    'Einfügen und Auswählen': [
      'Auswahl',
      'T Text',
      'Bild einfügen',
      'Symbol auswählen',
    ],
    Zeichnen: ['Stift', 'Radierer', 'Textmarker'],
    Formen: ['Rechteck', 'Ellipse', 'Linie', 'Pfeil'],
    Vertraulich: ['Schwärzen'],
  }
  for (const [name, actions] of Object.entries(expected)) {
    const group = tools.getByRole('group', { name, exact: true })
    assert.equal(await group.count(), 1, `Visible tool group: ${name}`)
    for (const action of actions)
      assert.equal(
        await group.getByRole('button', { name: new RegExp(action) }).count(),
        1,
      )
  }
  const primaryBox = await primary.boundingBox(),
    toolsBox = await tools.boundingBox()
  assert.ok(
    primaryBox.y + primaryBox.height <= toolsBox.y,
    'Tools are below file/navigation actions',
  )
  const desktopYs = await tools
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().y),
    )
  assert.ok(
    Math.max(...desktopYs) - Math.min(...desktopYs) < 2,
    'Desktop tools occupy one stable second row',
  )
  assert.equal(
    await primary
      .getByRole('button', { name: 'Exportieren', exact: true })
      .count(),
    1,
  )
  assert.equal(
    await primary
      .getByRole('button', { name: 'Speichern', exact: true })
      .count(),
    1,
  )
  assert.equal(
    await primary
      .getByRole('button', { name: 'Mit Passwort exportieren', exact: false })
      .count(),
    0,
  )
  for (const width of [1440, 1280, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 960 })
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `No page overflow at ${width}px`,
    )
    for (const button of await page.locator('header button').all()) {
      if (!(await button.isVisible())) continue
      const box = await button.boundingBox()
      assert.ok(
        box.x >= 0 && box.x + box.width <= width + 1,
        `Control stays within viewport at ${width}px`,
      )
      assert.ok(
        box.height >= 44,
        'Main toolbar controls retain 44px touch targets',
      )
    }
    assert.ok(
      (await page.locator('.workspace').boundingBox()).height >= 200,
      `Document remains usable at ${width}px`,
    )
    await primary.getByRole('button', { name: /Entwürfe/ }).click()
    const menu = page.locator('.drafts-menu')
    await menu.waitFor({ state: 'visible' })
    const menuBox = await menu.boundingBox()
    assert.ok(
      menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1,
      `Draft menu stays on screen at ${width}px`,
    )
    await primary.getByRole('button', { name: /Entwürfe/ }).click()
    await tools
      .getByRole('button', { name: 'Symbol auswählen', exact: true })
      .click()
    const symbols = page.locator('.symbol-popover')
    await symbols.waitFor({ state: 'visible' })
    const symbolBox = await symbols.boundingBox()
    assert.ok(
      symbolBox.x >= 0 && symbolBox.x + symbolBox.width <= width + 1,
      `Symbol menu stays on screen at ${width}px`,
    )
    await symbols.getByRole('button', { name: 'Symbol ✓', exact: true }).click()
    assert.equal(
      await tools
        .getByRole('button', { name: 'Symbol auswählen', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    )
    await tools.getByRole('button', { name: /Auswahl/, exact: false }).click()
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.keyboard.press('Control+f')
  await page.locator('.search-window').waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await primary
    .getByRole('button', { name: 'Seiten verwalten', exact: true })
    .click()
  assert.equal(
    await tools.count(),
    0,
    'Editing tools are hidden in page manager as before',
  )
  assert.equal(
    await primary.getByRole('button', { name: '+', exact: true }).count(),
    0,
    'Editor zoom stays hidden in page manager',
  )
  await primary
    .getByRole('button', { name: 'Zur Dokumentbearbeitung', exact: true })
    .click()
  assert.equal(await tools.count(), 1, 'Returning restores all editing tools')
  await primary
    .getByRole('button', { name: 'Exportieren', exact: true })
    .click()
  await page.locator('.export-dialog').waitFor({ state: 'visible' })
  assert.equal(
    await page
      .getByRole('radio', { name: /Bilddaten komprimieren/ })
      .isChecked(),
    false,
  )
  assert.equal(
    await page
      .getByRole('checkbox', { name: /Mit Passwort schützen/ })
      .isChecked(),
    false,
  )
  assert.equal(
    await page.locator('header').getAttribute('inert'),
    '',
    'Toolbar stays inert during export',
  )
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click()
  if (out) {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: join(out, 'editor-desktop-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.screenshot({ path: join(out, 'editor-desktop-light.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: join(out, 'editor-mobile.png') })
  }
  // The native-field switch moved into the footer, but still controls the same layer.
  const formDoc = await PDFDocument.create()
  const sheet = formDoc.addPage([600, 800])
  const field = formDoc.getForm().createTextField('Name')
  field.setText('Ada')
  field.addToPage(sheet, { x: 40, y: 690, width: 250, height: 28 })
  await page
    .locator('input[type=file][accept="application/pdf"]')
    .setInputFiles({
      name: 'layout-form.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await formDoc.save()),
    })
  const toggle = page
    .locator('.drawing-footer')
    .getByRole('checkbox', { name: 'Felder hervorheben', exact: true })
  await toggle.waitFor({ state: 'visible' })
  await toggle.uncheck()
  assert.equal(await page.locator('.native-form-layer.highlighted').count(), 0)
  await toggle.check()
  assert.equal(await page.locator('.native-form-layer.highlighted').count(), 1)
  assert.equal(
    await page
      .locator('.pages')
      .getByRole('textbox', { name: 'Name', exact: true })
      .inputValue(),
    'Ada',
  )
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Native footer stays within ${width}px`,
    )
    assert.ok((await page.locator('.workspace').boundingBox()).height >= 200)
    const footer = await page.locator('.drawing-footer').boundingBox()
    assert.ok(footer.y + footer.height <= 845)
  }
  assert.deepEqual(errors, [], 'No runtime errors')
  console.log(
    'PASS T14 grouped toolbar, desktop row, six widths, touch targets, popovers, search/page/export entry points',
  )
} finally {
  await browser.close()
}
