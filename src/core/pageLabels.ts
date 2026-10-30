// Repeating text on chosen pages (T22). Labels are ordinary textboxes, so they stay
// editable, undoable and real PDF text. Geometry is in displayed page points.
import { labelText } from './labelNumbers'
import { createId, isImage, isShape, isTextbox, type Overlay, type OverlayFont, type Textbox } from './model'
import { TEXT_LINE_HEIGHT } from './textLayout'
import type { DocumentPage } from './pages'
import { pageSize } from './pages'
import type { SearchFragment } from './search'

export const LABEL_POSITIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const
export type LabelPosition = (typeof LABEL_POSITIONS)[number]

export interface LabelConfig {
  /** {n} is the running number, {gesamt} the last number. */
  template: string
  /** Empty means all pages, otherwise like "2-5, 9". */
  range: string
  start: number
  position: LabelPosition
  margin: number
  font: Extract<OverlayFont, 'helvetica' | 'times' | 'courier'>
  fontSize: number
}

export interface Box { left: number; right: number; bottom: number; top: number }
export type MeasureText = (text: string, font: LabelConfig['font'], fontSize: number) => number
export interface PlannedLabel { pageIndex: number; number: number; text: string; x: number; y: number; width: number }

/** Sorted, unique 0-based pages. Rejects anything it cannot read instead of guessing. */
export function parsePageRange(text: string, total: number): number[] {
  if (!text.trim()) return Array.from({ length: total }, (_, index) => index)
  const pages = new Set<number>()
  for (const part of text.split(/[,;]/)) {
    const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?$/.exec(part)
    if (!match) throw new Error(`Der Seitenbereich „${part.trim()}“ ist nicht lesbar. Beispiel: 2-5, 9`)
    const from = Number(match[1]), to = Number(match[2] ?? match[1])
    if (from < 1 || to > total || from > to) throw new Error(`Der Seitenbereich „${part.trim()}“ liegt außerhalb von 1 bis ${total}.`)
    for (let page = from; page <= to; page++) pages.add(page - 1)
  }
  return [...pages].sort((a, b) => a - b)
}

export { labelText }

export function labelPosition(size: { width: number; height: number }, width: number, config: Pick<LabelConfig, 'position' | 'margin' | 'fontSize'>) {
  const [vertical, horizontal] = config.position.split('-')
  const x = horizontal === 'left' ? config.margin : horizontal === 'right' ? size.width - config.margin - width : (size.width - width) / 2
  // The box's y is its baseline, so a top label sits one ascent below the margin.
  const y = vertical === 'top' ? size.height - config.margin - config.fontSize * 0.8 : config.margin
  return { x, y }
}

export function planLabels(pages: DocumentPage[], config: LabelConfig, measure: MeasureText): PlannedLabel[] {
  if (!config.template.trim()) throw new Error('Bitte einen Text eingeben.')
  if (!Number.isInteger(config.start) || config.start < 0) throw new Error('Die erste Nummer muss eine ganze Zahl ab 0 sein.')
  if (!(config.fontSize >= 4 && config.fontSize <= 72)) throw new Error('Die Schriftgröße muss zwischen 4 und 72 pt liegen.')
  if (!(config.margin >= 0)) throw new Error('Der Abstand zum Rand darf nicht negativ sein.')
  const chosen = parsePageRange(config.range, pages.length), last = config.start + chosen.length - 1
  return chosen.map((pageIndex, offset) => {
    const number = config.start + offset, text = labelText(config.template, number, last)
    const width = measure(text, config.font, config.fontSize), size = pageSize(pages[pageIndex])
    const { x, y } = labelPosition(size, width, config)
    if (x < 0 || x + width > size.width || y < 0 || y + config.fontSize > size.height)
      throw new Error(`Der Text passt auf Seite ${pageIndex + 1} nicht zwischen die Ränder.`)
    return { pageIndex, number, text, x, y, width }
  })
}

export function labelOverlays(labels: PlannedLabel[], config: LabelConfig): Textbox[] {
  return labels.map(label => ({
    id: createId(), pageIndex: label.pageIndex, x: label.x, y: label.y, text: label.text, font: config.font,
    fontSize: config.fontSize, bold: false, italic: false, underline: false, labelGroup: config.position,
    label: { template: config.template, start: config.start, text: label.text },
  }))
}

export function labelBox(label: PlannedLabel, fontSize: number): Box {
  return { left: label.x, right: label.x + label.width, bottom: label.y - fontSize * 0.25, top: label.y + fontSize * TEXT_LINE_HEIGHT * 0.8 }
}

const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top

function overlayBox(overlay: Overlay): Box | null {
  if (isTextbox(overlay)) {
    if (!overlay.text.trim()) return null
    const lines = overlay.text.split('\n'), longest = Math.max(...lines.map(line => line.length))
    return { left: overlay.x, right: overlay.x + longest * overlay.fontSize * 0.55, bottom: overlay.y - (lines.length - 1) * overlay.fontSize * TEXT_LINE_HEIGHT - overlay.fontSize * 0.25, top: overlay.y + overlay.fontSize }
  }
  if (isImage(overlay) || isShape(overlay)) return { left: overlay.x, right: overlay.x + overlay.width, bottom: overlay.y, top: overlay.y + overlay.height }
  return null
}

/** Pages (0-based) where a label would cover page text or an overlay. Images and
 * drawings inside the PDF itself are not detectable this way; the preview shows them. */
export function labelCollisions(labels: PlannedLabel[], fontSize: number, pages: DocumentPage[], overlays: Overlay[], pageText: Map<number, SearchFragment[]>): number[] {
  return labels.filter(label => {
    const box = labelBox(label, fontSize), height = pageSize(pages[label.pageIndex]).height
    const hitsText = (pageText.get(label.pageIndex) ?? []).some(fragment => {
      if (!fragment.text.trim()) return false
      const xs = fragment.quad.map(point => point.x), ys = fragment.quad.map(point => height - point.y)
      return overlap(box, { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) })
    })
    const hitsOverlay = overlays.some(overlay => {
      if (overlay.pageIndex !== label.pageIndex) return false
      const other = overlayBox(overlay)
      return !!other && overlap(box, other)
    })
    return hitsText || hitsOverlay
  }).map(label => label.pageIndex)
}

/** Labels of one position replace each other when applied again. */
export const withoutLabelGroup = (overlays: Overlay[], position: LabelPosition) =>
  overlays.filter(overlay => !(isTextbox(overlay) && overlay.labelGroup === position))
