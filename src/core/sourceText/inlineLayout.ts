/** Pure geometry for the inline paragraph editor: live layout with
 * placeholders for missing characters, caret/selection geometry, hit tests
 * and the fit status. Everything is in PDF page space (y up). The worker's
 * preview of the real PDF still decides whether a change is applied. */
import { SOFT_HYPHEN, hidden, inkBox, layoutEdit, placeLine } from './mixedBlocks'
import { blockedBy, slotBox } from './space'
import type { BlockSpace, Box } from './space'
import type { BlockGlyph, PlacedLine, SourceBlock } from './mixedBlocks'
import { supportedSourceText } from './encoding'

export type FitStatus =
  | { kind: 'same' | 'ok'; before: number; after: number }
  | { kind: 'overflow' | 'limit'; before: number; after: number; room: number; reason: string }
  | { kind: 'wide' | 'missing' | 'pinned' | 'invalid'; before: number; after: number; chars?: string[] }

export interface InlineView {
  glyphs: BlockGlyph[]
  lines: PlacedLine[]
  /** Text offset where glyph k starts; one extra entry for the end. */
  offsets: number[]
  /** Glyph indices standing in for characters the font lacks. */
  missing: Set<number>
  /** Lines (index) that do not fit below the block. */
  overflow: Set<number>
  status: FitStatus
}
export interface BlockLimits { room: number; pinned: readonly number[]; slots: readonly Box[]; space: BlockSpace }

/** A character already present in the block (always encodable). */
function placeholder(block: SourceBlock) {
  const plain = block.glyphs.filter(g => !g.actual && !g.virtual && g.char.length === 1 && /\p{L}/u.test(g.char))
  for (const c of 'xnoea') if (plain.some(g => g.char === c)) return c
  return plain[0]?.char ?? block.glyphs.find(g => !g.actual && g.char.trim() && g.char.length === 1)?.char
}

export function inlineLayout(block: SourceBlock, text: string, limits: BlockLimits): InlineView | null {
  const before = block.lines.length
  const missingChars: string[] = []
  let work = text
  let layout = layoutEdit(block, work)
  const stand = placeholder(block)
  // Replace each code unit of a missing character, so offsets stay aligned.
  for (let i = 0; i < 64 && !layout.ok && layout.reason === 'char' && stand; i++) {
    const c = layout.char
    missingChars.push(c)
    work = work.split(c).join(stand.repeat(c.length))
    layout = layoutEdit(block, work)
  }
  if (!layout.ok) return null
  const { glyphs, lines } = layout
  const offsets = [0]
  for (const g of glyphs) offsets.push(offsets.at(-1)! + g.char.length)
  if (offsets.at(-1) !== text.length) return null
  const missing = new Set<number>()
  if (missingChars.length)
    glyphs.forEach((_, k) => { if (work.slice(offsets[k], offsets[k + 1]) !== text.slice(offsets[k], offsets[k + 1])) missing.add(k) })
  // The worker's free-space rules, line by line (same code, same inputs).
  const overflow = new Set<number>()
  let problem: { line: number; reason: string } | undefined
  lines.forEach((line, i) => {
    const ink = inkBox(glyphs, line)
    if (!ink) return
    const old = limits.slots[i]
    const reason = blockedBy(limits.space, old ? slotBox(limits.space, line.left, line.baseline, Math.max(line.extent, ink.right)) : ink, old, ink)
    if (!reason) return
    if (i >= before) overflow.add(i)
    problem ??= { line: i, reason }
  })
  const after = lines.length
  let status: FitStatus
  if (text === block.text) status = { kind: 'same', before, after }
  else if (!text.trim() || !supportedSourceText(text)) status = { kind: 'invalid', before, after, chars: [...new Set(Array.from(text).filter(c => !supportedSourceText(c)))] }
  else if (missingChars.length) status = { kind: 'missing', before, after, chars: [...new Set(missingChars)] }
  else if (problem) status = { kind: problem.line >= before ? 'overflow' : 'limit', before, after, room: limits.room, reason: problem.reason }
  else if (movedPinned(block, glyphs, lines, limits.pinned)) status = { kind: 'pinned', before, after }
  else status = { kind: 'ok', before, after }
  return { glyphs, lines, offsets, missing, overflow, status }
}

