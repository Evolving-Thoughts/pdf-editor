/** Serializable paragraph models for the inline editor. The worker sends the
 * proved block (glyphs, metrics, outlines); the UI rebuilds light fonts and
 * runs the same layout code (`layoutEdit`) for a live preview. Only the
 * worker's preview of the real PDF authorizes a change. */
import { sourceFontCodec } from './encoding'
import type { BlockRect, SourceBlock } from './mixedBlocks'
import type { SourceFont } from './sourceFonts'
import type { BlockSpace, Box } from './space'

/** Per-block inputs of the shared free-space rules; `own` lists the page
 * rectangles (see `rects` of the analysis) that belong to the block itself. */
export type ModelSpace = Omit<BlockSpace, 'others'> & { own: number[] }

export interface EditFont {
  name: string
  codeBytes: 1 | 2
  bbox: number[]
  family?: string
  embedded: boolean
  defaultWidth?: number
  advances: [number, number][]
  boxes: [number, number[]][]
  insertable: [string, number, number][]
  /** SVG path per code, 1000 units per em, y up. */
  outlines: [number, string][]
}
export interface EditGlyph {
  c: string; code: number; f: number; fr: string; fill: string
  tf: number; tc: number; tw: number; s: number; size: number; w: number
  k: number; sk: number; o: number; ls: boolean; a?: boolean; v?: boolean
}
export interface EditModel {
  id: string
  /** Selection for the worker request (first member run). */
  runId: string
  expectedText: string
  text: string
  tagged: boolean
  justified: boolean
  right: number
  leading: number
  size: number
  lines: { from: number; to: number; left: number; baseline: number }[]
  glyphs: EditGlyph[]
  /** Additional free lines below the block (conservative estimate). */
  room: number
  /** Rightmost page x a line may reach. */
  limit: number
  /** Original line slots (page space) covered by the editor. */
  slots: BlockRect[]
  /** Original glyph indices under links/highlights; they must not move. */
  pinned: number[]
  space: ModelSpace
}
/** The shared free-space rules for a block from the page rectangles. */
export function modelSpace(model: EditModel, rects: readonly Box[]): BlockSpace {
  const own = new Set(model.space.own)
  const { limits, clip, whole, leading, bandBottom, bandTop } = model.space
  return { limits, clip, whole, leading, bandBottom, bandTop, others: rects.filter((_, i) => !own.has(i)) }
}

/** Free-space rules while other paragraphs of the page carry unchecked
 * drafts: their original rectangles (`removed`, indices into `rects`) give way
 * to the boxes of their edited lines (`extra`). The worker checks a batch the
 * same way, against the real result of the previous paragraphs. */
export function draftSpace(model: EditModel, rects: readonly Box[], removed: ReadonlySet<number>, extra: readonly Box[]): BlockSpace {
  const base = modelSpace(model, rects.map((r, i) => (removed.has(i) && !model.space.own.includes(i) ? undefined : r)) as Box[])
  return { ...base, others: [...base.others.filter(Boolean), ...extra] }
}

