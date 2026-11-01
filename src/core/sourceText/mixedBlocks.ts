/** Reconstructs editable paragraph blocks from independently positioned PDF
 * text fragments and lays edited blocks out again. Pure geometry/text logic,
 * shared by the isolated worker (authoritative) and the inline editor (live
 * preview); the PDF adapter must prove every input first.
 *
 * All positions and widths are in page space; raw text-space values (Tf, Tc,
 * Tw) are kept per glyph for re-emission under the original text matrix.
 * A block is only formed when the fragments are contiguous on each line,
 * share their marked-content sequence, painting position, clip and transform,
 * and when re-wrapping the original text reproduces every original line break
 * exactly. Line breaks without a space glyph get an inferred word space; a
 * line-end hyphen between lowercase letters is treated as a hyphenation point. */
import type { SourceFont } from './sourceTypes'

export interface BlockRect { left: number; right: number; bottom: number; top: number }
export interface BlockInput {
  index: number
  text: string
  codes: number[]
  /** Character(s) per code; an ActualText glyph carries its whole replacement text. */
  chars: string[]
  actual?: boolean
  adjustments: number[]
  font: SourceFont
  fontRaw: string
  fill: string
  /** Raw Tf size and Tc/Tw in unscaled text space. */
  tf: number
  tc: number
  tw: number
  /** Uniform page scale of the text space (CTM × Tm). */
  scale: number
  /** Page-space font size (tf × scale). */
  size: number
  /** Page-space origin of the text-show operator. */
  x: number
  baseline: number
  /** Page-space advance including the trailing TJ adjustment. */
  advance: number
  eligible: boolean
  /** Members must have an identical key (marked content, paint order, clip, transform, graphics state). */
  key: string
  tagged: boolean
}
export interface BlockGlyph {
  char: string
  code: number
  font: SourceFont
  fontRaw: string
  fill: string
  tf: number
  tc: number
  tw: number
  scale: number
  /** Page-space font size. */
  size: number
  /** Page-space advance, including Tc/Tw. */
  width: number
  /** TJ units before this glyph, relative to its ORIGINAL predecessor on the same line. */
  kern: number
  /** TJ units before this glyph when it starts an original line. */
  startKern: number
  /** Index in the original block glyph sequence, -1 for newly inserted glyphs. */
  orig: number
  lineStart: boolean
  /** Original ActualText glyph (ligature, no-break space): re-emitted with its span. */
  actual?: boolean
  /** Inferred word space at an original line break without a space glyph. */
  virtual?: boolean
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
  /** Page-space size of the first glyph (display only; glyphs carry their own). */
  size: number
  justified: boolean
}
export interface PlacedLine { from: number; to: number; left: number; baseline: number; positions: number[]; kerns: number[]; extent: number }

/** Maximum residual between fragments that still counts as contiguous text,
 * relative to the font size. Word positions fragments with pair kerning and
 * rounding (observed up to ~0.08 em); an omitted word space is ~0.2 em or more. */
export const CONTIGUITY_TOLERANCE = 0.12
export const SOFT_HYPHEN = '\u00ad'
const EPS = 0.01

/** Width in 1/1000 em of a code: declared PDF width first, never a guess. */
export function codeAdvance(font: SourceFont, code: number, char: string) {
  const declared = font.advances?.get(code)
  if (declared !== undefined) return declared
  const encoded = Array.from(char).length === 1 ? font.codec.encode(char) : undefined
  return encoded?.ok ? encoded.value.advance : font.defaultWidth ?? NaN
}
type Metric = Pick<BlockGlyph, 'font' | 'code' | 'char' | 'tf' | 'tc' | 'tw' | 'scale'>
export const glyphAdvance = (g: Metric) =>
  ((codeAdvance(g.font, g.code, g.char) * g.tf) / 1000 + g.tc + (g.font.codeBytes === 1 && g.code === 32 ? g.tw : 0)) * g.scale
