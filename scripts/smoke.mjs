// Dev-server smoke test: exercises the full textbox interaction flow in a
// real browser. Usage:
//   npm run dev -- --port 5199 --strictPort
//   node scripts/smoke.mjs
// Env: SMOKE_URL (default http://localhost:5199), CHROMIUM_PATH (system
// Chromium instead of the Playwright-downloaded browser).
import { chromium } from 'playwright'

const results = []
const check = (name, ok) => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}`)

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
)
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const baseUrl = process.env.SMOKE_URL ?? 'http://localhost:5199'
await page.goto(baseUrl)
await page.locator('input[type=file]').setInputFiles(new URL('../tests/fixtures/zweiseitig.pdf', import.meta.url).pathname)
await page.waitForSelector('canvas')

// 1. Create a textbox with the text tool
await page.getByRole('button', { name: /Text/ }).click()
await page.locator('.page').first().click({ position: { x: 200, y: 300 } })
await page.keyboard.type('Hallo Welt')
await page.keyboard.press('Escape')
check('Textbox erstellt', await page.locator('.textbox').count() === 1)

// 2. Select it -> minibar appears
await page.locator('.textbox textarea').click({ force: true })
await page.keyboard.press('Escape')
const box = page.locator('.textbox')
check('Minibar sichtbar nach Auswahl', await box.locator('.minibar').isVisible())

// 3. Font select offers 12 variants (base + bold/italic/bold-italic)
check('12 Schriftvarianten (3 Familien x 4)', (await box.locator('select[aria-label="Schriftart"] option').count()) === 12)

// 4. Bold variant applies font-weight
await box.locator('select[aria-label="Schriftart"]').selectOption('helvetica-bold')
const weight = await box.evaluate((el) => getComputedStyle(el).fontWeight)
check(`Fett-Variante aktiv (font-weight ${weight})`, weight === '700' || weight === 'bold')
await box.locator('select[aria-label="Schriftart"]').selectOption('helvetica')

// 5. Font-size picker: opens with input + all 7 presets visible
const sizeButton = box.locator('button[aria-label="Schriftgröße"]')
await sizeButton.click()
const popover = box.locator('.font-size-popover')
check('Größen-Popover geht auf', await popover.isVisible())
check('Alle 7 Vorschläge sichtbar', (await popover.locator('button').count()) === 7)

// 6. Preset click commits and closes
await popover.locator('button', { hasText: '24' }).first().click()
check('Preset 24 übernommen', (await box.evaluate((el) => getComputedStyle(el).fontSize)) === '24px')
check('Popover nach Preset-Klick zu', (await popover.count()) === 0)

// 7. Free input: 13.5
await sizeButton.click()
const sizeInput = box.locator('input[aria-label="Schriftgröße eingeben"]')
await sizeInput.fill('13.5')
await sizeInput.press('Enter')
check('Freie Schriftgröße 13.5 übernommen', (await box.evaluate((el) => getComputedStyle(el).fontSize)) === '13.5px')

// 8. Invalid input reverts
await sizeButton.click()
await sizeInput.fill('abc')
await sizeInput.press('Enter')
check('Ungültige Eingabe verworfen', (await sizeButton.textContent()).includes('13.5'))

// 9. Out-of-range input is clamped to 200
await sizeButton.click()
await sizeInput.fill('999')
await sizeInput.press('Enter')
check('Zu große Eingabe auf 200 geclamped', (await sizeButton.textContent()).includes('200'))

// 10. Large size: textarea grows, no clipping
const dims = await box.locator('textarea').evaluate((el) => ({ clientH: el.clientHeight, scrollH: el.scrollHeight }))
check(`Box wächst mit (client ${dims.clientH} >= scroll ${dims.scrollH})`, dims.clientH >= dims.scrollH)

// 11. Escape in the picker reverts without committing
await sizeButton.click()
await sizeInput.fill('10')
await sizeInput.press('Escape')
check('Esc im Picker verwirft', (await sizeButton.textContent()).includes('200'))
await box.locator('button[aria-label="Schriftgröße"]').click() // reopen
await sizeInput.fill('13.5')
await sizeInput.press('Enter')

// 12. Arrow-key nudge: 1pt left, Shift+Up 10pt up
const before = await box.boundingBox()
await page.keyboard.press('ArrowLeft')
await page.keyboard.press('Shift+ArrowUp')
const after = await box.boundingBox()
check(`Pfeil-Nudge links 1px (dx=${after.x - before.x})`, Math.round(after.x - before.x) === -1)
check(`Shift-Nudge oben 10px (dy=${after.y - before.y})`, Math.round(after.y - before.y) === -10)

// 13. Merged undo: one Ctrl+Z reverts both nudges
await page.keyboard.press('Control+z')
const undone = await box.boundingBox()
check('Ein Undo macht beide Nudges rückgängig',
  Math.round(undone.x) === Math.round(before.x) && Math.round(undone.y) === Math.round(before.y))
await page.keyboard.press('Control+y')
const redone = await box.boundingBox()
check('Redo stellt Nudges wieder her', Math.round(redone.x - before.x) === -1)

// 14. Escape switches to the select tool
await page.keyboard.press('Escape')
check('Esc → Auswahl-Tool aktiv', await page.getByRole('button', { name: /Auswahl/ }).getAttribute('aria-pressed') === 'true')

check('Keine Konsolen-/Seitenfehler', errors.length === 0)
if (errors.length) console.log(errors.join('\n'))

console.log(results.join('\n'))
await browser.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
