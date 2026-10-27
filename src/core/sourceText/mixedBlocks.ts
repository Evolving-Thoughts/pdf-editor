/** Reconstructs editable paragraph blocks from independently positioned PDF
 * text fragments (typical Word export) and lays edited blocks out again.
 * Pure geometry/text logic: the PDF adapter must prove every input first.
 * A block is only formed when the fragments are contiguous on each line,
 * share their marked-content sequence, painting position, clip, transform and
 * font size, and when re-wrapping the original text reproduces every original
 * line break exactly. Nothing here invents glyphs, hyphenation or spacing. */
import type { SourceFont } from './sourceFonts'

export interface BlockRect { left: number; right: number; bottom: number; top: number }
export interface BlockInput {
  index: number
  text: string
  codes: number[]
  adjustments: number[]
  font: SourceFont
  fontRaw: string
  fill: string
  size: number
  /** Character and word spacing (Tc/Tw) in unscaled text space. */
  tc: number
  tw: number
  /** Page-space origin of the text-show operator. */
  x: number
  baseline: number
  /** Advance including the trailing TJ adjustment. */
  advance: number
  eligible: boolean
  /** Text object (BT/ET) number; a block must own every show of its text objects. */
  bt: number
  /** Members must have an identical key (marked content, paint order, clip, CTM, size). */
  key: string
  tagged: boolean
}
export interface BlockGlyph {
  char: string
  code: number
  font: SourceFont
  fontRaw: string
  fill: string
  tc: number
  tw: number
  /** Advance in points, including Tc/Tw. */
  width: number
  /** TJ units before this glyph, relative to its ORIGINAL predecessor on the same line. */
  kern: number
  /** TJ units before this glyph when it starts an original line. */
  startKern: number
  /** Index in the original block glyph sequence, -1 for newly inserted glyphs. */
  orig: number
  lineStart: boolean
}
export interface BlockLine { from: number; to: number; left: number; baseline: number; runs: number[] }
export interface SourceBlock {
  id: string
  members: number[]
  lines: BlockLine[]
  right: number
  leading: number
  glyphs: BlockGlyph[]
  text: string
  tagged: boolean
  size: number
}
export interface PlacedLine { from: number; to: number; left: number; baseline: number; positions: number[]; kerns: number[]; extent: number }

/** Maximum residual between fragments that still counts as contiguous text,
 * relative to the font size. Word positions fragments with pair kerning and
 * rounding (observed up to ~0.08 em); an omitted word space is ~0.2 em or more. */
export const CONTIGUITY_TOLERANCE = 0.12
const EPS = 0.01

export function glyphWidth(font: SourceFont, code: number, char: string, size: number, tc = 0, tw = 0) {
  const encoded = font.codec.encode(char)
  const units = font.advances?.get(code) ?? (encoded.ok ? encoded.value.advance : NaN)
  return (units * size) / 1000 + tc + (font.codeBytes === 1 && code === 32 ? tw : 0)
}
const sameStyle = (a: BlockGlyph, b: BlockGlyph) => a.fontRaw === b.fontRaw && a.fill === b.fill && a.tc === b.tc && a.tw === b.tw
export const baseFontName = (name: string) => name.replace(/^[A-Z]{6}\+/, '')

/** Break opportunities exist only after spaces and after existing in-word hyphens. */
export function breakAfter(glyphs: readonly BlockGlyph[], k: number) {
  const c = glyphs[k].char, next = glyphs[k + 1]?.char
  if (next === undefined) return true
  if (c === ' ') return next !== ' '
  return c === '-' && k > 0 && glyphs[k - 1].char !== ' ' && next !== ' '
}
const kept = (glyphs: readonly BlockGlyph[], k: number) => {
  const g = glyphs[k], p = glyphs[k - 1]
  return g.orig >= 0 && p.orig >= 0 && g.orig === p.orig + 1 && !g.lineStart
}
/** Original kerning survives only for unchanged neighbouring pairs. */
export function placeLine(glyphs: readonly BlockGlyph[], from: number, to: number, left: number, size: number) {
  const positions: number[] = [], kerns: number[] = []
  let x = left, extent = left
  for (let k = from; k < to; k++) {
    const g = glyphs[k]
    const kern = k === from ? (g.lineStart ? g.startKern : 0) : kept(glyphs, k) ? g.kern : 0
    x -= (kern * size) / 1000
    positions.push(x); kerns.push(kern)
    x += g.width
    if (g.char !== ' ') extent = x
  }
  return { positions, kerns, extent }
}

