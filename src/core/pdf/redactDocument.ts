import { cloneOverlay, createId, type Textbox, type EditorState } from '../model'
import { validateRedactions } from '../redactions'
import { composePages, exportPageDocument } from './pageOperations'
import { loadPdf } from './loadPdf'
import { writeRasterSource, type RasterPage } from './rasterSource'
import { isSecure } from './documentOutput'
/** Prepares a complete result without touching the live store; caller publishes only if still current. */
export async function prepareRedaction(original: Uint8Array, state: EditorState) {
  const pages = structuredClone(state.pages ?? []), marks = structuredClone(state.redactions ?? [])
  const overlays = state.overlays.map(cloneOverlay), sources = [...(state.pageSources ?? [])], values = state.formValues ? structuredClone(state.formValues) : undefined
  validateRedactions(marks, pages)
  // Rasterize exactly what is visible, including native values and prior overlays. They must not survive as recoverable objects on these pages.
  const bytes = await exportPageDocument(original, sources, pages, overlays, undefined, values, isSecure(state))
  const pdf = await loadPdf('Schwärzung', bytes), rows: RasterPage[] = [], newText: Textbox[] = []
  try {
    for (const [index, page] of pages.entries()) {
      const onPage = marks.filter(mark => mark.pageId === page.id)
      if (!onPage.length) continue
      const raster = await pdf.rasterizePage(index + 1, onPage); rows.push({ page, png: raster.png })
      for (const suggestion of raster.replacements) newText.push({ id: createId(), pageIndex: index, x: suggestion.x, y: suggestion.y, text: '', font: suggestion.font, fontSize: suggestion.fontSize, rotation: suggestion.rotation, bold: false, italic: false, underline: false })
    }
    const result = await writeRasterSource(rows)
    const replacements = new Map(result.replacements.map(page => [page.id, page]))
    // Validate the complete secure export before publishing any live change.
    await composePages(original, [...sources, result.source], pages.map(page => replacements.get(page.id) ?? page), values, true)
    return { ...result, newText }
  } finally { await pdf.destroy() }
}
