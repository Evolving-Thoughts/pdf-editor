import { collectErrors, launchBrowser, pdfInput, revealInPages } from './browser-helper.mjs'
import {
  confirmDefaultExport,
  openProtectedExport,
} from './export-smoke-helper.mjs'
import { PNG_DATA_URL } from '../tests/imageFixtures.js'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const out =
  process.env.SMOKE_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'pdf-search-'))
mkdirSync(out, { recursive: true })
const fixtures = JSON.parse(
  readFileSync(
    new URL('../tests/pdfEncryptionFixtures.json', import.meta.url),
    'utf8',
  ),
).pdfs
const browser = await launchBrowser()
const p = await browser.newPage({
    viewport: { width: 1280, height: 1100 },
    acceptDownloads: true,
  }),
  errors = []
collectErrors(p, errors)
const btn = (name) => p.getByRole('button', { name, exact: true })
const input = () => p.getByRole('textbox', { name: 'Suchtext', exact: true })
async function open(bytes, name = 'search.pdf') {
  await pdfInput(p).setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: Buffer.from(bytes),
  })
  await p.waitForFunction(() => !document.querySelector('.toolbar')?.inert)
  await p.locator('.pages .page canvas').first().waitFor()
  await p.waitForFunction(
    () => document.querySelector('.pages .page canvas')?.width > 0,
  )
}
async function query(text, count) {
  await input().fill(text)
  await p.waitForFunction(
    (count) =>
      document.querySelector('.search-controls [role=status]')?.textContent ===
      `${count ? 1 : 0} / ${count}`,
    count,
  )
}
async function drop(bytes, name = 'dropped.pdf', files = 1) {
  await p.evaluate(
    ({ bytes, name, files }) => {
      const dt = new DataTransfer()
      for (let i = 0; i < files; i++)
        dt.items.add(
          new File([new Uint8Array(bytes)], name, { type: 'application/pdf' }),
        )
      document.querySelector('.pages .page, .workspace').dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      )
    },
    { bytes: Array.from(bytes), name, files },
  )
}
async function download(action, file) {
  const pending = p.waitForEvent('download')
  await btn(action).click()
  if (action === 'Exportieren') await confirmDefaultExport(p)
  const d = await pending
  await d.saveAs(join(out, file))
  return new Uint8Array(readFileSync(join(out, file)))
}
try {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica)
  doc
    .addPage([600, 800])
    .drawText('Antrag first page', { x: 50, y: 700, size: 20, font })
  const rotated = doc.addPage([600, 800])
  rotated.setRotation(degrees(90))
  rotated.drawText('Antrag rotated page', { x: 50, y: 700, size: 20, font })
  const bytes = await doc.save()
  await p.goto(process.env.SMOKE_URL ?? 'http://localhost:5221')
  await open(bytes)
  await p.keyboard.press('Control+f')
  await input().waitFor()
  await query('Antrag', 2)
  assert.equal(await p.locator('[data-search-active=true]').count(), 1)
  await btn('Nächster Treffer').click()
  assert.equal(
    await p.locator('.search-controls [role=status]').textContent(),
    '2 / 2',
  )
  await p.waitForFunction(
    () =>
      document.querySelector('[data-search-active=true]')?.closest('.page')
        .dataset.pageIndex === '1',
  )
  const current = await p
    .locator('[data-search-active=true]')
    .evaluate((el) => ({
      page: el.closest('.page').dataset.pageIndex,
      box: el.getBoundingClientRect().toJSON(),
    }))
  assert.equal(current.page, '1')
  assert.ok(current.box.width > 0 && current.box.height > 0)
  await input().press('Enter')
  assert.equal(
    await p.locator('.search-controls [role=status]').textContent(),
    '1 / 2',
  )
  await input().press('Shift+Enter')
  assert.equal(
    await p.locator('.search-controls [role=status]').textContent(),
    '2 / 2',
  )
  await query('<script>alert(1)</script>', 0)
  assert.equal(await btn('Nächster Treffer').isDisabled(), true)
  await query('Antrag', 2)
  await btn('Rechteck').click()
  const box = await p.locator('.page').first().boundingBox()
  await p.mouse.move(box.x + 60, box.y + 200)
  await p.mouse.down()
  await p.mouse.move(box.x + 160, box.y + 280, { steps: 4 })
  await p.mouse.up()
  await p.locator('.shape-overlay').first().waitFor({ state: 'attached' })
  await btn('⬚ Auswahl').click()
  await p.setViewportSize({ width: 1280, height: 500 })
  await btn('Nächster Treffer').click()
  await p.waitForFunction(
    () => document.querySelector('.pages').scrollTop > 100,
  )
  await p.locator('.pages').evaluate((el) => {
    el.scrollTop = 0
  })
  await p.waitForTimeout(300)
  await btn('Rückgängig').click()
  await p.locator('.shape-overlay').waitFor({ state: 'detached' })
  await p.waitForTimeout(300)
  assert.equal(
    await p.locator('.pages').evaluate((el) => el.scrollTop),
    0,
    'an edit elsewhere leaves the view where it is',
  )
  await p.setViewportSize({ width: 1280, height: 1100 })
  for (const width of [1280, 390]) {
    await p.setViewportSize({ width, height: 1100 })
    const controls = await p
      .locator('.search-controls button')
      .evaluateAll((nodes) =>
        nodes.map((el) => el.getBoundingClientRect().toJSON()),
      )
    assert.equal(
      await p
        .locator('.search-window')
        .evaluate((el) => el.parentElement.classList.contains('workspace')),
      true,
    )
    assert.equal(controls.length, 3)
    assert.ok(
      controls.every((c) => Math.abs(c.y - controls[0].y) < 1),
      `Search controls must share a row: ${JSON.stringify({ width, controls })}`,
    )
    assert.ok(
      controls.every((c) => c.x >= 0 && c.x + c.width <= width),
      `Search controls must fit viewport: ${JSON.stringify({ width, controls })}`,
    )
    const activeBox = await p
        .locator('[data-search-active=true]')
        .boundingBox(),
      panelBox = await p.locator('.search-window').boundingBox()
    assert.ok(
      !(
        activeBox.x < panelBox.x + panelBox.width &&
        activeBox.x + activeBox.width > panelBox.x &&
        activeBox.y < panelBox.y + panelBox.height &&
        activeBox.y + activeBox.height > panelBox.y
      ),
      `Active match must not be covered by the search window: ${JSON.stringify({ width, activeBox, panelBox })}`,
    )
    await p.screenshot({
      path: join(out, `search-${width}.png`),
      fullPage: true,
    })
  }
  await p.setViewportSize({ width: 1280, height: 1100 })
  await input().press('Escape')
  assert.equal(await p.locator('.search-window').count(), 0)
  assert.equal(await p.locator('.search-highlights').count(), 0)
  // Real text-page insertion through the existing page-management UI.
  await btn('Seiten verwalten').click()
  await btn('＋ Seiten einfügen').click()
  await p.getByLabel('Quelle', { exact: true }).selectOption('text')
  await p.locator('.page-insert-dialog textarea').fill('InsertedOnly Antrag')
  await p
    .locator('.page-insert-dialog')
    .getByRole('button', { name: 'Einfügen', exact: true })
    .click()
  await p.locator('.page-insert-dialog').waitFor({ state: 'detached' })
  await btn('Zur Dokumentbearbeitung').click()
  await p.locator('.pages .page').nth(2).waitFor()
  await btn('Suchen').click()
  await query('InsertedOnly', 1)
  assert.equal(
    await p
      .locator('[data-search-active=true]')
      .evaluate((el) => el.closest('.page').dataset.pageIndex),
    '2',
  )
  await btn('Suche schließen').click()
  await btn('T Text').click()
  const page = p.locator('.pages .page').nth(2)
  await page.scrollIntoViewIfNeeded()
  const r = await page.boundingBox()
  await p.mouse.click(r.x + 70, r.y + 130)
  await p.locator('.textbox textarea').fill('OverlayUnique Antrag')
  await p.locator('.textbox textarea').press('Escape')
  await btn('Suchen').click()
  await query('OverlayUnique', 1)
  await query('Antrag', 4)
  const hitCount = (count) =>
    p.waitForFunction(
      (count) =>
        document
          .querySelector('.search-controls [role=status]')
          ?.textContent.endsWith(`/ ${count}`),
      count,
    )
  await page.scrollIntoViewIfNeeded()
  await btn('T Text').click()
  const live = await page.boundingBox()
  await p.mouse.click(live.x + 70, live.y + 230)
  await p.locator('.textbox textarea:focus').waitFor()
  await p.locator('.textbox textarea:focus').fill('Antrag live')
  await input().click()
  await hitCount(5)
  while ((await p.locator('.textbox').count()) > 1) {
    await btn('Rückgängig').click()
  }
  await hitCount(4)
  await btn('Suche schließen').click()
  await btn('Speichern').click()
  await p.waitForFunction(() =>
    document
      .querySelector('.draft-save-status')
      ?.textContent.includes('Entwurf gespeichert'),
  )
  await p.reload()
  await p.getByRole('button', { name: /Entwürfe/ }).click()
  await p.locator('.draft-open').first().click()
  await revealInPages(p, '.textbox textarea')
  await btn('Suchen').click()
  await query('InsertedOnly', 1)
  await query('OverlayUnique', 1)
  await btn('Suche schließen').click()
  // Plain drop opens a new document; invalid/multiple files retain the old one.
  await drop(bytes, 'dropped.pdf')
  await p.waitForFunction(
    () =>
      document
        .querySelector('.file-name')
        ?.textContent.includes('dropped.pdf') ||
      document.querySelector('.toolbar')?.textContent.includes('dropped.pdf'),
  )
  await p.waitForFunction(() => !document.querySelector('.toolbar').inert)
  assert.equal(await p.locator('.pages .page').count(), 2)
  // PDF drop capture must not steal the existing image-on-page drop.
  await p
    .locator('.pages .page')
    .nth(1)
    .evaluate((el, data) => {
      const dt = new DataTransfer(),
        rect = el.getBoundingClientRect()
      dt.items.add(
        new File(
          [Uint8Array.from(atob(data.split(',')[1]), (c) => c.charCodeAt(0))],
          'drop.png',
          { type: 'image/png' },
        ),
      )
      el.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: rect.left + 180,
          clientY: rect.top + 180,
        }),
      )
    }, PNG_DATA_URL)
  await p.locator('.pages .page').nth(1).locator('.image-overlay').waitFor()
  assert.equal(await p.locator('.image-overlay').count(), 1)
  await drop(bytes, 'multiple.pdf', 2)
  await p.getByRole('alert').waitFor()
  assert.equal(await p.locator('.pages .page').count(), 2)
  await drop([1, 2, 3], 'broken.pdf')
  await p.waitForFunction(() => !document.querySelector('.toolbar').inert)
  assert.ok(
    (await p.getByRole('alert').textContent()).includes('bisherige Stand'),
  )
  assert.equal(await p.locator('.pages .page').count(), 2)
  // Encrypted drop, incorrect password, cancel, retry and actual decrypted editor.
  const encrypted = Buffer.from(fixtures.aes256, 'base64')
  await drop(encrypted, 'encrypted.pdf')
  await p.getByRole('dialog').waitFor()
  assert.ok(
    (await p.getByRole('dialog').textContent()).includes('unverschlüsselt'),
  )
  await p.getByLabel('PDF-Passwort', { exact: true }).fill('wrong')
  await p
    .getByRole('dialog')
    .getByRole('button', { name: 'PDF öffnen', exact: true })
    .click()
  await p.getByRole('dialog').getByRole('alert').waitFor()
  assert.ok(
    (await p.getByRole('dialog').getByRole('alert').textContent()).includes(
      'falsch',
    ),
  )
  assert.equal(
    await p.getByLabel('PDF-Passwort', { exact: true }).inputValue(),
    '',
  )
  assert.ok((await p.locator('.toolbar').textContent()).includes('dropped.pdf'))
  await p.keyboard.press('Escape')
  await p.getByRole('dialog').waitFor({ state: 'detached' })
  assert.equal(await p.locator('.pages .page').count(), 2)
  await drop(encrypted, 'encrypted.pdf')
  await p.getByRole('dialog').waitFor()
  await p.getByLabel('PDF-Passwort', { exact: true }).fill('demo')
  await p
    .getByRole('dialog')
    .getByRole('button', { name: 'PDF öffnen', exact: true })
    .click()
  await p.getByRole('dialog').waitFor({ state: 'detached' })
  await p.getByRole('textbox', { name: 'Name', exact: true }).waitFor()
  assert.equal(
    await p.getByRole('textbox', { name: 'Name', exact: true }).inputValue(),
    'Ada',
  )
  await p.getByRole('textbox', { name: 'Name', exact: true }).fill('Grace')
  await p.getByRole('textbox', { name: 'Name', exact: true }).press('Tab')
  await btn('Suchen').click()
  await query('Searchable', 1)
  await btn('Suche schließen').click()
  const plain = await download('Exportieren', 'plain.pdf')
  assert.equal(
    (await PDFDocument.load(plain)).getForm().getTextField('Name').getText(),
    'Grace',
  )
  // Password protection is now an explicit option in the shared export dialog.
  await openProtectedExport(p)
  await p.getByLabel('Export-Passwort', { exact: true }).fill('export-demo')
  await p.getByLabel('Passwort wiederholen', { exact: true }).fill('mismatch')
  await btn('Geschützt exportieren').click()
  assert.ok(
    (await p.getByRole('dialog').getByRole('alert').textContent()).includes(
      'nicht überein',
    ),
  )
  await p
    .getByLabel('Passwort wiederholen', { exact: true })
    .fill('export-demo')
  const protectedBytes = await download(
    'Geschützt exportieren',
    'protected.pdf',
  )
  await assert.rejects(() => PDFDocument.load(protectedBytes))
  // The dialog closes just after the download has started.
  await p.locator('.password-dialog').waitFor({ state: 'detached' })
  // Verify browser PDF.js can open the AES output using the provided password.
  const result = await p.evaluate(async (data) => {
    const { getDocument, GlobalWorkerOptions } =
      await import('/node_modules/pdfjs-dist/build/pdf.mjs')
    GlobalWorkerOptions.workerSrc =
      '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
    const task = getDocument({
      data: new Uint8Array(data),
      password: 'export-demo',
    })
    try {
      const doc = await task.promise
      return {
        text: (await (await doc.getPage(1)).getTextContent()).items
          .map((i) => i.str ?? '')
          .join(' '),
        fields: (await (await doc.getPage(1)).getAnnotations()).map(
          (a) => a.fieldValue,
        ),
      }
    } finally {
      await task.destroy()
    }
  }, Array.from(protectedBytes))
  assert.ok(result.text.includes('Searchable secret fixture'))
  assert.ok(result.fields.includes('Grace'))
  await btn('Speichern').click()
  await p.waitForFunction(() =>
    document
      .querySelector('.draft-save-status')
      ?.textContent.includes('Entwurf gespeichert'),
  )
  const stored = await p.evaluate(async () => {
    const open = indexedDB.open('pdf-editor-drafts')
    const db = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result)
      open.onerror = () => rej(open.error)
    })
    const tx = db.transaction(['drafts', 'draft-bytes'], 'readonly'),
      records = tx.objectStore('drafts').getAll(),
      bytes = tx.objectStore('draft-bytes').getAll()
    await new Promise((res, rej) => {
      tx.oncomplete = res
      tx.onerror = rej
    })
    db.close()
    return {
      records: records.result,
      bytes: bytes.result.map((b) =>
        Array.from(new Uint8Array(b.pdfBytes ?? b.bytes ?? b)),
      ),
    }
  })
  assert.ok(!JSON.stringify(stored.records).includes('export-demo'))
  assert.ok(stored.records.every((record) => !('password' in record)))
  writeFileSync(
    join(out, 'stored-records.json'),
    JSON.stringify(stored.records, null, 2),
  )
  await p.reload()
  await p.getByRole('button', { name: /Entwürfe/ }).click()
  await p.locator('.draft-open').first().click()
  await p.getByRole('textbox', { name: 'Name', exact: true }).waitFor()
  assert.equal(
    await p.getByRole('textbox', { name: 'Name', exact: true }).inputValue(),
    'Grace',
  )
  assert.equal(await p.getByRole('dialog').count(), 0)
  await p.setViewportSize({ width: 390, height: 900 })
  await p.emulateMedia({ colorScheme: 'dark' })
  await openProtectedExport(p)
  await p.screenshot({
    path: join(out, 'protected-export-mobile-dark.png'),
    fullPage: true,
  })
  await btn('Abbrechen').click()
  // Modal Escape must cancel the dialog, not be intercepted by an open search.
  await p.setViewportSize({ width: 1280, height: 1100 })
  await p.emulateMedia({ colorScheme: 'light' })
  await btn('Suchen').click()
  await query('Searchable', 1)
  await openProtectedExport(p)
  await p.keyboard.press('Escape')
  assert.equal(await p.getByRole('dialog').count(), 0)
  assert.equal(await p.locator('.search-window').count(), 1)
  await btn('Suche schließen').click()
  await p.waitForFunction(
    () =>
      document.querySelector(
        '.toolbar-navigation button[title="Im Dokument suchen (Strg/⌘+F)"]',
      ) === document.activeElement,
    null,
    { timeout: 5000 },
  )
  // Search and protected export respect actual T10 rasterization.
  const redact = await PDFDocument.create(),
    a = redact.addPage([600, 800]),
    b = redact.addPage([600, 800])
  a.drawText('REDACTION-SECRET', { x: 40, y: 600, size: 20 })
  b.drawText('PUBLIC-REMAINS', { x: 40, y: 600, size: 20 })
  await open(await redact.save(), 'redaction-search.pdf')
  await btn('Suchen').click()
  await query('REDACTION-SECRET', 1)
  await btn('Suche schließen').click()
  await btn('Schwärzen').click()
  const page1 = p.locator('.pages .page').first()
  await page1.scrollIntoViewIfNeeded()
  const rr = await page1.boundingBox()
  await p.mouse.move(rr.x + 30, rr.y + 160)
  await p.mouse.down()
  await p.mouse.move(rr.x + 390, rr.y + 260, { steps: 4 })
  await p.mouse.up()
  assert.equal(await btn('Exportieren').isDisabled(), true)
  await btn('Schwärzung anwenden …').click()
  await btn('Jetzt wirklich schwärzen').click()
  await p.waitForFunction(() => !document.querySelector('.redaction-overlay'))
  await p.waitForFunction(
    () =>
      !document.querySelector(
        '.toolbar button[title="Im Dokument suchen (Strg/⌘+F)"]',
      )?.disabled,
  )
  await btn('Suchen').click()
  await query('REDACTION-SECRET', 0)
  await query('PUBLIC-REMAINS', 1)
  await btn('Suche schließen').click()
  await btn('T Text').click()
  await page1.scrollIntoViewIfNeeded()
  const rt = await page1.boundingBox()
  await p.mouse.click(rt.x + 60, rt.y + 200)
  await p.locator('.textbox textarea').fill('NEW-VISIBLE')
  await p.locator('.textbox textarea').press('Escape')
  await btn('Suchen').click()
  await query('NEW-VISIBLE', 1)
  await query('REDACTION-SECRET', 0)
  await btn('Suche schließen').click()
  await openProtectedExport(p)
  await p.getByLabel('Export-Passwort', { exact: true }).fill('safe-export')
  await p
    .getByLabel('Passwort wiederholen', { exact: true })
    .fill('safe-export')
  await download('Geschützt exportieren', 'protected-redacted.pdf')
  assert.deepEqual(errors, [])
  console.log(
    'PASS: real PDF and rotated-page search, inserted text page, live overlays, shortcuts, literal/no-result cases, draft restoration, same-row arrows+close at desktop/mobile; real PDF drop, existing image-on-page drop, invalid/multiple preservation; wrong/cancel/correct encrypted open; editable forms; plaintext and AES-256 export, confirmation mismatch; independent PDF.js readback; no stored password; draft reopen; dark mobile dialog; modal Escape/focus; rasterized original exclusion and searchable replacement; protected redacted export; no page errors.',
  )
} finally {
  await browser.close()
}