const sameStyle = (a: BlockGlyph, b: BlockGlyph) =>
  a.fontRaw === b.fontRaw && a.fill === b.fill && a.tc === b.tc && a.tw === b.tw && a.tf === b.tf && !a.actual && !b.actual
export const baseFontName = (name: string) => name.replace(/^[A-Z]{6}\+/, '')

/** A word space in the font of `after`, used for inferred line-break spaces. */
export function spaceGlyph(after: Omit<BlockGlyph, 'width' | 'kern' | 'startKern' | 'orig' | 'lineStart' | 'char' | 'code'>): BlockGlyph | undefined {
  const encoded = after.font.codec.encode(' ')
  if (!encoded.ok || encoded.value.hex.length !== after.font.codeBytes * 2) return undefined
  const g: BlockGlyph = { ...after, char: ' ', code: parseInt(encoded.value.hex, 16), width: 0, kern: 0, startKern: 0, orig: -1, lineStart: false, actual: false, virtual: true }
  g.width = glyphAdvance(g)
  return g.width > 0 ? g : undefined
}

/** Break opportunities exist only after spaces, soft hyphens and existing in-word hyphens. */
export function breakAfter(glyphs: readonly BlockGlyph[], k: number) {
  const c = glyphs[k].char, next = glyphs[k + 1]?.char
  if (next === undefined) return true
  if (next === ' ') return false
  if (c === ' ' || c === SOFT_HYPHEN) return true
  return c === '-' && k > 0 && glyphs[k - 1].char !== ' '
}
/** Glyphs that exist only in the editable text at this position: a soft
 * hyphen inside a line and an inferred space at a line end are not painted. */
export function hidden(glyphs: readonly BlockGlyph[], k: number, to: number) {
  const g = glyphs[k]
  if (g.char === SOFT_HYPHEN) return k !== to - 1
  if (!g.virtual) return false
  for (let j = k + 1; j < to; j++) if (glyphs[j].char !== ' ') return false
  return true
}
const kept = (glyphs: readonly BlockGlyph[], k: number) => {
  const g = glyphs[k], p = glyphs[k - 1]
  return g.orig >= 0 && p.orig >= 0 && g.orig === p.orig + 1 && !g.lineStart
}
/** Original kerning survives only for unchanged neighbouring pairs. */
export function placeLine(glyphs: readonly BlockGlyph[], from: number, to: number, left: number) {
  const positions: number[] = [], kerns: number[] = []
  let x = left, extent = left
  for (let k = from; k < to; k++) {
    const g = glyphs[k]
    if (hidden(glyphs, k, to)) { positions.push(x); kerns.push(0); continue }
    const kern = k === from ? (g.lineStart ? g.startKern : 0) : kept(glyphs, k) ? g.kern : 0
    x -= (kern * g.size) / 1000
    positions.push(x); kerns.push(kern)
    x += g.width
    if (g.char !== ' ') extent = x
  }
  return { positions, kerns, extent }
}

/** Greedy whole-word wrap from glyph `start`, the first line using line slot
 * `slot`. Single-line blocks never wrap (no known margin). */
export function wrapBlock(glyphs: readonly BlockGlyph[], lefts: readonly number[], right: number, single: boolean, start = 0, slot = 0, maxLines = 512) {
  if (!glyphs.length) return null
  if (single) return start < glyphs.length ? [{ from: start, to: glyphs.length }] : []
  const lines: { from: number; to: number }[] = []
  while (start < glyphs.length) {
    const left = lefts[Math.min(slot + lines.length, lefts.length - 1)]
    let best = -1
    for (let end = start + 1; end <= glyphs.length; end++) {
      if (end < glyphs.length && !breakAfter(glyphs, end - 1)) continue
      if (placeLine(glyphs, start, end, left).extent <= right + EPS) best = end
      else break
    }
    if (best < 0 || lines.length >= maxLines) return null
    lines.push({ from: start, to: best })
    start = best
  }
  return lines
}

/** How the original text continues after a line: '' (space or hyphen glyph
 * present), 'soft' (hyphenation point) or 'space' (inferred word space). */