/** Greedy whole-word wrap. Single-line blocks never wrap (no known margin). */
export function wrapBlock(glyphs: readonly BlockGlyph[], lefts: readonly number[], right: number, size: number, single: boolean, maxLines = 512) {
  if (!glyphs.length) return null
  if (single) return [{ from: 0, to: glyphs.length }]
  const lines: { from: number; to: number }[] = []
  let start = 0
  while (start < glyphs.length) {
    const left = lefts[Math.min(lines.length, lefts.length - 1)]
    let best = -1
    for (let end = start + 1; end <= glyphs.length; end++) {
      if (end < glyphs.length && !breakAfter(glyphs, end - 1)) continue
      if (placeLine(glyphs, start, end, left, size).extent <= right + EPS) best = end
      else break
    }
    if (best < 0 || lines.length >= maxLines) return null
    lines.push({ from: start, to: best })
    start = best
  }
  return lines
}

function makeBlock(inputs: readonly BlockInput[], lines: number[][], pageIndex: number, column = -Infinity): SourceBlock {
  const glyphs: BlockGlyph[] = [], blockLines: BlockLine[] = []
  const first = inputs[lines[0][0]], size = first.size
  for (const line of lines) {
    const from = glyphs.length
    line.forEach((index, position) => {
      const run = inputs[index], prev = position ? inputs[line[position - 1]] : undefined
      // Fold the residual between contiguous fragments into the kerning of the
      // pair so unchanged text is re-emitted at its exact original position.
      const residual = prev ? run.x - (prev.x + prev.advance) : 0
      const trail = prev ? prev.adjustments[prev.codes.length] ?? 0 : 0
      run.codes.forEach((code, i) => {
        const char = run.font.decode.get(code)!
        const adjustment = run.adjustments[i] ?? 0
        const lineStart = !prev && i === 0
        glyphs.push({
          char, code, font: run.font, fontRaw: run.fontRaw, fill: run.fill, tc: run.tc, tw: run.tw,
          width: glyphWidth(run.font, code, char, size, run.tc, run.tw),
          kern: lineStart ? 0 : i === 0 ? trail + adjustment - (residual * 1000) / size : adjustment,
          startKern: lineStart ? adjustment : 0,
          orig: glyphs.length, lineStart,
        })
      })
    })
    blockLines.push({ from, to: glyphs.length, left: inputs[line[0]].x, baseline: inputs[line[0]].baseline, runs: line })
  }
  const right = Math.max(column, ...blockLines.map(l => placeLine(glyphs, l.from, l.to, l.left, size).extent))
  const leading = lines.length > 1 ? (blockLines[0].baseline - blockLines.at(-1)!.baseline) / (lines.length - 1) : 0
  return {
    id: `mixed-block:${pageIndex}:${first.index}`, members: lines.flat(), lines: blockLines, right, leading,
    glyphs, text: glyphs.map(g => g.char).join(''), tagged: lines.flat().every(i => inputs[i].tagged), size,
  }
}

const reproduces = (block: SourceBlock) => {
  const plan = wrapBlock(block.glyphs, block.lines.map(l => l.left), block.right, block.size, false, block.lines.length + 1)
  return !!plan && plan.length === block.lines.length && plan.every((p, k) => p.to === block.lines[k].to)
}
/** Split at proven hard breaks; degrade to single lines when wrapping is not
 * reproducible. The widest line of the text column is a valid lower bound for
 * the real margin: prefer it so repeated edits do not narrow a paragraph. */
function settle(inputs: readonly BlockInput[], lines: number[][], pageIndex: number, column: number): SourceBlock[] {
  if (lines.length > 1) {
    const wide = makeBlock(inputs, lines, pageIndex, column)
    if (wide.right > wide.lines[0].left && reproduces(wide)) return [wide]
  }
  const block = makeBlock(inputs, lines, pageIndex)
  if (lines.length === 1) return [block]
  const plan = wrapBlock(block.glyphs, block.lines.map(l => l.left), block.right, block.size, false, lines.length + 1)
  if (plan) {
    for (let k = 0; k < block.lines.length; k++) {
      if (plan[k]?.to === block.lines[k].to) continue
      // The next word would have fit: this original break was intentional.
      if (plan[k] && plan[k].to > block.lines[k].to)
        return [...settle(inputs, lines.slice(0, k + 1), pageIndex, column), ...settle(inputs, lines.slice(k + 1), pageIndex, column)]
      break
    }
    if (plan.length === block.lines.length && plan.every((p, k) => p.to === block.lines[k].to)) return [block]
  }
  return lines.flatMap(line => settle(inputs, [line], pageIndex, column))
}

