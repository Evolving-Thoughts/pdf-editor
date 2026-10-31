import { expect, test } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { assertFileBudget, assertPageBudget, assertSourceBudget, MAX_PAGE_COUNT, MAX_PDF_BYTES, MAX_TOTAL_SOURCE_BYTES } from '../../src/core/pdf/documentBudget'
import { insertPages } from '../../src/core/pages'
import type { DocumentPage } from '../../src/core/pages'

const page = (id: string): DocumentPage => ({ id, name: id, sourceId: 'original', sourceIndex: 0, box: { x: 0, y: 0, width: 100, height: 100 }, unit: 1, rotation: 0 })

test('rejects a file above the limit before reading it, and allows one at the limit', () => {
  expect(() => assertFileBudget(MAX_PDF_BYTES)).not.toThrow()
  expect(() => assertFileBudget(MAX_PDF_BYTES + 1)).toThrow(/zu groß/)
})

test('rejects too many pages with the real numbers in the message', () => {
  expect(() => assertPageBudget(MAX_PAGE_COUNT)).not.toThrow()
  expect(() => assertPageBudget(MAX_PAGE_COUNT + 1)).toThrow(String(MAX_PAGE_COUNT).replace(/\B(?=(\d{3})+$)/g, '.'))
})

test('counts every source that the document holds', () => {
  expect(() => assertSourceBudget(MAX_TOTAL_SOURCE_BYTES - 10, 10)).not.toThrow()
  expect(() => assertSourceBudget(MAX_TOTAL_SOURCE_BYTES - 10, 11)).toThrow(/Gesamtgröße/)
})

test('the original counts toward the budget for all sources', () => {
  const state = { overlays: [], pages: [page('a')], pageSources: [] }, added = { id: 's', bytes: new ArrayBuffer(4) }
  expect(() => insertPages(state, 0, [page('neu')], added, [], MAX_TOTAL_SOURCE_BYTES - 4)).not.toThrow()
  expect(() => insertPages(state, 0, [page('neu')], added, [], MAX_TOTAL_SOURCE_BYTES - 3)).toThrow(/Gesamtgröße/)
})

test('inserting pages cannot grow a document past the page budget', async () => {
  const pages = Array.from({ length: MAX_PAGE_COUNT }, (_, index) => page(`p${index}`))
  const state = { overlays: [], pages, pageSources: [] }
  const doc = await PDFDocument.create()
  doc.addPage()
  expect(() => insertPages(state, 0, [page('neu')], { id: 's', bytes: new ArrayBuffer(4) })).toThrow(/Seiten/)
})
