import { chromium } from 'playwright'

const results = []
const check = (name, ok) => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}`)

// Chromium binary: set CHROMIUM_PATH on systems without a Playwright browser
// download (e.g. CI/sandboxes); otherwise Playwright's own browser is used.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
)
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const baseUrl = process.env.SMOKE_URL ?? 'http://localhost:5199'
await page.goto(baseUrl)
const fileInput = page.locator('input[type=file]')
await fileInput.setInputFiles('/data/pdf-editor/tests/fixtures/zweiseitig.pdf')
await page.waitForSelector('canvas')

// 1. Create a textbox with the text tool
await page.getByRole('button', { name: /Text/ }).click()
const page1 = page.locator('.page').first()
await page1.click({ position: { x: 200, y: 200 } })
await page.keyboard.type('Hallo Welt')
await page.keyboard.press('Escape')
check('Textbox erstellt', await page.locator('.textbox').count() === 1)

// 2. Select it in select mode
await page.locator('.textbox textarea').click({ force: true })
await page.keyboard.press('Escape') // blur textarea, stay selected
const box = page.locator('.textbox')
check('Minibar sichtbar nach Auswahl', await box.locator('.minibar').isVisible())

// 3. Free font size: type 13.5
const sizeInput = box.locator('input[aria-label="Schriftgröße"]')
await sizeInput.click()
await sizeInput.fill('13.5')
await sizeInput.press('Enter')
const fontSize = await box.evaluate((el) => getComputedStyle(el).fontSize)
check(`Freie Schriftgröße 13.5 übernommen (${fontSize})`, fontSize === '13.5px')

// 4. Datalist presets exist
check('Vorschläge (datalist) vorhanden', await page.locator('datalist option').count() === 7)

// 5. Invalid input reverts
await sizeInput.click()
await sizeInput.fill('999')
await sizeInput.press('Enter')
check('Zu große Eingabe auf 200 geclamped', (await sizeInput.inputValue()) === '200')
// back to 13.5 for the following checks
await sizeInput.click()
await sizeInput.fill('13.5')
await sizeInput.press('Enter')

// 6. Arrow-key nudge: 1pt left, Shift+Up 10pt up
const before = await box.boundingBox()
await page.keyboard.press('ArrowLeft')
await page.keyboard.press('Shift+ArrowUp')
const after = await box.boundingBox()
check(`Pfeil-Nudge links 1px (dx=${after.x - before.x})`, Math.round(after.x - before.x) === -1)
check(`Shift-Nudge oben 10px (dy=${after.y - before.y})`, Math.round(after.y - before.y) === -10)

// 7. Merged undo: one Ctrl+Z reverts both nudges
await page.keyboard.press('Control+z')
const undone = await box.boundingBox()
check('Ein Undo macht beide Nudges rückgängig',
  Math.round(undone.x) === Math.round(before.x) && Math.round(undone.y) === Math.round(before.y))

// 8. Redo restores
await page.keyboard.press('Control+y')
const redone = await box.boundingBox()
check('Redo stellt Nudges wieder her', Math.round(redone.x - before.x) === -1)

// 9. Escape switches to select tool
await page.keyboard.press('Escape')
check('Esc → Auswahl-Tool aktiv', await page.getByRole('button', { name: /Auswahl/ }).getAttribute('aria-pressed') === 'true')

check('Keine Konsolen-/Seitenfehler', errors.length === 0)
if (errors.length) console.log(errors.join('\n'))

console.log(results.join('\n'))
await browser.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
