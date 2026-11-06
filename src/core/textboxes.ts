// Textbox rules shared by the views: creation style, rotation and copy/paste. Framework-free.
import type { Bounds } from './images/geometry'
import { createId, type OverlayFont, type StrokePoint, type Textbox } from './model'

/** The settings a new textbox takes over from the last one edited in the same document. */
export type TextStyle = Pick<Textbox, 'font' | 'fontSize' | 'bold' | 'italic' | 'underline'>

export const DEFAULT_TEXT_STYLE: TextStyle = { font: 'helvetica', fontSize: 14, bold: false, italic: false, underline: false }

/** Symbol boxes use their own font and do not change the text style. */
export function textStyleOf(box: Textbox): TextStyle | null {
  if (box.font === 'zapfdingbats') return null
  const { font, fontSize, bold, italic, underline } = box
  return { font, fontSize, bold, italic, underline }
}

export function createTextbox(pageId: string, point: StrokePoint, style: TextStyle, id = createId()): Textbox {
  return { id, pageId, x: point.x, y: point.y, text: '', ...style }
}

export function createSymbolBox(pageId: string, point: StrokePoint, symbol: string, fontSize = DEFAULT_TEXT_STYLE.fontSize, id = createId()): Textbox {
  const font: OverlayFont = 'zapfdingbats'
  return { id, pageId, x: point.x, y: point.y, text: symbol, font, fontSize, bold: false, italic: false, underline: false }
}

const normalize = (angle: number) => ((angle % 360) + 360) % 360

/** Clockwise degrees around the baseline origin; Shift snaps to 15° steps. */
export function rotateTextbox(angle: number, snap = false): number {
  if (!Number.isFinite(angle)) return 0
  const rotation = normalize(snap ? Math.round(angle / 15) * 15 : angle)
  return Math.round(rotation * 10) / 10 % 360
}

/** Offset of a pasted copy, so it never hides exactly behind its original. */
export const PASTE_OFFSET = 12

/**
 * A pasted copy of a box: new id, shifted down-right and kept on the page.
 * It is plain text again: page-label links and crop clips stay with the original.
 */
export function pastedTextbox(box: Textbox, page: Bounds, pageId = box.pageId, offset = PASTE_OFFSET, id = createId()): Textbox {
  const copy: Textbox = { ...box, id, pageId }
  delete copy.label
  delete copy.labelGroup
  delete copy.clips
  copy.x = Math.max(0, Math.min(page.width, box.x + offset))
  copy.y = Math.max(0, Math.min(page.height, box.y - offset))
  return copy
}
