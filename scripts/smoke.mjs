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
await page.locator('input[type=file][accept="application/pdf"]').setInputFiles(new URL('../tests/fixtures/zweiseitig.pdf', import.meta.url).pathname)
await page.waitForSelector('canvas')

// 0. Empty-box cleanup: create with text tool, Escape without typing -> removed
await page.getByRole('button', { name: /Text/ }).click()
await page.locator('.page').first().click({ position: { x: 500, y: 500 } })
check('Leere Box nach Erstellen vorhanden', (await page.locator('.textbox').count()) === 1)
await page.keyboard.press('Escape')
check('Esc ohne Tippen räumt leere Box weg', (await page.locator('.textbox').count()) === 0)

// 0b. Blurring into the minibar keeps the empty box (e.g. set size first)
await page.locator('.page').first().click({ position: { x: 500, y: 500 } })
await page.locator('.textbox button[aria-label="Schriftgröße"]').click()
check('Leere Box bleibt bei Minibar-Klick', (await page.locator('.textbox').count()) === 1)
check('Größen-Popover offen ohne Tippen', await page.locator('.font-size-popover').isVisible())
await page.keyboard.press('Escape') // close picker
await page.keyboard.press('Escape') // global: deselect, back to select tool
// Selecting the empty box autofocuses its textarea (Delete stays an editing
// key there); Escape blurs with focus leaving the box -> cleanup removes it.
await page.locator('.textbox .drag-surface').click({ force: true })
await page.keyboard.press('Escape')
check('Leere Box nach Auswahl + Esc entfernt', (await page.locator('.textbox').count()) === 0)

// 1. Create a textbox with the text tool
await page.getByRole('button', { name: /Text/ }).click()
await page.locator('.page').first().click({ position: { x: 200, y: 300 } })
await page.keyboard.type('Hallo Welt')
await page.keyboard.press('Escape')
check('Textbox erstellt', await page.locator('.textbox').count() === 1)

