import type { Command } from './commands'
import { assignEditorState, cloneOverlay, copyEditorState, isStroke, isTextbox, type Overlay, type EditorState } from './model'
import { assertPageBudget, assertSourceBudget } from './pdf/documentBudget'
import { renumberLabels } from './labelNumbers'

/** 20 mm: a crop must leave this much paper in both directions. */
export const MIN_CROP_SIZE = 20 * 72 / 25.4
export const XFA_UNSUPPORTED = 'XFA-Formulare werden bei Seitenoperationen noch nicht unterstützt.'

export const A4_WIDTH = 210 * 72 / 25.4
export const A4_HEIGHT = 297 * 72 / 25.4

/** Source coordinates are the original PDF's user space. Rotation is clockwise. */
export interface DocumentPage {
  id: string
  name: string
  sourceId: string
  sourceIndex: number
  box: { x: number; y: number; width: number; height: number }
  unit: number
  rotation: number
  cropped?: boolean
  /** Pre-crop source box keeps the management preview at a stable physical scale. */
  previewBox?: DocumentPage['box']
  /** Rebuilt solely from masked pixels; the original source remains only in local drafts/history. */
  redacted?: boolean
  /** Source contains native AcroForm fields; preserved on page operations/export. */
  hasForms?: boolean
  /** XFA is not supported by pdf-lib; refuse page edits rather than lose it. */
  hasXfa?: boolean
  /** Set by text corrections: the source this page is a revision of, for its outlines and tags. */
  revisionOf?: string
  /** Recognized words, written as invisible text whenever the page is composed. */
  ocr?: OcrSourceWord[]
}
/** One recognized word in source coordinates: baseline start, direction and height. */
export interface OcrSourceWord { text: string; x: number; y: number; dx: number; dy: number; height: number }
export interface PageSource {
  id: string
  bytes: ArrayBuffer
}
export function pageSize(page: DocumentPage) {
  const { width, height } = page.box
  return page.rotation % 180
    ? { width: height * page.unit, height: width * page.unit }
    : { width: width * page.unit, height: height * page.unit }
}
/** Cropping removes paper; it must not enlarge the remaining paper in the preview. */
export function pagePreviewSize(page: DocumentPage) {
  return pageSize(page.previewBox ? { ...page, box: page.previewBox } : page)
}
/** Match the preceding visible sheet, or the first sheet when inserting at the start. */
export function insertionPageSize(pages: DocumentPage[], index: number) {
  const reference = pages[Math.max(0, index - 1)]
  return reference ? pageSize(reference) : { width: 595.28, height: 841.89 }
}
function withPages(state: EditorState) {
  const copy = copyEditorState(state)
  return { ...copy, pages: copy.pages ?? [], pageSources: copy.pageSources ?? [] }
}
function pageCommand(
  state: EditorState,
  label: string,
  mutate: (next: EditorState & { pages: DocumentPage[] }) => void,
): Command {
  if(state.redactions?.length)throw new Error('Vorgemerkte Schwärzungen zuerst anwenden oder verwerfen.')
  if (state.pages?.some(p => p.hasXfa))
    throw new Error(XFA_UNSUPPORTED)
  const before = withPages(state),
    after = withPages(state)
  mutate(after)
  renumberLabels(after.overlays, after.pages)
  return { label, apply: (s) => assignEditorState(s, after), revert: (s) => assignEditorState(s, before) }
}
export function movePage(state: EditorState, id: string, index: number): Command {
  const from = state.pages?.findIndex((p) => p.id === id) ?? -1
  if (from < 0 || !Number.isInteger(index) || index < 0 || index >= state.pages!.length)
    throw new Error('Ungültige Seitenposition.')
  return pageCommand(state, 'Move page', (next) => {
    const [page] = next.pages.splice(from, 1)
    next.pages.splice(index, 0, page)
  })
}
function selectedPageIds(state: EditorState, ids: readonly string[]) {
  const selected = new Set(ids), available = new Set(state.pages?.map(page => page.id))
  if (!selected.size || [...selected].some(id => !available.has(id)))
    throw new Error('Bitte gültige Seiten auswählen.')
  return selected
}
export function deletePages(state: EditorState, ids: readonly string[]): Command {
  const selected = selectedPageIds(state, ids)
  return pageCommand(state, 'Delete pages', next => {
    next.pages = next.pages.filter(page => !selected.has(page.id))
    next.overlays = next.overlays.filter(overlay => !selected.has(overlay.pageId))
  })
}
export function deletePage(state: EditorState, id: string): Command {
  return deletePages(state, [id])
}
/** One undo step for all pages of a recognition run. */
export function setPageOcr(state: EditorState, words: ReadonlyMap<string, OcrSourceWord[]>): Command {
  return pageCommand(state, 'Add recognized text', next => {
    next.pages.forEach(page => {
      const recognized = words.get(page.id)
      if (recognized) page.ocr = structuredClone(recognized)
    })
  })
}
export function insertPages(
  state: EditorState,
  index: number,
  pages: DocumentPage[],
  source: PageSource,
  overlays: Overlay[] = [],
  /** The document's own file, which the state does not hold. */
  originalBytes = 0,
): Command {
  if (!Number.isInteger(index) || index < 0 || index > (state.pages?.length ?? 0) || pages.length === 0)
    throw new Error('Ungültige Einfügeposition.')
  if (
    pages.some((p) => state.pages?.some((old) => old.id === p.id)) ||
    new Set(pages.map((p) => p.id)).size !== pages.length
  )
    throw new Error('Doppelte Seitenkennung.')
  if (pages.some(p => p.hasXfa)) throw new Error(XFA_UNSUPPORTED)
  assertPageBudget((state.pages?.length ?? 0) + pages.length)
  if (!state.pageSources?.some(existing => existing.id === source.id))
    assertSourceBudget((state.pageSources ?? []).reduce((total, existing) => total + existing.bytes.byteLength, originalBytes), source.bytes.byteLength)
  if (overlays.some((o) => !pages.some((p) => p.id === o.pageId)))
    throw new Error('Ungültige Overlay-Seite.')
  return pageCommand(state, 'Insert pages', (next) => {
    next.pages.splice(index, 0, ...structuredClone(pages))
    next.overlays.push(...overlays.map(cloneOverlay))
    if (!next.pageSources?.some((s) => s.id === source.id)) next.pageSources!.push(source)
  })
}
function transformOverlay(
  overlay: Overlay,
  point: (x: number, y: number) => { x: number; y: number },
  rotation = 0,
) {
  if (isStroke(overlay)) {
    overlay.points = overlay.points.map((p) => point(p.x, p.y))
    if (overlay.clips) overlay.clips = overlay.clips.map(polygon => polygon.map(p => point(p.x, p.y)))
    return
  }
  if (isTextbox(overlay)) {
    Object.assign(overlay, point(overlay.x, overlay.y))
    if (rotation) overlay.rotation = ((overlay.rotation ?? 0) + rotation + 360) % 360
    return
  }
  const center = point(overlay.x + overlay.width / 2, overlay.y + overlay.height / 2)
  overlay.x = center.x - overlay.width / 2
  overlay.y = center.y - overlay.height / 2
  if (rotation) overlay.rotation = ((overlay.rotation ?? 0) + rotation + 360) % 360
}
export function rotatePages(state: EditorState, ids: readonly string[], clockwise: boolean): Command {
  const selected = selectedPageIds(state, ids), delta = clockwise ? 90 : -90
  const sizes = new Map(state.pages!.map(page => [page.id, pageSize(page)]))
  return pageCommand(state, 'Rotate pages', next => {
    next.pages.forEach(page => {
      if (selected.has(page.id)) page.rotation = (page.rotation + delta + 360) % 360
    })
    next.overlays.forEach(overlay => {
      if (!selected.has(overlay.pageId)) return
      const size = sizes.get(overlay.pageId)!
      transformOverlay(overlay,
        clockwise ? (x, y) => ({ x: y, y: size.width - x }) : (x, y) => ({ x: size.height - y, y: x }),
        delta,
      )
    })
  })
}
export function rotatePage(state: EditorState, id: string, clockwise: boolean): Command {
  return rotatePages(state, [id], clockwise)
}
export interface CropMargins {
  left: number
  top: number
  right: number
  bottom: number
}
export function sourcePoint(page: DocumentPage, x: number, y: number) {
  const b = page.box,
    u = page.unit
  if (page.rotation === 90) return { x: b.x + b.width - y / u, y: b.y + x / u }
  if (page.rotation === 180) return { x: b.x + b.width - x / u, y: b.y + b.height - y / u }
  if (page.rotation === 270) return { x: b.x + y / u, y: b.y + b.height - x / u }
  return { x: b.x + x / u, y: b.y + y / u }
}
export function cropPage(state: EditorState, id: string, m: CropMargins): Command {
  const index = state.pages?.findIndex((p) => p.id === id) ?? -1
  if (index < 0) throw new Error('Seite nicht gefunden.')
  const page = state.pages![index],
    size = pageSize(page)
  if (
    Object.values(m).some((v) => !Number.isFinite(v) || v < 0) ||
    size.width - m.left - m.right < MIN_CROP_SIZE - 1e-6 ||
    size.height - m.top - m.bottom < MIN_CROP_SIZE - 1e-6
  )
    throw new Error('Der Zuschnitt muss mindestens 20 × 20 mm groß bleiben.')
  const a = sourcePoint(page, m.left, m.bottom),
    b = sourcePoint(page, size.width - m.right, size.height - m.top)
  return pageCommand(state, 'Crop page', (next) => {
    next.pages[index].previewBox ??= { ...page.box }
    next.pages[index].cropped = true
    next.pages[index].box = {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    }
    next.overlays
      .filter((o) => o.pageId === id)
      .forEach((o) => transformOverlay(o, (x, y) => ({ x: x - m.left, y: y - m.bottom })))
  })
}

/** One reversible publication of a prepared PDF source and all mapped overlays. */
export function replacePageDocument(state: EditorState, pages: DocumentPage[], source: PageSource, overlays: Overlay[]): Command {
  return pageCommand(state, 'Set all pages to A4', next => {
    next.pages = structuredClone(pages)
    next.formValues = undefined // The replacement source already contains native values.
    next.pageSources = [source]
    next.overlays = overlays.map(cloneOverlay)
  })
}
export function a4Size(size: { width: number; height: number }) {
  return size.width > size.height ? { width: A4_HEIGHT, height: A4_WIDTH } : { width: A4_WIDTH, height: A4_HEIGHT }
}
/** One scale for the entire page set, not a separate fit-to-height per selection. */
export function commonPreviewScale(sizes: { width: number; height: number }[], available: { width: number; height: number }) {
  return Math.min(1, Math.max(1, available.width - 48) / Math.max(1, ...sizes.map(s => s.width)),
    Math.max(1, available.height - 60) / Math.max(1, ...sizes.map(s => s.height)))
}