export function buildBlocks(inputs: readonly BlockInput[], pageIndex: number): SourceBlock[] {
  const groups: number[][][] = []
  let lines: number[][] | null = null, leading = 0
  const close = () => {
    if (lines) groups.push(lines)
    lines = null
  }
  const start = (run: BlockInput) => { lines = [[run.index]]; leading = 0 }
  for (const run of inputs) {
    if (!run.eligible) { close(); continue }
    const current = lines as number[][] | null
    if (!current || inputs[current[0][0]].key !== run.key) { close(); start(run); continue }
    const line = current.at(-1)!, prev = inputs[line.at(-1)!]
    if (Math.abs(run.baseline - prev.baseline) < 0.01) {
      if (Math.abs(run.x - (prev.x + prev.advance)) <= CONTIGUITY_TOLERANCE * run.size) line.push(run.index)
      else { close(); start(run) }
      continue
    }
    const delta = prev.baseline - run.baseline
    const text = line.map(i => inputs[i].text).join('')
    const soft = / $/.test(text) || /[^\s]-$/.test(text)
    // Word rounds baselines to its layout grid (observed ±0.12 pt at 12 pt);
    // a paragraph gap is several points larger than the line pitch.
    const leadingOk = current.length === 1 ? delta > 0 && delta <= run.size * 2.5 : Math.abs(delta - leading) <= run.size * 0.025
    // Contour wraps (e.g. around images) are only accepted inside one tagged sequence.
    const leftOk = run.tagged || Math.abs(run.x - inputs[current[0][0]].x) < 0.01
    if (delta > 0 && soft && leadingOk && leftOk) {
      if (current.length === 1) leading = delta
      current.push([run.index])
    } else { close(); start(run) }
  }
  close()
  // Column bound: widest line of a multi-line group of the same size whose
  // horizontal range contains this group's left edge.
  const multi = groups.filter(g => g.length > 1).map(g => ({
    size: inputs[g[0][0]].size,
    left: Math.min(...g.map(line => inputs[line[0]].x)),
    right: makeBlock(inputs, g, pageIndex).right,
  }))
  const byText = new Map<number, number[]>()
  for (const r of inputs) byText.set(r.bt, [...(byText.get(r.bt) ?? []), r.index])
  const blocks: SourceBlock[] = []
  for (const g of groups) {
    const left = Math.min(...g.map(line => inputs[line[0]].x)), size = inputs[g[0][0]].size
    let column = -Infinity
    for (const m of multi) if (m.size === size && m.left <= left + EPS && m.right > left) column = Math.max(column, m.right)
    for (const b of settle(inputs, g, pageIndex, column)) {
      if (!b.text.trim()) continue
      // A block must own every text-show of its text objects, so that the
      // whole block can be rewritten without moving foreign text.
      const owned = new Set(b.members)
      if (b.members.some(m => byText.get(inputs[m].bt)!.some(i => !owned.has(i)))) continue
      blocks.push(b)
    }
  }
  return blocks
}

/** Apply a full-text replacement. Unchanged glyphs keep code, font, colour and
 * kerning; inserted glyphs take the style of the replaced (or preceding) text and
 * fall back only to another subset of the SAME typeface and colour. */
