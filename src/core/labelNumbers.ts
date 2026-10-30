// Keeps page labels in step with the document (T22): after every page change their
// numbers follow the new order. A label a person edited by hand stays as it is.
import { isTextbox, type Overlay, type OverlayFont, type Textbox } from './model'

/** What a label was generated from, so it can be generated again. */
export interface LabelSource { template: string; start: number; text: string }

/** Width of one digit per font size: digits are equally wide in the standard fonts. */
const DIGIT_WIDTH: Partial<Record<OverlayFont, number>> = { helvetica: 0.556, times: 0.5, courier: 0.6 }

export function labelText(template: string, number: number, last: number): string {
  return template.replace(/\{n\}/g, String(number)).replace(/\{gesamt\}/g, String(last))
}

const digits = (text: string) => (text.match(/\d/g) ?? []).length

export function renumberLabels(overlays: Overlay[]): void {
  const groups = new Map<string, Textbox[]>()
  for (const overlay of overlays) {
    if (!isTextbox(overlay) || !overlay.label || !overlay.labelGroup) continue
    const group = groups.get(overlay.labelGroup) ?? []
    group.push(overlay)
    groups.set(overlay.labelGroup, group)
  }
  for (const [position, boxes] of groups) {
    boxes.sort((a, b) => a.pageIndex - b.pageIndex)
    const start = boxes[0].label!.start, last = start + boxes.length - 1
    boxes.forEach((box, index) => {
      const source = box.label!
      if (box.text !== source.text) return
      const text = labelText(source.template, start + index, last)
      // Centered and right-aligned labels keep their anchor when the number gets longer.
      const grown = (digits(text) - digits(box.text)) * (DIGIT_WIDTH[box.font] ?? 0.55) * box.fontSize
      if (!box.rotation) box.x -= position.endsWith('right') ? grown : position.endsWith('center') ? grown / 2 : 0
      box.text = text
      box.label = { ...source, text }
    })
  }
}
