import { expect, test, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { extractPages, runExport, type ExportRequest } from '../../src/core/pdf/exportPipeline'
import { inspectPages } from '../../src/core/pdf/pageOperations'
import type { EditorState } from '../../src/core/model'
import { isSecure } from '../../src/core/pdf/documentOutput'

const titled = async () => {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage([200, 300])
  doc.addPage([300, 200])
  doc.setTitle('Bericht')
  return doc.save()
}
const request = (original: Uint8Array, pages: EditorState['pages'], extra: Partial<EditorState> = {}): ExportRequest =>
  ({ original, state: { pages, overlays: [], ...extra }, size: { mode: 'none' } })
const encodeImage = () => { throw new Error('not used') }
const title = async (bytes: Uint8Array) => (await PDFDocument.load(bytes, { updateMetadata: false })).getTitle()

test('an export with a kept page tree reads the original only once for that check', async () => {
  const original = await titled(), pages = await inspectPages(original, 'original')
  const load = vi.spyOn(PDFDocument, 'load')
  try {
    const result = await runExport(request(original, pages), encodeImage)
    expect(load.mock.calls.filter(([bytes, options]) => bytes === original && !options)).toHaveLength(1)
    expect(await title(result.original)).toBe('Bericht')
  } finally { load.mockRestore() }
})

test('the single check still decides both ways: a metadata edit and a rebuilt order', async () => {
  const original = await titled(), pages = await inspectPages(original, 'original')
  const edited = await runExport(request(original, pages, { metadata: { fields: { title: 'Neu' } } }), encodeImage)
  expect(await title(edited.original)).toBe('Neu')
  const rebuilt = await runExport(request(original, [...pages].reverse()), encodeImage)
  expect(await title(rebuilt.original)).toBe('Bericht')
})

test('pages saved on their own follow the decision about document info', async () => {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage([200, 300])
  doc.addPage([200, 300])
  doc.setAuthor('Mira Muster')
  const original = await doc.save(), pages = await inspectPages(original, 'original'), ids = pages.map(page => page.id)
  const author = async (bytes: Uint8Array) => (await PDFDocument.load(bytes, { updateMetadata: false })).getAuthor()
  const metadata = { fields: { author: null } }
  expect(await author(await extractPages(request(original, pages, { metadata }), ids))).toBeUndefined()
  expect(await author(await extractPages(request(original, pages), ids))).toBe('Mira Muster')
  expect(await author(await extractPages(request(original, pages), [ids[0]]))).toBeUndefined()
})

test('a redacted document stays secure after its rasterized pages are deleted', () => {
  expect(isSecure({ overlays: [] })).toBe(false)
  expect(isSecure({ overlays: [], pages: [{ redacted: true }] as EditorState['pages'] })).toBe(true)
  expect(isSecure({ overlays: [], pages: [], redactionApplied: true })).toBe(true)
})
