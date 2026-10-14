import type { Command } from './commands'
import { cloneOverlay, isStroke, isTextbox, type Overlay, type EditorState } from './model'

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
  /** Source contains native AcroForm fields; preserved on page operations/export. */
  hasForms?: boolean
  /** XFA is not supported by pdf-lib; refuse page edits rather than lose it. */
  hasXfa?: boolean
}
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
/** Match the preceding visible sheet, or the first sheet when inserting at the start. */
export function insertionPageSize(pages: DocumentPage[], index: number) {
  const reference = pages[Math.max(0, index - 1)]
  return reference ? pageSize(reference) : { width: 595.28, height: 841.89 }
}
function snapshot(state: EditorState) {
  return {
    pages: structuredClone(state.pages ?? []),
    overlays: state.overlays.map(cloneOverlay),
    pageSources: [...(state.pageSources ?? [])],
  }
}
function pageCommand(
  state: EditorState,
  label: string,
  mutate: (next: EditorState & { pages: DocumentPage[] }) => void,
): Command {
  if (state.pages?.some(p => p.hasXfa))
    throw new Error('XFA-Formulare werden bei Seitenoperationen noch nicht unterstützt.')
  const before = snapshot(state),
    after = snapshot(state)
  mutate(after)
  const assign = (target: EditorState, value: typeof before) => {
    target.pages = structuredClone(value.pages)
    target.overlays = value.overlays.map(cloneOverlay)
    target.pageSources = [...value.pageSources]
  }
  return { label, apply: (s) => assign(s, after), revert: (s) => assign(s, before) }
}
export function movePage(state: EditorState, id: string, index: number): Command {
  const from = state.pages?.findIndex((p) => p.id === id) ?? -1
  if (from < 0 || !Number.isInteger(index) || index < 0 || index >= state.pages!.length)
    throw new Error('Ungültige Seitenposition.')
  return pageCommand(state, 'Move page', (next) => {
    const old = [...next.pages]
    const [page] = next.pages.splice(from, 1)
    next.pages.splice(index, 0, page)
    for (const overlay of next.overlays)
      overlay.pageIndex = next.pages.findIndex((p) => p.id === old[overlay.pageIndex]?.id)
  })
}
export function deletePage(state: EditorState, id: string): Command {
  const index = state.pages?.findIndex((p) => p.id === id) ?? -1
  if (index < 0) throw new Error('Seite nicht gefunden.')
  return pageCommand(state, 'Delete page', (next) => {
    next.pages.splice(index, 1)
    next.overlays = next.overlays.filter((o) => o.pageIndex !== index)
    next.overlays.forEach((o) => {
      if (o.pageIndex > index) o.pageIndex--
    })
  })
}
export function insertPages(
  state: EditorState,
  index: number,
  pages: DocumentPage[],
  source: PageSource,
  overlays: Overlay[] = [],
): Command {
  if (!Number.isInteger(index) || index < 0 || index > (state.pages?.length ?? 0) || pages.length === 0)
    throw new Error('Ungültige Einfügeposition.')
  if (
    pages.some((p) => state.pages?.some((old) => old.id === p.id)) ||
    new Set(pages.map((p) => p.id)).size !== pages.length
  )
    throw new Error('Doppelte Seitenkennung.')
  if (pages.some(p => p.hasXfa)) throw new Error('XFA-Formulare werden bei Seitenoperationen noch nicht unterstützt.')
  if (overlays.some((o) => !Number.isInteger(o.pageIndex) || o.pageIndex < 0 || o.pageIndex >= pages.length))
    throw new Error('Ungültige Overlay-Seite.')
  return pageCommand(state, 'Insert pages', (next) => {
    next.pages.splice(index, 0, ...structuredClone(pages))
    next.overlays.forEach((o) => {
      if (o.pageIndex >= index) o.pageIndex += pages.length
    })
    next.overlays.push(...overlays.map((o) => ({ ...cloneOverlay(o), pageIndex: o.pageIndex + index })))
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
export function rotatePage(state: EditorState, id: string, clockwise: boolean): Command {
  const index = state.pages?.findIndex((p) => p.id === id) ?? -1
  if (index < 0) throw new Error('Seite nicht gefunden.')
  const size = pageSize(state.pages![index]),
    delta = clockwise ? 90 : -90
  return pageCommand(state, 'Rotate page', (next) => {
    const page = next.pages[index]
    page.rotation = (page.rotation + delta + 360) % 360
    next.overlays
      .filter((o) => o.pageIndex === index)
      .forEach((o) =>
        transformOverlay(
          o,
          clockwise ? (x, y) => ({ x: y, y: size.width - x }) : (x, y) => ({ x: size.height - y, y: x }),
          delta,
        ),
      )
  })
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
    size.width - m.left - m.right < (20 * 72) / 25.4 - 1e-6 ||
    size.height - m.top - m.bottom < (20 * 72) / 25.4 - 1e-6
  )
    throw new Error('Der Zuschnitt muss mindestens 20 × 20 mm groß bleiben.')
  const a = sourcePoint(page, m.left, m.bottom),
    b = sourcePoint(page, size.width - m.right, size.height - m.top)
  return pageCommand(state, 'Crop page', (next) => {
    next.pages[index].cropped = true
    next.pages[index].box = {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    }
    next.overlays
      .filter((o) => o.pageIndex === index)
      .forEach((o) => transformOverlay(o, (x, y) => ({ x: x - m.left, y: y - m.bottom })))
  })
}

/** One reversible publication of a prepared PDF source and all mapped overlays. */
export function replacePageDocument(state: EditorState, pages: DocumentPage[], source: PageSource, overlays: Overlay[]): Command {
  return pageCommand(state, 'Set all pages to A4', next => {
    next.pages = structuredClone(pages)
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