export function editBlock(block: SourceBlock, replacement: string) {
  const old = block.glyphs
  // Glyph-level diff: an untouched ligature stays the original glyph; editing
  // inside it needs the single characters in the original font.
  let prefix = 0, suffix = 0, head = 0, tail = replacement.length
  while (prefix < old.length && replacement.startsWith(old[prefix].char, head)) head += old[prefix++].char.length
  while (suffix < old.length - prefix) {
    const c = old[old.length - 1 - suffix].char
    if (tail - c.length < head || !replacement.endsWith(c, tail)) break
    tail -= c.length; suffix++
  }
  const chars = Array.from(replacement.slice(head, tail))
  const replaced = old.length - suffix > prefix
  const style = replaced ? old[prefix] : old[prefix - 1] ?? old[prefix]
  const styles: BlockGlyph[] = [style]
  for (const g of old) if (!styles.some(s => sameStyle(s, g)) && g.fill === style.fill && baseFontName(g.font.name) === baseFontName(style.font.name)) styles.push(g)
  const middle: BlockGlyph[] = []
  for (const char of chars) {
    let glyph: BlockGlyph | undefined
    for (const s of styles) {
      const encoded = s.font.codec.encode(char)
      if (!encoded.ok || encoded.value.hex.length !== s.font.codeBytes * 2) continue
      const code = parseInt(encoded.value.hex, 16)
      glyph = { char, code, font: s.font, fontRaw: s.fontRaw, fill: s.fill, tc: s.tc, tw: s.tw, width: glyphWidth(s.font, code, char, block.size, s.tc, s.tw), kern: 0, startKern: 0, orig: -1, lineStart: false }
      break
    }
    if (!glyph) return { ok: false as const, char }
    middle.push(glyph)
  }
  return { ok: true as const, glyphs: [...old.slice(0, prefix), ...middle, ...old.slice(old.length - suffix)] }
}

export function inkBox(glyphs: readonly BlockGlyph[], line: PlacedLine, size: number): BlockRect | undefined {
  let r: BlockRect | undefined
  for (let k = line.from; k < line.to; k++) {
    const g = glyphs[k]
    if (!g.char.trim()) continue
    const b = g.font.boxes?.get(g.code) ?? g.font.bbox, x = line.positions[k - line.from]
    const box = { left: x + (b[0] * size) / 1000, right: x + (b[2] * size) / 1000, bottom: line.baseline + (b[1] * size) / 1000, top: line.baseline + (b[3] * size) / 1000 }
    r = r ? { left: Math.min(r.left, box.left), right: Math.max(r.right, box.right), bottom: Math.min(r.bottom, box.bottom), top: Math.max(r.top, box.top) } : box
  }
  return r
}

/** PDF numbers never use exponent notation. */
export function pdfNumber(value: number) {
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) || Math.abs(rounded) < 1e-6 ? '0' : String(rounded)
}

/** Emit the laid-out block into one text object. Returns the content and the
 * expected text-show origins for independent re-analysis of the candidate. */
export function emitBlock(glyphs: readonly BlockGlyph[], lines: readonly PlacedLine[], size: number, origin: [number, number], restore: { fontRaw: string; fill: string; tc: number; tw: number }) {
  let content = ''
  const expected: { text: string; fontName: string; x: number; baseline: number }[] = []
  const hex = (g: BlockGlyph) => g.code.toString(16).toUpperCase().padStart(g.font.codeBytes * 2, '0')
  for (const line of lines) {
    const tx = Number(pdfNumber(line.left - origin[0])), ty = Number(pdfNumber(line.baseline - origin[1]))
    content += `1 0 0 1 ${pdfNumber(tx)} ${pdfNumber(ty)} Tm\n`
    let k = line.from, x = tx + origin[0]
    while (k < line.to) {
      const style = glyphs[k]
      let end = k, operand = '['
      while (end < line.to && sameStyle(glyphs[end], style)) {
        const kern = line.kerns[end - line.from]
        if (kern) operand += `${pdfNumber(kern)} `
        operand += `<${hex(glyphs[end])}>`
        end++
      }
      content += `${style.fontRaw} ${pdfNumber(size)} Tf\n${style.fill}\n${pdfNumber(style.tc)} Tc\n${pdfNumber(style.tw)} Tw\n${operand}] TJ\n`
      expected.push({ text: glyphs.slice(k, end).map(g => g.char).join(''), fontName: style.font.name, x, baseline: ty + origin[1] })
      for (let i = k; i < end; i++) x += -(Number(pdfNumber(line.kerns[i - line.from])) * size) / 1000 + glyphs[i].width
      k = end
    }
  }
  content += `${restore.fontRaw} ${pdfNumber(size)} Tf\n${restore.fill}\n${pdfNumber(restore.tc)} Tc\n${pdfNumber(restore.tw)} Tw\n`
  return { content, expected }
}