function joint(prev: readonly string[], next: string): '' | 'soft' | 'space' {
  const last = prev.at(-1) ?? '', before = prev.at(-2) ?? ''
  if (last === ' ') return ''
  if (last === '-') return /\p{Ll}$/u.test(before) && /^\p{Ll}/u.test(next) ? 'soft' : ''
  return 'space'
}
const lastChars = (inputs: readonly BlockInput[], line: readonly number[]) => {
  const run = inputs[line.at(-1)!], prev = line.length > 1 ? inputs[line.at(-2)!] : undefined
  return [...(prev?.chars ?? []), ...run.chars].slice(-2)
}
const styleOf = (run: BlockInput) => ({ font: run.font, fontRaw: run.fontRaw, fill: run.fill, tf: run.tf, tc: run.tc, tw: run.tw, scale: run.scale, size: run.size })

function makeBlock(inputs: readonly BlockInput[], lines: number[][], pageIndex: number, column = -Infinity): SourceBlock {
  const glyphs: BlockGlyph[] = [], blockLines: BlockLine[] = []
  const first = inputs[lines[0][0]]
  lines.forEach((line, li) => {
    const from = glyphs.length
    line.forEach((index, position) => {
      const run = inputs[index], prev = position ? inputs[line[position - 1]] : undefined
      // Fold the residual between contiguous fragments into the kerning of the
      // pair so unchanged text is re-emitted at its exact original position.
      const residual = prev ? run.x - (prev.x + prev.advance) : 0
      const trail = prev ? ((prev.adjustments[prev.codes.length] ?? 0) * prev.size) / run.size : 0
      run.codes.forEach((code, i) => {
        const adjustment = run.adjustments[i] ?? 0
        const lineStart = !prev && i === 0
        const g: BlockGlyph = {
          ...styleOf(run), char: run.chars[i], code, width: 0,
          kern: lineStart ? 0 : i === 0 ? trail + adjustment - (residual * 1000) / run.size : adjustment,
          startKern: lineStart ? adjustment : 0,
          orig: glyphs.length, lineStart, actual: !!run.actual,
        }
        g.width = glyphAdvance(g)
        glyphs.push(g)
      })
    })
    if (li < lines.length - 1) {
      const kind = joint(glyphs.slice(-2).map(g => g.char), inputs[lines[li + 1][0]].chars[0] ?? '')
      const last = glyphs.at(-1)!
      if (kind === 'soft' && !last.actual) glyphs[glyphs.length - 1] = { ...last, char: SOFT_HYPHEN }
      else if (kind === 'space') {
        const space = spaceGlyph(last)
        if (space) glyphs.push({ ...space, orig: glyphs.length })
      }
    }
    blockLines.push({ from, to: glyphs.length, left: inputs[line[0]].x, baseline: inputs[line[0]].baseline, runs: line })
  })
  const extents = blockLines.map(l => placeLine(glyphs, l.from, l.to, l.left).extent)
  const right = Math.max(column, ...extents)
  const leading = lines.length > 1 ? (blockLines[0].baseline - blockLines.at(-1)!.baseline) / (lines.length - 1) : 0
  // Justified: every line but the last ends at the margin (at least two such
  // lines, or one when an independent column bound confirms the margin).
  const tolerance = Math.max(0.3, 0.02 * first.size), full = extents.slice(0, -1)
  const justified = (full.length >= 2 || (full.length === 1 && column > -Infinity)) &&
    full.every(e => right - e <= tolerance) && glyphs.some(g => g.char === ' ')
  return {
    id: `mixed-block:${pageIndex}:${first.index}`, members: lines.flat(), lines: blockLines, right, leading,
    glyphs, text: glyphs.map(g => g.char).join(''), tagged: lines.flat().every(i => inputs[i].tagged), size: first.size, justified,
  }
}