export function editModels(items: { block: SourceBlock; runId: string; expectedText: string; room: number; limit: number; slots: BlockRect[]; pinned: number[]; space: ModelSpace }[]) {
  const fonts: EditFont[] = [], ids = new Map<SourceFont, number>()
  const fontId = (font: SourceFont) => {
    let id = ids.get(font)
    if (id === undefined) {
      id = fonts.length
      ids.set(font, id)
      fonts.push({
        name: font.name, codeBytes: font.codeBytes, bbox: font.bbox, family: font.family, embedded: font.embedded !== false,
        defaultWidth: font.defaultWidth, advances: [], boxes: [], insertable: font.insertable ?? [], outlines: [],
      })
    }
    return id
  }
  const used = new Map<number, Set<number>>()
  const blocks: EditModel[] = items.map(({ block, runId, expectedText, room, limit, slots, pinned, space }) => ({
    id: block.id, runId, expectedText, text: block.text, tagged: block.tagged, justified: block.justified,
    right: block.right, leading: block.leading, size: block.size, room, limit, slots, pinned, space,
    lines: block.lines.map(l => ({ from: l.from, to: l.to, left: l.left, baseline: l.baseline })),
    glyphs: block.glyphs.map(g => {
      const f = fontId(g.font)
      used.set(f, (used.get(f) ?? new Set()).add(g.code))
      return { c: g.char, code: g.code, f, fr: g.fontRaw, fill: g.fill, tf: g.tf, tc: g.tc, tw: g.tw, s: g.scale, size: g.size, w: g.width, k: g.kern, sk: g.startKern, o: g.orig, ls: g.lineStart, a: g.actual || undefined, v: g.virtual || undefined }
    }),
  }))
  for (const [font, id] of ids) {
    const out = fonts[id], codes = new Set([...(used.get(id) ?? []), ...out.insertable.map(v => v[1])])
    let budget = 4096
    for (const code of codes) {
      const advance = font.advances?.get(code)
      if (advance !== undefined) out.advances.push([code, advance])
      const box = font.boxes?.get(code)
      if (box) out.boxes.push([code, box])
      const path = budget-- > 0 ? font.outline?.(code) : undefined
      if (path) out.outlines.push([code, path])
    }
  }
  return { blocks, fonts }
}

const noCodec: SourceFont['codec'] = { encode: () => ({ ok: false, error: 'missing-glyph' }) }
export interface LiveFont extends SourceFont { paths: Map<number, string> }
export function liveFont(f: EditFont): LiveFont {
  const codec = f.insertable.length
    ? sourceFontCodec(f.insertable.map(([character, code, advance]) => ({ character, code: code.toString(16).padStart(f.codeBytes * 2, '0'), advance })), f.codeBytes)
    : undefined
  return {
    name: f.name, codeBytes: f.codeBytes, bbox: f.bbox, family: f.family, embedded: f.embedded, defaultWidth: f.defaultWidth,
    codec: codec?.ok ? codec.value : noCodec,
    decode: new Map(f.insertable.map(([c, code]) => [code, c])),
    advances: new Map(f.advances), boxes: new Map(f.boxes), paths: new Map(f.outlines),
  }
}
export function liveBlock(model: EditModel, fonts: readonly LiveFont[]): SourceBlock {
  return {
    id: model.id, members: [], right: model.right, leading: model.leading, text: model.text, tagged: model.tagged, size: model.size, justified: model.justified,
    lines: model.lines.map(l => ({ ...l, runs: [] })),
    glyphs: model.glyphs.map(g => ({
      char: g.c, code: g.code, font: fonts[g.f], fontRaw: g.fr, fill: g.fill, tf: g.tf, tc: g.tc, tw: g.tw, scale: g.s, size: g.size,
      width: g.w, kern: g.k, startKern: g.sk, orig: g.o, lineStart: g.ls, actual: g.a, virtual: g.v,
    })),
  }
}
/** CSS colour of a PDF fill operator string (device colours; others → black). */
export function cssFill(fill: string) {
  const v = fill.trim().split(/\s+/), op = v.at(-1), nums = v.slice(0, -1).filter(t => /^[-+.\d]/.test(t)).map(Number)
  const c = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255)
  const n = op === 'g' || op === 'rg' || op === 'k' ? nums.slice(-({ g: 1, rg: 3, k: 4 } as const)[op]) : nums
  if ((op === 'g' || ((op === 'sc' || op === 'scn') && n.length === 1)) && n.length >= 1) return `rgb(${c(n[0])},${c(n[0])},${c(n[0])})`
  if ((op === 'rg' || op === 'sc' || op === 'scn') && n.length === 3) return `rgb(${c(n[0])},${c(n[1])},${c(n[2])})`
  if ((op === 'k' || op === 'sc' || op === 'scn') && n.length === 4) return `rgb(${c((1 - n[0]) * (1 - n[3]))},${c((1 - n[1]) * (1 - n[3]))},${c((1 - n[2]) * (1 - n[3]))})`
  return '#000'
}