function movedPinned(block: SourceBlock, glyphs: readonly BlockGlyph[], lines: readonly PlacedLine[], pinned: readonly number[]) {
  if (!pinned.length) return false
  const where = new Map<number, { x: number; y: number }>()
  for (const l of lines) for (let k = l.from; k < l.to; k++) if (glyphs[k].orig >= 0) where.set(glyphs[k].orig, { x: l.positions[k - l.from], y: l.baseline })
  const original = new Map<number, { x: number; y: number }>()
  for (const l of block.lines) {
    const placed = placeLine(block.glyphs, l.from, l.to, l.left)
    for (let k = l.from; k < l.to; k++) original.set(k, { x: placed.positions[k - l.from], y: l.baseline })
  }
  return pinned.some(o => {
    const a = where.get(o), b = original.get(o)
    return !a || !b || Math.abs(a.x - b.x) > 0.01 || Math.abs(a.y - b.y) > 1e-6
  })
}

/** Painted glyphs: page x, baseline, glyph and its display character. */
export function paintedGlyphs(view: InlineView) {
  const out: { k: number; x: number; baseline: number; glyph: BlockGlyph; char: string; line: number }[] = []
  view.lines.forEach((l, i) => {
    for (let k = l.from; k < l.to; k++) {
      if (hidden(view.glyphs, k, l.to)) continue
      const glyph = view.glyphs[k]
      if (!glyph.char.trim() && glyph.char !== '\u00a0') continue
      out.push({ k, x: l.positions[k - l.from], baseline: l.baseline, glyph, char: glyph.char === SOFT_HYPHEN ? '-' : glyph.char, line: i })
    }
  })
  return out
}

/** Caret stops: for each text offset its line and x. An offset at a line
 * break belongs to the start of the following line. */
export function caretStops(view: InlineView) {
  const stops: { line: number; x: number }[] = new Array(view.offsets.at(-1)! + 1)
  view.lines.forEach((l, i) => {
    for (let k = l.from; k < l.to; k++) {
      const g = view.glyphs[k], x = l.positions[k - l.from], w = hidden(view.glyphs, k, l.to) ? 0 : g.width
      const parts = g.char.length
      for (let p = 0; p < parts; p++) stops[view.offsets[k] + p] ??= { line: i, x: x + (w * p) / parts }
      if (k === l.to - 1) stops[view.offsets[k + 1]] = { line: i, x: x + w }
    }
  })
  // Later lines overwrite the end stop of the previous line with their start.
  view.lines.forEach((l, i) => { if (l.from < l.to) stops[view.offsets[l.from]] = { line: i, x: l.positions[0] } })
  for (let i = 0; i < stops.length; i++) stops[i] ??= stops[i - 1] ?? { line: 0, x: view.lines[0]?.left ?? 0 }
  return stops
}
/** Offsets that start and end each line (end exclusive of the next line start). */
export function lineRange(view: InlineView, line: number) {
  const l = view.lines[line]
  return { start: view.offsets[l.from], end: view.offsets[l.to] }
}
export function nearestOffset(view: InlineView, stops: ReturnType<typeof caretStops>, line: number, x: number) {
  const { start, end } = lineRange(view, line)
  // At a soft line break, stopping before the trailing space keeps the caret on this line.
  const last = line < view.lines.length - 1 && end > start && view.glyphs[view.lines[line].to - 1].char === ' ' ? end - 1 : end
  let best = start, distance = Infinity
  for (let o = start; o <= last; o++) {
    const s = o === end && line < view.lines.length - 1 ? lineEndX(view, line) : stops[o].x
    const d = Math.abs(s - x)
    if (d < distance) { distance = d; best = o }
  }
  return best
}
function lineEndX(view: InlineView, line: number) {
  const l = view.lines[line], k = l.to - 1
  return l.positions[k - l.from] + (hidden(view.glyphs, k, l.to) ? 0 : view.glyphs[k].width)
}
/** Offset under a page-space point (nearest line by baseline band). */
export function hitOffset(view: InlineView, stops: ReturnType<typeof caretStops>, x: number, y: number, size: number) {
  let line = 0, distance = Infinity
  view.lines.forEach((l, i) => {
    const mid = l.baseline + 0.3 * size, d = Math.abs(y - mid)
    if (d < distance) { distance = d; line = i }
  })
  return nearestOffset(view, stops, line, x)
}
/** Highlight rectangles (page space) for a text range. */
export function selectionRects(view: InlineView, stops: ReturnType<typeof caretStops>, from: number, to: number, size: number) {
  const rects: { left: number; right: number; bottom: number; top: number }[] = []
  if (from >= to) return rects
  view.lines.forEach((l, i) => {
    const { start, end } = lineRange(view, i)
    const a = Math.max(from, start), b = Math.min(to, end)
    if (a >= b) return
    const left = stops[a].line === i ? stops[a].x : l.left
    const right = b === end ? lineEndX(view, i) : stops[b].x
    rects.push({ left, right: Math.max(left + 0.5, right), bottom: l.baseline - 0.25 * size, top: l.baseline + 0.9 * size })
  })
  return rects
}
