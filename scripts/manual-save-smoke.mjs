import { chromiumPath } from './browser-helper.mjs'
// Real UI + IndexedDB regression: explicit save is durable, includes active text,
// stays truthful during concurrent edits, handles failure/retry and document switches.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
const base = process.env.SMOKE_URL ?? 'http://localhost:5203'
const artifacts = process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-editor-save-'))
mkdirSync(artifacts, { recursive: true })
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, acceptDownloads: true })
const errors = [],
  downloads = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})
page.on('download', (d) => downloads.push(d.suggestedFilename()))
async function records() {
  return page.evaluate(async () => {
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
    return all
  })
}
try {
  await page.goto(base)
  const button = page.getByRole('button', { name: 'Speichern', exact: true })
  assert.equal(await button.count(), 0, 'no save action without an active document')
  const doc = await PDFDocument.create()
  doc.addPage([600, 800])
  const bytes = Buffer.from(await doc.save())
  await page
    .locator('input[accept="application/pdf"]')
    .setInputFiles({ name: 'save-one.pdf', mimeType: 'application/pdf', buffer: bytes })
  await page.waitForFunction(() => document.querySelector('.page canvas')?.width > 0)
  await page.waitForTimeout(700) // Finish the initial automatic empty-draft write.
  assert.match(await page.locator('.draft-save-status').textContent(), /Automatisches Speichern ist aktiv/)
  // Instrument actual writes; a keepalive request can hold transaction completion.
  await page.evaluate(() => {
    window.saveTrace = []
    window.failWrites = false
    window.holdWrites = false
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'drafts') {
        if (window.failWrites) throw new DOMException('Synthetic quota failure', 'QuotaExceededError')
        window.saveTrace.push({ at: performance.now(), record: structuredClone(args[0]) })
      }
      return put.apply(this, args)
    }
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args)
      if (args[1] === 'readwrite' && tx.objectStoreNames.contains('drafts') && window.holdWrites) {
        const keepAlive = () => {
          const r = tx.objectStore('drafts').get('__test_keepalive__')
          r.onsuccess = () => {
            if (window.holdWrites) keepAlive()
          }
        }
        keepAlive()
      }
      return tx
    }
  })
  await page.getByRole('button', { name: 'T Text', exact: true }).click()
  await page.locator('.page').click({ position: { x: 200, y: 400 } })
  const text = page.locator('.textbox textarea')
  await text.click() // Enter editing through a real focus/click before replacing text.
  await text.fill('Noch aktiv bearbeiteter Text') // Deliberately no Escape/blur.
  await page.waitForTimeout(700) // The debounced write from adding the box must be over before counting.
  const started = await page.evaluate(() => {
    window.saveTrace = []
    return performance.now()
  })
  await button.click()
  await page.getByText('✓ Entwurf gespeichert · Nur auf diesem Gerät.', { exact: true }).waitFor()
  const trace = await page.evaluate(() => window.saveTrace)
  assert.equal(trace.length, 1, 'manual save clears the debounced write instead of duplicating it')
  assert.ok(trace[0].at - started < 500, 'manual write starts before the autosave debounce')
  assert.equal(trace[0].record.overlays[0].text, 'Noch aktiv bearbeiteter Text')
  const first = (await records())[0],
    firstId = first.id
  assert.equal(first.overlays[0].text, 'Noch aktiv bearbeiteter Text')
  // Click while focused also works through keyboard activation after Tab/focus blur.
  await text.click() // Enter editing through a real focus/click before replacing text.
  await text.fill('Mit Enter gespeichert')
  await button.focus()
  await button.press('Enter')
  await page.getByText('✓ Entwurf gespeichert · Nur auf diesem Gerät.', { exact: true }).waitFor()
  assert.equal((await records())[0].overlays[0].text, 'Mit Enter gespeichert')
  // Do not announce saved until the transaction is complete; later uncommitted
  // textarea input also invalidates confirmation of the earlier snapshot.
  await page.evaluate(() => {
    window.holdWrites = true
  })
  await button.click()
  await page.getByText('Entwurf wird gespeichert …', { exact: true }).waitFor()
  assert.equal(await button.isDisabled(), true)
  await text.click() // Enter editing through a real focus/click before replacing text.
  await text.fill('Neue Eingabe während der Speicherung')
  await page.waitForTimeout(100)
  assert.equal(
    await page.getByText('✓ Entwurf gespeichert · Nur auf diesem Gerät.', { exact: true }).count(),
    0,
  )
  await page.evaluate(() => {
    window.holdWrites = false
  })
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Speichern"]').disabled)
  assert.match(await page.locator('.draft-save-status').textContent(), /Automatisches Speichern ist aktiv/)
  await button.click()
  await page.getByText('✓ Entwurf gespeichert · Nur auf diesem Gerät.', { exact: true }).waitFor()
  assert.equal((await records())[0].overlays[0].text, 'Neue Eingabe während der Speicherung')
  // Quota/private-storage failures must never produce a success confirmation.
  await page.evaluate(() => {
    window.failWrites = true
  })
  await text.click() // Enter editing through a real focus/click before replacing text.
  await text.fill('Nach einem Fehler erneut speichern')
  await button.click()
  await page.locator('.draft-save-status[role="alert"]').waitFor()
  assert.match(await page.locator('.draft-save-status').textContent(), /nicht gespeichert/)
  assert.equal(await button.isDisabled(), false)
  assert.equal((await records())[0].overlays[0].text, 'Neue Eingabe während der Speicherung')
  await page.evaluate(() => {
    window.failWrites = false
  })
  await button.click()
  await page.getByText('✓ Entwurf gespeichert · Nur auf diesem Gerät.', { exact: true }).waitFor()
  assert.equal((await records())[0].overlays[0].text, 'Nach einem Fehler erneut speichern')
  await page.screenshot({ path: join(artifacts, 'desktop-saved.png') })
  // A new document does not inherit a success/error message for the old one.
  await page
    .locator('input[accept="application/pdf"]')
    .setInputFiles({ name: 'save-two.pdf', mimeType: 'application/pdf', buffer: bytes })
  await page.getByText('save-two.pdf · 1 Seite', { exact: true }).waitFor()
  assert.match(await page.locator('.draft-save-status').textContent(), /Automatisches Speichern ist aktiv/)
  await button.click()
  await page.getByText('✓ Entwurf gespeichert · Nur auf diesem Gerät.', { exact: true }).waitFor()
  assert.equal((await records()).length, 2, 'saving does not duplicate an existing draft')
  await page.reload()
  await page.getByRole('button', { name: /Entwürfe/ }).click()
  await page.getByRole('button', { name: /^save-one\.pdf/ }).click()
  await page.waitForSelector('.textbox')
  assert.equal(await text.inputValue(), 'Nach einem Fehler erneut speichern')
  assert.equal(
    (await records()).find((r) => r.id === firstId).overlays[0].text,
    'Nach einem Fehler erneut speichern',
  )
  await page.setViewportSize({ width: 390, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await button.click()
  await page.getByText('✓ Entwurf gespeichert · Nur auf diesem Gerät.', { exact: true }).waitFor()
  const box = await button.boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390)
  await page.screenshot({ path: join(artifacts, 'mobile-saved.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: join(artifacts, 'mobile-dark-saved.png') })
  assert.deepEqual(downloads, [], 'local save does not export/download a PDF')
  assert.deepEqual(errors, [])
  console.log(
    'PASS manual local save: active text, immediate durable write, keyboard, pending edits, failure/retry, document identity, reload, narrow light/dark',
  )
} finally {
  await browser.close()
}
