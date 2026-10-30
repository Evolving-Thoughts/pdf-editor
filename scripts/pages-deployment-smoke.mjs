// Synthetic production check: serve only dist under the GitHub project subpath.
// No Vite dev server, source-module imports, external files, or user PDFs.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat, mkdir } from 'node:fs/promises'
import { resolve, extname, sep, join } from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument, PDFName, PDFNumber, StandardFonts } from 'pdf-lib'
import { PDFDocument as SecureDocument, PDFName as SecureName } from '@cantoo/pdf-lib'
import { chromiumPath } from './browser-helper.mjs'
import { confirmDefaultExport, openProtectedExport } from './export-smoke-helper.mjs'

const prefix = '/pdf-editor/'
const dist = resolve('dist')
const html = await readFile(join(dist, 'index.html'), 'utf8')
assert.ok(html.includes(`${prefix}assets/`), 'Build with npm run build:pages first')
const out = process.env.SMOKE_ARTIFACT_DIR
if (out) await mkdir(out, { recursive: true })
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' }
const server = createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return }
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (!path.startsWith(prefix)) { res.writeHead(404).end(); return }
    const file = resolve(dist, path.slice(prefix.length) || 'index.html')
    if (!file.startsWith(dist + sep) || !(await stat(file)).isFile()) { res.writeHead(404).end(); return }
    const body = req.method === 'HEAD' ? undefined : await readFile(file)
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch { res.writeHead(404).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
try {
  assert.equal((await fetch(`${origin}/assets/not-found.js`)).status, 404)
  assert.equal((await fetch(`${origin}${prefix}src/main.tsx`)).status, 404)
  const favicon = await fetch(`${origin}${prefix}favicon.svg`)
  assert.equal(favicon.status, 200)
  assert.equal(favicon.headers.get('content-type'), 'image/svg+xml')
  browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
  page.setDefaultTimeout(15000)
  const errors = [], failed = [], requests = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`) })
  page.on('request', request => requests.push(request.url()))
  page.on('requestfailed', request => failed.push(`${request.failure()?.errorText} ${request.url()}`))
  const button = name => page.getByRole('button', { name, exact: true })
  const fileInput = () => page.locator('input[accept="application/pdf"]')
  const upload = (bytes, name) => fileInput().setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) })
  const ready = () => page.waitForFunction(() => document.querySelector('.pages .page canvas')?.width > 0 && !document.querySelector('header')?.inert)
  async function search(text) {
    await page.keyboard.press('Control+f')
    await page.getByRole('textbox', { name: 'Suchtext', exact: true }).fill(text)
    await page.waitForFunction(() => document.querySelector('.search-controls [role=status]')?.textContent === '1 / 1')
    await page.keyboard.press('Escape')
  }
  async function download(confirm) {
    const pending = page.waitForEvent('download')
    await confirm()
    const result = await pending
    const chunks = []
    for await (const chunk of await result.createReadStream()) chunks.push(chunk)
    return Buffer.concat(chunks)
  }
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  const sheet = doc.addPage([600, 800])
  sheet.drawText('Pages fixture', { x: 50, y: 700, size: 20, font })
  const field = doc.getForm().createTextField('Name')
  field.setText('Ada')
  field.addToPage(sheet, { x: 50, y: 600, width: 200, height: 30 })
  const bytes = await doc.save()
  for (const font of ['noto-sans', 'noto-serif', 'carlito', 'lato', 'eb-garamond', 'roboto-mono', 'caveat']) {
    const response = await page.request.get(`${origin}${prefix}licenses/fonts/${font}.txt`)
    assert.equal(response.status(), 200, `${font} license is distributed`)
    assert.match(await response.text(), /SIL OPEN FONT LICENSE Version 1.1/)
  }
  await page.goto(origin + prefix)
  assert.equal(await page.locator('link[rel=icon]').getAttribute('href'), `${prefix}favicon.svg`)
  await upload(bytes, 'pages.pdf')
  await ready()
  await search('Pages fixture')
  await page.locator('.native-form-layer input[type=text]').fill('Grace')
  await button('T Text').click()
  await page.locator('.pages .page').first().click({ position: { x: 100, y: 350 } })
  await page.keyboard.type('Pages Overlay')
  await page.keyboard.press('Escape')
  await page.getByRole('combobox', { name: 'Schriftart', exact: true }).selectOption('eb-garamond')
  assert.equal(await page.locator('.textbox textarea').evaluate(el => el === document.activeElement), true, 'Font selection returns typing focus in the production build')
  await page.keyboard.type(' Font')
  await page.evaluate(() => document.fonts.ready)
  await button('Exportieren').click()
  assert.equal(await page.getByRole('radio', { name: /Bilddaten komprimieren/ }).isChecked(), false)
  assert.equal(await page.getByRole('checkbox', { name: /Mit Passwort schützen/ }).isChecked(), false)
  const plain = await download(() => confirmDefaultExport(page))
  assert.equal((await PDFDocument.load(plain)).getForm().getTextField('Name').getText(), 'Grace')
  await upload(plain, 'roundtrip.pdf')
  await ready()
  await search('Pages Overlay Font')
  await search('Pages fixture')

  // A fresh navigation forces lazy encryption code to load from the built subpath.
  const secure = await SecureDocument.load(bytes)
  secure.encrypt({ userPassword: 'pages-input-demo', ownerPassword: 'pages-input-demo', algorithm: 'AES-256' })
  await page.waitForLoadState('networkidle')
  await page.reload()
  await upload(await secure.save(), 'protected.pdf')
  const passwordDialog = page.locator('.password-dialog')
  await passwordDialog.waitFor()
  await page.getByLabel('PDF-Passwort', { exact: true }).fill('wrong-demo')
  await passwordDialog.getByRole('button', { name: 'PDF öffnen', exact: true }).click()
  await page.getByText('Das Passwort ist falsch. Erneut versuchen oder abbrechen.', { exact: true }).waitFor()
  await page.getByLabel('PDF-Passwort', { exact: true }).fill('pages-input-demo')
  await passwordDialog.getByRole('button', { name: 'PDF öffnen', exact: true }).click()
  await passwordDialog.waitFor({ state: 'hidden' })
  await ready()
  await search('Pages fixture')
  await page.locator('.native-form-layer input[type=text]').fill('Protected Grace')
  await openProtectedExport(page)
  await page.getByLabel('Export-Passwort', { exact: true }).fill('pages-output-demo')
  await page.getByLabel('Passwort wiederholen', { exact: true }).fill('pages-output-demo')
  const encrypted = await download(() => button('Geschützt exportieren').click())
  const decrypted = await SecureDocument.load(encrypted, { password: 'pages-output-demo' })
  // Probe the on-disk trailer before decrypting; the fork removes it on load with a password.
  const probe = await SecureDocument.load(encrypted, { ignoreEncryption: true, updateMetadata: false })
  assert.equal(probe.isEncrypted, true)
  const encryption = probe.context.lookup(probe.context.trailerInfo.Encrypt)
  assert.equal(encryption.get(SecureName.of('V')).asNumber(), 5)
  assert.equal(encryption.get(SecureName.of('R')).asNumber(), 6)
  assert.equal(decrypted.getForm().getTextField('Name').getText(), 'Protected Grace')
  // Tiny hostile UserUnit geometry must fail visibly before a giant canvas is
  // allocated; a subsequent ordinary document must still render successfully.
  const oversized = await PDFDocument.create()
  const hugePage = oversized.addPage([14400, 14400])
  hugePage.node.set(PDFName.of('UserUnit'), PDFNumber.of(75))
  await upload(await oversized.save(), 'oversized-user-unit.pdf')
  await page.getByRole('alert').filter({ hasText: 'Seitenabmessungen' }).waitFor()
  assert.ok(await page.locator('.pages .page canvas').evaluateAll(canvases =>
    canvases.every(canvas => canvas.width <= 8192 && canvas.height <= 8192 && canvas.width * canvas.height <= 16_000_000),
  ), 'Oversized PDF never receives an oversized canvas')
  await upload(bytes, 'recovery.pdf')
  await ready()
  await search('Pages fixture')
  await page.waitForLoadState('networkidle')
  assert.ok(requests.some(url => url.includes(`${prefix}assets/pdf.worker`)), 'Production PDF.js worker loaded')
  const js = new Set(requests.filter(url => new URL(url).pathname.endsWith('.js')))
  assert.ok(requests.some(url => url.includes('eb-garamond') && url.endsWith('.woff')), 'Bundled EB Garamond font loaded below project prefix')
  assert.ok(requests.some(url => url.includes('fontkit')), 'Lazy PDF font embedding chunk loaded')
  assert.ok(js.size >= 2, 'Main and lazy encryption chunks loaded')
  assert.ok(requests.filter(url => /^https?:/.test(url)).every(url => new URL(url).origin === origin && new URL(url).pathname.startsWith(prefix)), 'All network resources remain local and below the project prefix')
  assert.deepEqual(failed, [], 'No missing production assets')
  assert.deepEqual(errors, [], 'No browser runtime errors')
  if (out) await page.screenshot({ path: join(out, 'pages-production.png') })
  console.log('PASS Pages production subpath: static HTML/CSS/favicon, PDF.js worker, native fields, searchable text-overlay export roundtrip, cold password open/retry, lazy crypto chunk, AES-256 export, oversized UserUnit rejection and recovery; no external or missing assets/runtime errors.')
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
