import { expect, test, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { runExport, type ExportRequest } from '../../src/core/pdf/exportPipeline'
import { inspectPages } from '../../src/core/pdf/pageOperations'

const titled = async () => {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage([200, 300])
  doc.addPage([300, 200])
  doc.setTitle('Bericht')
  return doc.save()
}
const request = (original: Uint8Array, pages: ExportRequest['pages'], extra: Partial<ExportRequest> = {}): ExportRequest =>
  ({ original, sources: [], pages, overlays: [], secure: false, size: { mode: 'none' }, ...extra })
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
