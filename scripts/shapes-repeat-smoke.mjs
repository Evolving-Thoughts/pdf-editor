import { fileURLToPath } from 'node:url'
import { chromiumPath } from './browser-helper.mjs'
// Continuous creation uses real pointer input and disposable storage, not mocked store state.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const base = process.env.SMOKE_URL ?? 'http://localhost:5203'
const artifacts = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-editor-repeat-'))
mkdirSync(artifacts, { recursive: true })
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--no-sandbox'],
})
const errors = []
async function draw(page, a, b, touch = false, cancel = false) {
  const r = await page.locator('.page').first().boundingBox()
  const start = { x: r.x + a[0], y: r.y + a[1] },
    end = { x: r.x + b[0], y: r.y + b[1] }
  assert.equal(
    await page.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.shape-toolbar')),
      start,
    ),
    false,
    'a creation gesture must start on the document, not on palette controls',
  )
  if (touch) {
    const session = await page.context().newCDPSession(page)
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] })
    await session.send('Input.dispatchTouchEvent', {
      type: cancel ? 'touchCancel' : 'touchEnd',
      touchPoints: [],
    })
    await session.detach()
  } else {
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(end.x, end.y, { steps: 8 })
    if (cancel)
      await page.locator('.page').first().dispatchEvent('pointercancel', { pointerId: 1, isPrimary: true })
    await page.mouse.up()
  }
}
async function snapshot(page) {
  return page.locator('.shape-overlay').evaluateAll((nodes) =>
    nodes.map((el) => ({
      id: el.dataset.shapeId,
      left: el.style.left,
      top: el.style.top,
      width: el.style.width,
      height: el.style.height,
      transform: el.style.transform,
    })),
  )
}
const tools = ['Rechteck', 'Ellipse', 'Linie', 'Pfeil', 'Textmarker']
try {
  for (const [touch, viewport] of [
    [false, { width: 1280, height: 1000 }],
    // Leave enough vertical document space to park the approved palette below
    // overlapping creation gestures; the save status row also occupies height.
    [true, { width: 390, height: 1000 }],
  ]) {
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch }),
      page = await context.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(base)
    await page
      .locator('input[accept="application/pdf"]')
      .setInputFiles(fileURLToPath(new URL('../tests/fixtures/zweiseitig.pdf', import.meta.url)))
    await page.waitForFunction(() => document.querySelector('.page canvas')?.width > 0)
    for (const label of tools) {
      console.log('Checking', touch ? 'touch' : 'mouse', label)
      // No toolbar during an empty creation selection. A completed selection does expose options.
      await page.getByRole('button', { name: label, exact: true }).click()
      assert.equal(await page.locator('.shape-toolbar').count(), 0)
      const count = await page.locator('.shape-overlay').count()
      await draw(page, [100, 60], [260, 130], touch)
      assert.equal(
        await page.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'),
        'true',
        `${label} stays active`,
      )
      await page.waitForSelector('.shape-toolbar')
      // Keep the options away from the drawing surface; its position must survive consecutive selections.
      await page.getByRole('button', { name: 'Formleiste verschieben', exact: true }).focus()
      for (let i = 0; i < 18; i++) await page.keyboard.press('ArrowDown')
      const first = await snapshot(page),
        bar = await page.locator('.shape-toolbar').boundingBox()
      const work = await page.locator('.workspace').boundingBox()
      assert.ok(bar.height <= work.height * .6 + 1, 'palette leaves document space for repeated creation')
      await draw(page, [180, 95], [270, 145], touch) // crosses the old source, not a resize grip
      assert.equal(
        await page.locator('.shape-overlay').count(),
        count + 2,
        `${label} creates a second overlay without reselection`,
      )
      assert.deepEqual((await snapshot(page)).slice(0, -1), first, 'previous source is not moved or replaced')
      assert.equal(
        await page.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'),
        'true',
      )
      await page.waitForSelector('.shape-toolbar')
      const bar2 = await page.locator('.shape-toolbar').boundingBox()
      assert.equal(bar2.y, bar.y, 'palette keeps its chosen position')
      await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
      assert.equal(await page.locator('.shape-overlay').count(), count + 1)
      await page.getByRole('button', { name: 'Wiederholen', exact: true }).click()
      assert.equal(await page.locator('.shape-overlay').count(), count + 2)
      // Undo temporarily removed the selected overlay, so the palette remounted.
      // Park it clear again rather than sending a pointer event into its controls.
      await page.getByRole('button', { name: 'Formleiste verschieben', exact: true }).focus()
      for (let i = 0; i < 18; i++) await page.keyboard.press('ArrowDown')
      const beforeCancel = await snapshot(page)
      // The taller T12 toolbar clamps the palette above y=140 on mobile.
      // Keep this cancellation gesture on exposed paper, without changing its size.
      await draw(page, [300, 40], [350, 60], touch, true)
      assert.deepEqual(await snapshot(page), beforeCancel)
      assert.equal(await page.locator('.shape-overlay').count(), count + 2)
      await draw(page, [150, 60], [280, 130], touch)
      assert.equal(
        await page.locator('.shape-overlay').count(),
        count + 3,
        'creation works after cancellation',
      )
      // Explicit grips remain usable without leaving the active creation tool.
      await page.getByRole('button', { name: 'Form frei drehen', exact: true }).focus()
      await page.keyboard.press('ArrowRight')
      assert.equal(
        await page.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'),
        'true',
      )
      assert.equal(await page.locator('.shape-overlay').count(), count + 3)
      await page.getByRole('button', { name: 'Rückgängig', exact: true }).click()
      // Switching creation -> selection invalidates an unfinished grip gesture too.
      const beforeSwitch = await snapshot(page)
      const grip = await page.getByRole('button', { name: 'Form frei drehen', exact: true }).boundingBox()
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
      await page.mouse.down()
      await page.getByRole('button', { name: '⬚ Auswahl', exact: true }).press('Enter')
      await page.mouse.move(grip.x + grip.width / 2 + 30, grip.y + grip.height / 2 + 20)
      await page.mouse.up()
      assert.deepEqual(await snapshot(page), beforeSwitch)
      // Explicit selection can still move/edit instead of painting another object.
      await page.getByRole('button', { name: '⬚ Auswahl', exact: true }).click()
      await page.locator('.shape-overlay').last().focus()
      const original = await snapshot(page)
      await page.keyboard.press('ArrowRight')
      const moved = await snapshot(page)
      assert.equal(moved.length, original.length)
      assert.notEqual(moved.at(-1).left, original.at(-1).left)
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.shape-toolbar').count(), 0)
    }
    await page.screenshot({ path: join(artifacts, touch ? 'repeat-mobile.png' : 'repeat-desktop.png') })
    await context.close()
  }
  assert.deepEqual(errors, [])
  console.log(
    'PASS five tools: repeated mouse/touch creation, overlapping sources, palette position, cancel, undo/redo and explicit selection',
  )
} finally {
  await browser.close()
}