const reproduces = (block: SourceBlock) => {
  const plan = wrapBlock(block.glyphs, block.lines.map(l => l.left), block.right, false, 0, 0, block.lines.length + 1)
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
  const plan = wrapBlock(block.glyphs, block.lines.map(l => l.left), block.right, false, 0, 0, lines.length + 1)
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

/** `barriers` are painted rules, images and annotations: content lying
 * strictly between two lines separates them (e.g. table rows). */
export function buildBlocks(inputs: readonly BlockInput[], pageIndex: number, barriers: readonly BlockRect[] = []): SourceBlock[] {
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
    const kind = joint(lastChars(inputs, line), run.chars[0] ?? '')
    const joinable = kind !== 'space' || !!spaceGlyph(styleOf(prev))
    // Word rounds baselines to its layout grid (observed ±0.12 pt at 12 pt),
    // HTML renderers snap lines to device pixels (18.0/18.75 pt at 13.5 pt);
    // a paragraph gap is several points larger than the line pitch.
    const leadingOk = current.length === 1 ? delta > 0 && delta <= run.size * 2.5 : Math.abs(delta - leading) <= Math.max(0.05, run.size * 0.06)
    // A first-line indent is allowed; later lines share the second line's left
    // edge. Contour wraps (e.g. around images) only inside one tagged sequence.
    const leftOk = run.tagged || current.length === 1 || Math.abs(run.x - inputs[current[1][0]].x) < 0.01
    const lineLeft = inputs[line[0]].x
    const region = { left: Math.min(lineLeft, run.x), right: Math.max(prev.x + prev.advance, run.x + run.advance), bottom: run.baseline, top: prev.baseline }
    const barrier = barriers.some(b => b.bottom > region.bottom + EPS && b.top < region.top - EPS && b.left < region.right && b.right > region.left)
    if (delta > 0 && joinable && leadingOk && leftOk && !barrier) {
      if (current.length === 1) leading = delta
      current.push([run.index])
    } else if (current.length === 2 && delta > 0 && delta < leading - Math.max(0.05, run.size * 0.06) && joinable && !barrier && (run.tagged || Math.abs(run.x - inputs[current[1][0]].x) < 0.01)) {
      // The first pitch was a gap (heading or paragraph spacing above a line):
      // the first line stands alone, the second starts the paragraph.
      groups.push([current[0]])
      lines = [current[1], [run.index]]
      leading = delta
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
  const blocks: SourceBlock[] = []
  for (const g of groups) {
    const left = Math.min(...g.map(line => inputs[line[0]].x)), size = inputs[g[0][0]].size
    let column = -Infinity
    for (const m of multi) if (Math.abs(m.size - size) < 1e-6 && m.left <= left + EPS && m.right > left) column = Math.max(column, m.right)
    for (const b of settle(inputs, g, pageIndex, column)) if (b.text.trim()) blocks.push(b)
  }
  return blocks
}

/** Apply a full-text replacement. Unchanged glyphs keep code, font, colour and
 * kerning; inserted glyphs take the style of the replaced (or preceding) text and
 * fall back only to another subset of the SAME typeface and colour, or to an
 * existing glyph of the block for that exact character (e.g. a no-break space). */
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
  for (const g of old) if (!g.actual && !styles.some(s => sameStyle(s, g)) && g.fill === style.fill && baseFontName(g.font.name) === baseFontName(style.font.name)) styles.push(g)
  const middle: BlockGlyph[] = []
  for (const char of chars) {
    let glyph: BlockGlyph | undefined
    for (const s of styles) {
      const encoded = s.font.codec.encode(char === SOFT_HYPHEN ? '-' : char)
      if (encoded.ok && encoded.value.hex.length === s.font.codeBytes * 2) {
        const code = parseInt(encoded.value.hex, 16)
        glyph = { ...s, char, code, width: 0, kern: 0, startKern: 0, orig: -1, lineStart: false, actual: false, virtual: false }
        glyph.width = glyphAdvance(glyph)
        break
      }
      const same = old.find(g => g.char === char && g.fontRaw === s.fontRaw && g.fill === s.fill && g.tf === s.tf)
      if (same) { glyph = { ...same, kern: 0, startKern: 0, orig: -1, lineStart: false, virtual: false }; break }
    }
    if (!glyph) return { ok: false as const, char }
    middle.push(glyph)
  }
  return { ok: true as const, prefix, glyphs: [...old.slice(0, prefix), ...middle, ...old.slice(old.length - suffix)] }
}

/** Natural spacing for re-laid lines of a justified block: no word spacing and
 * no stretch kerning around spaces; the line is justified again afterwards. */
function natural(g: BlockGlyph, prev: BlockGlyph | undefined): BlockGlyph {
  const around = g.char === ' ' || prev?.char === ' '
  if (!g.tw && !(around && g.kern)) return g
  const n = { ...g, tw: 0, kern: around ? 0 : g.kern }
  n.width = glyphAdvance(n)
  return n
}
function justify(glyphs: readonly BlockGlyph[], line: PlacedLine, right: number) {
  const gaps: number[] = []
  let end = line.to
  while (end > line.from && (glyphs[end - 1].char === ' ' || hidden(glyphs, end - 1, line.to))) end--
  for (let k = line.from + 1; k < end; k++) if (glyphs[k - 1].char === ' ' && glyphs[k].char !== ' ') gaps.push(k)
  const slack = right - line.extent
  if (!gaps.length || slack <= EPS) return
  const each = slack / gaps.length
  let shift = 0
  for (let k = line.from; k < line.to; k++) {
    if (gaps.includes(k)) {
      shift += each
      line.kerns[k - line.from] -= (each * 1000) / glyphs[k].size
    }
    line.positions[k - line.from] += shift
  }
  line.extent += slack
}

export type EditLayout =
  | { ok: true; glyphs: BlockGlyph[]; lines: PlacedLine[]; changedFrom: number }
  | { ok: false; reason: 'char'; char: string }
  | { ok: false; reason: 'wide' }
/** Lay out an edited block. Lines before the line above the first change stay exact;
 * later lines that end up identical to an original line keep their original
 * glyphs and positions. Extra lines continue with the original leading. */
export function layoutEdit(block: SourceBlock, replacement: string): EditLayout {
  const edited = editBlock(block, replacement)
  if (!edited.ok) return { ok: false, reason: 'char', char: edited.char }
  const n = block.lines.length, lefts = block.lines.map(l => l.left)
  let changedFrom = block.lines.findIndex(l => edited.prefix < l.to)
  if (changedFrom < 0) changedFrom = n - 1
  // A shorter first word may move up into the previous line; earlier lines
  // cannot change, so wrapping from there equals a greedy wrap of the whole
  // paragraph and the result stays reproducible for later edits.
  const reflowFrom = Math.max(0, changedFrom - 1), start = block.lines[reflowFrom].from
  const glyphs = block.justified ? edited.glyphs.map((g, k, all) => (k < start ? g : natural(g, all[k - 1]))) : [...edited.glyphs]
  const rest = wrapBlock(glyphs, lefts, block.right, n === 1, start, reflowFrom)
  if (!rest) return { ok: false, reason: 'wide' }
  const plan = [...block.lines.slice(0, reflowFrom).map(l => ({ from: l.from, to: l.to })), ...rest]
  const restored = new Set<number>()
  for (let i = reflowFrom; i < plan.length && i < n; i++) {
    const p = plan[i], o = block.lines[i]
    if (p.to - p.from !== o.to - o.from) continue
    let same = true
    for (let k = p.from; k < p.to && same; k++) same = glyphs[k].orig === o.from + (k - p.from)
    if (!same) continue
    for (let k = p.from; k < p.to; k++) glyphs[k] = block.glyphs[glyphs[k].orig]
    restored.add(i)
  }
  const last = block.lines[n - 1].baseline
  const lines: PlacedLine[] = plan.map((p, i) => {
    const left = lefts[Math.min(i, n - 1)]
    const baseline = i < n ? block.lines[i].baseline : Number((last - (i - n + 1) * block.leading).toFixed(6))
    return { ...p, left, baseline, ...placeLine(glyphs, p.from, p.to, left) }
  })
  if (block.justified) lines.forEach((l, i) => { if (i >= reflowFrom && i < lines.length - 1 && !restored.has(i)) justify(glyphs, l, block.right) })
  return { ok: true, glyphs, lines, changedFrom }
}

export function inkBox(glyphs: readonly BlockGlyph[], line: PlacedLine): BlockRect | undefined {
  let r: BlockRect | undefined
  for (let k = line.from; k < line.to; k++) {
    const g = glyphs[k]
    if (!g.char.trim() || hidden(glyphs, k, line.to)) continue
    const b = g.font.boxes?.get(g.code) ?? g.font.bbox, x = line.positions[k - line.from]
    const box = { left: x + (b[0] * g.size) / 1000, right: x + (b[2] * g.size) / 1000, bottom: line.baseline + (b[1] * g.size) / 1000, top: line.baseline + (b[3] * g.size) / 1000 }
    r = r ? { left: Math.min(r.left, box.left), right: Math.max(r.right, box.right), bottom: Math.min(r.bottom, box.bottom), top: Math.max(r.top, box.top) } : box
  }
  return r
}

/** PDF numbers never use exponent notation. */
export function pdfNumber(value: number) {
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) || Math.abs(rounded) < 1e-6 ? '0' : String(rounded)
}
const utf16 = (text: string) => 'FEFF' + Array.from(text, c => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')

export interface EmitFrame {
  /** Linear part of the original text matrix (kept for every line). */
  linear: readonly number[]
  /** Page point → Tm translation, and back (through the unchanged CTM). */
  toText: (x: number, y: number) => [number, number]
  toPage: (e: number, f: number) => [number, number]
}
/** Emit the laid-out block. Returns the content and the expected text-show
 * runs for independent re-analysis of the candidate. */
export function emitBlock(glyphs: readonly BlockGlyph[], lines: readonly PlacedLine[], frame: EmitFrame) {
  let content = '', state = ''
  const expected: { text: string; fontName: string; fontRaw: string; fill: string; x: number; baseline: number }[] = []
  const hex = (g: BlockGlyph) => g.code.toString(16).toUpperCase().padStart(g.font.codeBytes * 2, '0')
  const linear = frame.linear.map(pdfNumber).join(' ')
  for (const line of lines) {
    const [e, f] = frame.toText(line.left, line.baseline).map(v => Number(pdfNumber(v)))
    content += `${linear} ${pdfNumber(e)} ${pdfNumber(f)} Tm\n`
    const baseline = frame.toPage(e, f)[1]
    let x = frame.toPage(e, f)[0], k = line.from
    while (k < line.to) {
      if (hidden(glyphs, k, line.to)) { k++; continue }
      const style = glyphs[k], segment: number[] = []
      for (; k < line.to; k++) {
        if (hidden(glyphs, k, line.to)) continue
        if (segment.length && (style.actual || !sameStyle(style, glyphs[k]))) break
        segment.push(k)
      }
      const next = `${style.fontRaw} ${pdfNumber(style.tf)} Tf\n${style.fill}\n${pdfNumber(style.tc)} Tc\n${pdfNumber(style.tw)} Tw\n`
      if (next !== state) content += next
      state = next
      let operand = '[', text = ''
      const at = x
      for (const j of segment) {
        const g = glyphs[j], kern = Number(pdfNumber(line.kerns[j - line.from]))
        if (kern) operand += `${pdfNumber(kern)} `
        operand += `<${hex(g)}>`
        text += g.actual ? g.char : g.char === SOFT_HYPHEN ? g.font.decode.get(g.code) ?? '-' : g.char
        x += -(kern * g.size) / 1000 + g.width
      }
      content += style.actual ? `/Span <</ActualText <${utf16(style.char)}>>> BDC ${operand}] TJ EMC\n` : `${operand}] TJ\n`
      expected.push({ text, fontName: style.font.name, fontRaw: style.fontRaw, fill: style.fill, x: at, baseline })
    }
  }
  return { content, expected }
}