// 1b. Auto-save: after the debounce the draft must be in IndexedDB
await page.waitForTimeout(900)
const saved = await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('pdf-editor-drafts')
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  const all = await new Promise((resolve, reject) => {
    const r = db.transaction('drafts', 'readonly').objectStore('drafts').getAll()
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  const bytes = await new Promise((resolve, reject) => {
    const r = db.transaction('draft-bytes', 'readonly').objectStore('draft-bytes').getAll()
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  db.close()
  return all.map((d, index) => ({ name: d.name, texts: d.overlays.map((o) => o.text), bytes: bytes[index].byteLength }))
})
check('Entwurf automatisch in IndexedDB gespeichert', saved.length === 1 && saved[0].texts.includes('Hallo Welt'))
check('Original-PDF-Bytes im Entwurf enthalten', saved.length === 1 && saved[0].bytes > 1000)

// 2. Select it -> minibar appears
await page.locator('.textbox textarea').click({ force: true })
await page.keyboard.press('Escape')
const box = page.locator('.textbox')
check('Minibar sichtbar nach Auswahl', await box.locator('.minibar').isVisible())

// 3. Font select offers only the 3 text families; symbols are not formatting
check('3 Einträge im Schriftart-Select', (await box.locator('select[aria-label="Schriftart"] option').count()) === 3)
check('Kein Symbol-Picker in der Textbox-Leiste', (await box.locator('button[aria-label="Symbol auswählen"]').count()) === 0)

// 4. B/I/U toggle buttons switch styles on AND off again
const boldBtn = box.locator('button[aria-label="Fett"]')
await boldBtn.click()
check('B aktiviert Fett', (await box.evaluate((el) => getComputedStyle(el).fontWeight)) === '700')
await boldBtn.click()
check('B erneut deaktiviert Fett', (await box.evaluate((el) => getComputedStyle(el).fontWeight)) === '400')
const italicBtn = box.locator('button[aria-label="Kursiv"]')
await italicBtn.click()
check('I aktiviert Kursiv', (await box.evaluate((el) => getComputedStyle(el).fontStyle)) === 'italic')
await italicBtn.click()
check('I erneut deaktiviert Kursiv', (await box.evaluate((el) => getComputedStyle(el).fontStyle)) === 'normal')
const underlineBtn = box.locator('button[aria-label="Unterstrichen"]')
const ta = box.locator('textarea')
await underlineBtn.click()
check('U aktiviert Unterstrichen (im Text)', ((await ta.evaluate((el) => getComputedStyle(el).textDecorationLine))).includes('underline'))
await underlineBtn.click()
check('U erneut deaktiviert Unterstrichen', !((await ta.evaluate((el) => getComputedStyle(el).textDecorationLine))).includes('underline'))

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

// 14b. Symbols are a separate placement tool, not textbox formatting
await page.getByRole('button', { name: 'Symbol auswählen' }).click()
const symbolPalette = page.locator('.toolbar .symbol-popover')
check('Symbol-Palette in der Haupt-Toolbar (16 Symbole)', (await symbolPalette.locator('button').count()) === 16)
await symbolPalette.getByRole('button', { name: 'Symbol ✓' }).click()
check('Symbol-Werkzeug aktiv', await page.getByRole('button', { name: 'Symbol auswählen' }).getAttribute('aria-pressed') === 'true')
await page.locator('.page').first().click({ position: { x: 500, y: 500 } })
const symbolBox = page.locator('.textbox').nth(1)
check('Symbol als eigene Box platziert', (await page.locator('.textbox').count()) === 2)
check('Symbolbox enthält ✓', (await symbolBox.locator('textarea').inputValue()) === '✓')
check('Symbolbox ist schreibgeschützt', (await symbolBox.locator('textarea').getAttribute('readonly')) !== null)
await symbolBox.locator('textarea').click({ force: true })
await page.keyboard.type('abc')
check('Symbol lässt sich nicht mit Text mischen', (await symbolBox.locator('textarea').inputValue()) === '✓')
check('Symbolbox zeigt keine B/I/U-Buttons', (await symbolBox.locator('button[aria-label="Fett"]').count()) === 0)
await symbolBox.locator('button[aria-label="Textbox löschen"]').click()
check('Symbolbox wieder gelöscht', (await page.locator('.textbox').count()) === 1)
await page.waitForTimeout(900)

// 15. Draft menu: active draft is listed with useful metadata
await page.getByRole('button', { name: /Entwürfe/ }).click()
const menu = page.locator('.drafts-menu')
check('Entwürfe-Menü öffnet', await menu.isVisible())
check(
  'Entwurfsliste nutzt einfache Gruppen-Semantik',
  (await page.locator('.drafts-menu[role="menu"]').count()) === 0 &&
    (await page.locator('.drafts-menu [role="menuitemradio"]').count()) === 0,
)
check('Aktiver Entwurf ist markiert', (await page.locator('.draft-row.active .draft-badge').textContent()) === 'Aktiv')
check(
  'Entwurf zeigt Änderungszahl',
  ((await page.locator('.draft-row.active .draft-meta').textContent()) ?? '').includes('1 Änderung'),
)
await page.keyboard.press('Escape')
check('Esc schließt Entwürfe-Menü', (await menu.count()) === 0)

// 16. Multiple drafts: open a second PDF, edit it, then switch back
await page.locator('input[type=file][accept="application/pdf"]').setInputFiles(new URL('../tests/fixtures/zweiseitig.pdf', import.meta.url).pathname)
await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('.textbox'))
check('Neue PDF startet ohne alte Boxen', (await page.locator('.textbox').count()) === 0)
await page.getByRole('button', { name: /Text/ }).click()
await page.locator('.page').first().click({ position: { x: 220, y: 320 } })
await page.keyboard.type('Zweiter Entwurf')
await page.keyboard.press('Escape')
await page.waitForTimeout(900)
const draftCount = await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('pdf-editor-drafts')
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  const all = await new Promise((resolve, reject) => {
    const r = db.transaction('drafts', 'readonly').objectStore('drafts').getAll()
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  db.close()
  return all.length
})
check('Zwei Entwürfe liegen parallel in IndexedDB', draftCount === 2)
await page.getByRole('button', { name: /Entwürfe/ }).click()
const draftRows = page.locator('.drafts-menu .draft-open')
check('Menü listet beide Entwürfe', (await draftRows.count()) === 2)
await draftRows.nth(1).click()
await page.waitForFunction(() => document.querySelector('.textbox textarea')?.value === 'Hallo Welt')
check('Wechsel lädt ersten Entwurf zurück', (await page.locator('.textbox textarea').inputValue()) === 'Hallo Welt')

// 17. Full reload: the chosen draft survives closing/reopening the tab
await page.waitForTimeout(900) // let the restore-triggered save update the order
await page.reload()
await page.getByRole('button', { name: /Entwürfe/ }).click()
check('Entwürfe überleben Reload', (await page.locator('.drafts-menu .draft-open').count()) === 2)
await page.locator('.drafts-menu .draft-open').first().click()
await page.waitForSelector('.textbox textarea')
check('Reload + Öffnen stellt Overlay wieder her', (await page.locator('.textbox textarea').inputValue()) === 'Hallo Welt')

// 18. Delete current and remaining draft from the menu
await page.getByRole('button', { name: /Entwürfe/ }).click()
const activeDeleteButton = page.getByRole('button', { name: /Entwurf „zweiseitig.pdf“ löschen/ }).first()
await activeDeleteButton.focus()
page.once('dialog', (dialog) => void dialog.accept())
await page.keyboard.press(' ')
await page.waitForFunction(() => !document.querySelector('canvas'))
check('Aktiven Entwurf per Leertaste löschen schließt Dokument', (await page.locator('canvas').count()) === 0)
check('Ein Entwurf bleibt nach dem Löschen übrig', (await page.locator('.drafts-menu .draft-open').count()) === 1)
const remainingDeleteButton = page.getByRole('button', { name: /Entwurf „zweiseitig.pdf“ löschen/ }).first()
await remainingDeleteButton.focus()
page.once('dialog', (dialog) => void dialog.accept())
await page.keyboard.press('Enter')
await page.waitForFunction(() => document.querySelectorAll('.drafts-menu .draft-open').length === 0)
check('Letzten Entwurf per Enter löschen leert die Liste', (await page.locator('.drafts-menu .draft-open').count()) === 0)
check('Leerzustand im Entwürfe-Menü', await page.getByText('Keine Entwürfe vorhanden.').isVisible())

check('Keine Konsolen-/Seitenfehler', errors.length === 0)
if (errors.length) console.log(errors.join('\n'))

console.log(results.join('\n'))
await browser.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
