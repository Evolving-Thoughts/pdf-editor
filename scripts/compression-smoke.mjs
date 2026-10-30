import { chromiumPath } from './browser-helper.mjs'
// T12 approved A: real image optimization, preservation and combined encryption.
import { chromium } from 'playwright'
import { PDFDocument, PDFRawStream, PDFName, PDFNumber } from 'pdf-lib'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const out =
  process.env.SMOKE_ARTIFACT_DIR ??
  mkdtempSync(join(tmpdir(), 'pdf-compression-'))
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--no-sandbox'],
})
const p = await browser.newPage({
    viewport: { width: 1280, height: 1100 },
    acceptDownloads: true,
  }),
  errors = []
p.on('pageerror', (e) => errors.push(String(e)))
const btn = (name) => p.getByRole('button', { name, exact: true })
const comp = () => p.getByRole('radio', { name: /Bilddaten komprimieren/ })
const protect = () => p.getByRole('checkbox', { name: /Mit Passwort schützen/ })
const dialog = () => p.getByRole('dialog')
async function open(bytes, name = 'compression.pdf') {
  await p.locator('input[accept="application/pdf"]').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: Buffer.from(bytes),
  })
  await p.locator('.pages .page canvas').first().waitFor()
}
async function save(action, file) {
  const event = p.waitForEvent('download')
  await btn(action).click()
  await (await event).saveAs(join(out, file))
  return new Uint8Array(readFileSync(join(out, file)))
}
async function initial() {
  await btn('Exportieren').click()
  assert.equal(await comp().isChecked(), false)
  assert.equal(await protect().isChecked(), false)
  assert.equal(await btn('Mit Passwort exportieren …').count(), 0)
}
async function prepare() {
  await comp().check()
  await btn('Export vorbereiten').click()
  await p
    .getByRole('dialog', { name: 'Export vorbereitet' })
    .waitFor({ timeout: 60000 })
}
async function draft() {
  await btn('Speichern').click()
  await p.waitForFunction(() =>
    document
      .querySelector('.draft-save-status')
      ?.textContent.includes('Entwurf gespeichert'),
  )
  return p.evaluate(async () => {
    const request = indexedDB.open('pdf-editor-drafts'),
      db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const tx = db.transaction(
      ['drafts', 'draft-bytes', 'image-assets'],
      'readonly',
    )
    const requests = ['drafts', 'draft-bytes', 'image-assets'].map((name) =>
      tx.objectStore(name).getAll(),
    )
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    const result = JSON.stringify(
      requests.map((r) => r.result),
      (key, value) =>
        value instanceof ArrayBuffer
          ? Array.from(new Uint8Array(value))
          : value,
    )
    db.close()
    return result
  })
}
async function inspect(bytes, password) {
  return p.evaluate(
    async ({ data, password }) => {
      const { getDocument, GlobalWorkerOptions } =
        await import('/node_modules/pdfjs-dist/build/pdf.mjs')
      GlobalWorkerOptions.workerSrc =
        '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
      const task = getDocument({ data: new Uint8Array(data), password }),
        doc = await task.promise,
        rows = []
      try {
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i),
            viewport = page.getViewport({ scale: 1 }),
            canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          await page.render({ canvas, viewport }).promise
          rows.push({
            text: (await page.getTextContent()).items
              .map((item) => item.str ?? '')
              .join(' '),
            fields: (await page.getAnnotations())
              .filter((a) => a.subtype === 'Widget')
              .map((a) => [a.fieldName, a.fieldValue]),
            size: [viewport.width, viewport.height],
            pixel: Array.from(
              canvas.getContext('2d').getImageData(100, 200, 1, 1).data,
            ),
          })
          canvas.width = canvas.height = 0
        }
        return rows
      } finally {
        await task.destroy()
      }
    },
    { data: Array.from(bytes), password },
  )
}
try {
  await p.goto(process.env.SMOKE_URL ?? 'http://localhost:5221')
  // An ordinary opaque RGB image, text and native forms, with another vector page.
  const doc = await PDFDocument.create(),
    a = doc.addPage([600, 800]),
    b = doc.addPage([600, 800])
  const rgb = new Uint8Array(768 * 1024 * 3)
  let seed = 1212
  for (let i = 0; i < rgb.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    rgb[i] = seed >>> 24
  }
  const image = doc.context.register(
    doc.context.flateStream(rgb, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 768,
      Height: 1024,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    }),
  )
  a.node.set(
    PDFName.of('Resources'),
    doc.context.obj({ XObject: { Photo: image } }),
  )
  a.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream('q 600 0 0 800 0 0 cm /Photo Do Q'),
    ),
  )
  a.drawText('SECRET-PRIVATE', { x: 40, y: 600, size: 20 })
  b.drawText('PUBLIC-VECTOR-PAGE', { x: 40, y: 600, size: 20 })
  const privateField = doc.getForm().createTextField('Private')
  privateField.setText('SECRET-FIELD')
  privateField.addToPage(a, { x: 40, y: 520, width: 250, height: 26 })
  const publicField = doc.getForm().createTextField('Public')
  publicField.setText('Keep editable')
  publicField.addToPage(b, { x: 40, y: 520, width: 250, height: 26 })
  const input = await doc.save(),
    before = input.slice()
  await open(input)
  await p.getByRole('textbox', { name: 'Private', exact: true }).waitFor()
  const originalDraft = await draft()
  await initial()
  await p.screenshot({ path: join(out, 'export-default-desktop.png') })
  const plain = await save('Ohne Optimierung exportieren', 'plain.pdf')
  await initial()
  await prepare()
  await p.screenshot({ path: join(out, 'prepared-desktop.png') })
  const optimized = await save('Kleinere Datei speichern', 'compressed.pdf')
  assert.ok(optimized.length < plain.length)
  const parsedPlain = await inspect(plain),
    parsedOptimized = await inspect(optimized)
  assert.deepEqual(
    parsedOptimized.map(({ text, fields, size }) => ({ text, fields, size })),
    parsedPlain.map(({ text, fields, size }) => ({ text, fields, size })),
  )
  const edit = await PDFDocument.load(optimized)
  edit.getForm().getTextField('Public').setText('Later edit')
  assert.equal(
    (await PDFDocument.load(await edit.save()))
      .getForm()
      .getTextField('Public')
      .getText(),
    'Later edit',
  )
  // The explicit original-size fallback uses the SAME prepared baseline.
  await initial()
  await prepare()
  const originalFallback = await save(
    'Stattdessen ohne Optimierung exportieren',
    'fallback.pdf',
  )
  assert.deepEqual(await inspect(originalFallback), parsedPlain)
  // Password confirmation, defaults on reopening, and combination with compression.
  await initial()
  await protect().check()
  await p.getByLabel('Export-Passwort', { exact: true }).fill('t12-demo')
  await p.getByLabel('Passwort wiederholen', { exact: true }).fill('wrong')
  await comp().check()
  await btn('Export vorbereiten').click()
  assert.match(await dialog().getByRole('alert').innerText(), /nicht überein/)
  await p.getByLabel('Passwort wiederholen', { exact: true }).fill('t12-demo')
  await btn('Export vorbereiten').click()
  await p.getByRole('dialog', { name: 'Export vorbereitet' }).waitFor()
  const encrypted = await save(
    'Kleinere Datei speichern',
    'encrypted-compressed.pdf',
  )
  await assert.rejects(() => PDFDocument.load(encrypted))
  assert.deepEqual(
    (await inspect(encrypted, 't12-demo')).map(({ text, fields, size }) => ({
      text,
      fields,
      size,
    })),
    parsedOptimized.map(({ text, fields, size }) => ({ text, fields, size })),
  )
  await initial()
  await p.keyboard.press('Escape')
  assert.equal(await dialog().count(), 0)
  // Export settings/passwords cannot change persisted document data.
  const afterDraft = await p.evaluate(async () => {
    const request = indexedDB.open('pdf-editor-drafts'),
      db = await new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result)
      }),
      tx = db.transaction(
        ['drafts', 'draft-bytes', 'image-assets'],
        'readonly',
      ),
      requests = ['drafts', 'draft-bytes', 'image-assets'].map((name) =>
        tx.objectStore(name).getAll(),
      )
    await new Promise((resolve) => {
      tx.oncomplete = resolve
    })
    const result = JSON.stringify(
      requests.map((r) => r.result),
      (key, value) =>
        value instanceof ArrayBuffer
          ? Array.from(new Uint8Array(value))
          : value,
    )
    db.close()
    return result
  })
  assert.equal(afterDraft, originalDraft)
  assert.ok(!afterDraft.includes('t12-demo'))
  // Cancel after preparation: no download; next open is defaults-off again.
  await initial()
  await prepare()
  await btn('Abbrechen').click()
  await initial()
  assert.equal(await comp().isChecked(), false)
  await p.keyboard.press('Escape')
  // Cancel while the worker runs: no late download. Failed single images are
  // covered in compressPdf.test.ts; the encoder lives in the worker now.
  let lateDownloads = 0
  const countDownload = () => {
    lateDownloads++
  }
  p.on('download', countDownload)
  await initial()
  await comp().check()
  await btn('Export vorbereiten').click()
  await p.getByRole('progressbar', { name: 'Exportfortschritt' }).waitFor()
  await btn('Abbrechen').click()
  await p.waitForFunction(() => !document.querySelector('.toolbar').inert)
  await p.waitForTimeout(800)
  assert.equal(lateDownloads, 0)
  p.off('download', countDownload)
  await initial()
  await p.keyboard.press('Escape')
  // Redaction + replacement: optimize only sanitized export pixels, never source.
  await btn('Schwärzen').click()
  const page = p.locator('.pages .page').first()
  await page.scrollIntoViewIfNeeded()
  const r = await page.boundingBox()
  await p.mouse.move(r.x + 30, r.y + 160)
  await p.mouse.down()
  await p.mouse.move(r.x + 390, r.y + 310, { steps: 4 })
  await p.mouse.up()
  assert.equal(await btn('Exportieren').isDisabled(), true)
  await btn('Schwärzung anwenden …').click()
  await btn('Jetzt wirklich schwärzen').click()
  await p.waitForFunction(() => !document.querySelector('.redaction-overlay'))
  await p
    .getByRole('textbox', { name: 'Public', exact: true })
    .waitFor({ timeout: 60000 })
  await btn('T Text').click()
  const rr = await p.locator('.pages .page').first().boundingBox()
  await p.mouse.click(rr.x + 45, rr.y + 400)
  await p.locator('.textbox textarea').fill('REPLACEMENT-VISIBLE')
  await p.locator('.textbox textarea').press('Escape')
  await initial()
  const redactedPlain = await save(
    'Ohne Optimierung exportieren',
    'redacted-plain.pdf',
  )
  await initial()
  await comp().check()
  await protect().check()
  await p.getByLabel('Export-Passwort', { exact: true }).fill('t12-safe')
  await p.getByLabel('Passwort wiederholen', { exact: true }).fill('t12-safe')
  await btn('Export vorbereiten').click()
  await p
    .getByRole('dialog', { name: 'Export vorbereitet' })
    .waitFor({ timeout: 60000 })
  assert.equal(await btn('Kleinere Datei speichern').count(), 1)
  await p.screenshot({ path: join(out, 'redacted-result.png') })
  const protectedRedacted = await save(
    'Kleinere Datei speichern',
    'redacted-encrypted.pdf',
  )
  const readback = await inspect(protectedRedacted, 't12-safe')
  assert.ok(readback[0].text.includes('REPLACEMENT-VISIBLE'))
  assert.ok(!readback[0].text.includes('SECRET'))
  assert.deepEqual(readback[0].fields, [])
  assert.ok(readback[1].text.includes('PUBLIC-VECTOR-PAGE'))
  assert.deepEqual(readback[1].fields, [['Public', 'Keep editable']])
  assert.ok(readback[0].pixel.slice(0, 3).every((v) => v <= 5))
  assert.ok(protectedRedacted.length < redactedPlain.length)
  const { PDFDocument: Fork } = await import('@cantoo/pdf-lib')
  const unlocked = await Fork.load(protectedRedacted, {
    password: 't12-safe',
    updateMetadata: false,
  })
  unlocked.context.trailerInfo.Encrypt = undefined
  const unlockedBytes = await unlocked.save({ updateFieldAppearances: false })
  writeFileSync(join(out, 'redacted-compressed.pdf'), unlockedBytes)
  const redactedOutput = await PDFDocument.load(unlockedBytes)
  const sizes = redactedOutput.context
    .enumerateIndirectObjects()
    .filter(
      ([, o]) =>
        o instanceof PDFRawStream &&
        o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
    )
    .map(([, o]) => [
      o.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber(),
      o.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber(),
    ])
  assert.ok(sizes.some((size) => Math.max(...size) === 1800))
  // No-saving documents are explicit, not silently made bigger.
  const vector = await PDFDocument.create()
  vector.addPage().drawText('VECTOR-ONLY')
  await open(await vector.save(), 'vector.pdf')
  await initial()
  await prepare()
  assert.match(await dialog().innerText(), /Keine Ersparnis/)
  await save('Datei speichern', 'vector.pdf')
  // Narrow and dark dialogs: no horizontal overflow, long form scrolls within dialog.
  for (const colorScheme of ['light', 'dark']) {
    await p.setViewportSize({ width: 390, height: 900 })
    await p.emulateMedia({ colorScheme })
    await initial()
    await comp().check()
    await protect().check()
    assert.ok(await dialog().evaluate((e) => e.scrollWidth <= e.clientWidth))
    await p.screenshot({
      path: join(out, `export-mobile-${colorScheme}.png`),
      fullPage: true,
    })
    await p.keyboard.press('Escape')
  }
  assert.deepEqual(input, before)
  assert.deepEqual(errors, [])
  writeFileSync(
    join(out, 'sizes.json'),
    JSON.stringify(
      {
        plain: plain.length,
        compressed: optimized.length,
        redactedPlain: redactedPlain.length,
        redactedCompressed: unlockedBytes.length,
        redactedEncrypted: protectedRedacted.length,
      },
      null,
      2,
    ),
  )
  console.log(
    `PASS: default-off single dialog; real image compression ${plain.length} -> ${optimized.length}; redacted ${redactedPlain.length} -> ${unlockedBytes.length}; text/vector/editable forms; AES-256 combination; replacement searchable/secret absent; original fallback; exact draft immutability/no saved password; no-saving case; modal reset/cancel; mobile light/dark; no page errors. Artifacts: ${out}`,
  )
} finally {
  await browser.close()
}
