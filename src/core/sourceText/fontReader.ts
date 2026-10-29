/** Page font reader for the mixed adapter. Every font that can be MEASURED is
 * returned; editing is offered only for codes whose glyph program, width and
 * Unicode meaning are proved. Fonts that cannot be proved are returned as
 * `locked` measurement-only fonts, so their text stays a protected obstacle
 * instead of rejecting the whole page. Only unmeasurable fonts (unknown code
 * lengths, vertical writing, missing dictionaries) throw. */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, StandardFontEmbedder, StandardFonts } from 'pdf-lib'
import type { PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { sourceFontCodec, supportedSourceText } from './encoding'
import type { SourceFontCodec, SourceGlyph } from './encoding'
import type { SourceFont } from './sourceFonts'
import { streamBytes } from './streams'
import { glyphNameUnicode, MAC_ROMAN_ENCODING, STANDARD_ENCODING, WIN_ANSI_ENCODING } from './fontTables'
import { parseType1, type1Outline } from './type1'

const n = PDFName.of
const MAX_FONT = 8 * 1024 * 1024
export class UnmeasurableFont extends Error {}
const unmeasurable = (reason: string): never => { throw new UnmeasurableFont(reason) }
const noCodec: SourceFontCodec = { encode: () => ({ ok: false, error: 'missing-glyph' }) }
const nameOf = (value: unknown) => (value instanceof PDFName ? value.decodeText() : undefined)
const num = (value: unknown) => (value instanceof PDFNumber && Number.isFinite(value.asNumber()) ? value.asNumber() : undefined)
const items = (value: PDFArray) => Array.from({ length: value.size() }, (_, i) => value.lookup(i))
const numbers = (value: unknown) => (value instanceof PDFArray ? items(value).map(num) : undefined)
const standardNames: string[] = Object.values(StandardFonts)
const baseName = (name: string) => name.replace(/^[A-Z]{6}\+/, '')

interface Program {
  unitsPerEm: number
  /** Glyph id for a character code, 0 when absent. */
  gid(code: number, name?: string, unicode?: string): number
  box(gid: number): number[] | undefined
  path(gid: number): string | undefined
  empty(gid: number): boolean
}

/** Lenient but bounded ToUnicode parser. Unusable entries (controls, U+0000,
 * lone surrogates) are skipped so that the code simply stays undecoded. */
export function lenientToUnicode(text: string, codeBytes: 1 | 2) {
  const map = new Map<number, string>()
  const utf16 = (hex: string) => {
    if (!hex.length || hex.length % 4 || hex.length > 32) return undefined
    const units = hex.match(/.{4}/g)!.map(h => parseInt(h, 16))
    const value = String.fromCharCode(...units)
    // eslint-disable-next-line no-control-regex -- control characters are rejected on purpose
    if (/[\u0000-\u001f\ufffd\ufeff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) return undefined
    return value
  }
  const code = (hex: string) => {
    const v = parseInt(hex, 16)
    return hex.length === codeBytes * 2 || (codeBytes === 1 && hex.length === 4 && v < 256) ? v : undefined
  }
  text = text.replace(/%[^\r\n]*/g, '')
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]*)>/gi)) {
      const c = code(m[1]), v = utf16(m[2])
      if (c !== undefined && v !== undefined && map.size < 65536) map.set(c, v)
    }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of block[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>\s*(?:<([\da-f]+)>|\[([^\]]*)\])/gi)) {
      const lo = code(m[1]), hi = code(m[2])
      if (lo === undefined || hi === undefined || hi < lo || hi - lo > 65535) continue
      const list = m[4] === undefined ? undefined : [...m[4].matchAll(/<([\da-f]*)>/gi)].map(v => v[1])
      for (let c = lo; c <= hi && map.size < 65536; c++) {
        let value: string | undefined
        if (list) value = list[c - lo] === undefined ? undefined : utf16(list[c - lo])
        else {
          const base = m[3]
          if (!base || base.length % 4) continue
          const last = parseInt(base.slice(-4), 16) + c - lo
          if (last > 0xffff) continue
          value = utf16(base.slice(0, -4) + last.toString(16).padStart(4, '0'))
        }
        if (value !== undefined) map.set(c, value)
      }
    }
  return map
}

/** Minimal OpenType container around a bare CFF table, so the bundled fontkit
 * CFF interpreter can resolve glyphs and outlines. Metrics come from the PDF. */
function wrapCff(cff: Uint8Array) {
  const head = new Uint8Array(54), maxp = new Uint8Array(6), hhea = new Uint8Array(36), hmtx = new Uint8Array(4)
  const dv = (b: Uint8Array) => new DataView(b.buffer)
  dv(head).setUint32(0, 0x10000); dv(head).setUint32(12, 0x5f0f3cf5); dv(head).setUint16(18, 1000)
  dv(maxp).setUint32(0, 0x5000); dv(maxp).setUint16(4, 1)
  dv(hhea).setUint32(0, 0x10000); dv(hhea).setUint16(34, 1)
  const tables: [string, Uint8Array][] = [['CFF ', cff], ['head', head], ['hhea', hhea], ['hmtx', hmtx], ['maxp', maxp]]
  let offset = 12 + 16 * tables.length
  const size = tables.reduce((s, [, b]) => s + ((b.length + 3) & ~3), offset)
  const out = new Uint8Array(size), view = new DataView(out.buffer)
  view.setUint32(0, 0x4f54544f); view.setUint16(4, tables.length); view.setUint16(6, 64); view.setUint16(8, 2); view.setUint16(10, 16)
  tables.forEach(([tag, bytes], i) => {
    for (let k = 0; k < 4; k++) out[12 + i * 16 + k] = tag.charCodeAt(k)
    view.setUint32(12 + i * 16 + 8, offset); view.setUint32(12 + i * 16 + 12, bytes.length)
    out.set(bytes, offset); offset += (bytes.length + 3) & ~3
  })
  return out
}
// fontkit exposes its parsed tables untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FontkitFont = ReturnType<typeof fontkit.create> & Record<string, any>
function fontkitProgram(font: FontkitFont, gidOf: Program['gid'], scaleUnits?: number): Program {
  const upm = scaleUnits ?? font.unitsPerEm
  if (!Number.isFinite(upm) || upm < 16 || upm > 16384) unmeasurable('Ungültige Schrifteinheiten.')
  const count = font['CFF '] ? font['CFF '].topDict.CharStrings.length : font.numGlyphs
  const glyph = (gid: number) => (gid > 0 && gid < count ? font.getGlyph(gid) : undefined)
  return {
    unitsPerEm: upm,
    gid: gidOf,
    box(gid) {
      try { const g = glyph(gid); const b = g?.path.bbox; return g && b && [b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) ? [b.minX, b.minY, b.maxX, b.maxY] : undefined } catch { return undefined }
    },
    path(gid) { try { return glyph(gid)?.path.toSVG() } catch { return undefined } },
    empty(gid) { try { const g = glyph(gid); return !g || !(g.path as unknown as { commands: unknown[] }).commands.length } catch { return true } },
  }
}
function cffGidByName(font: FontkitFont) {
  const cff = font['CFF ']
  const byName = new Map<string, number>()
  if (!cff || cff.isCIDFont) return byName
  for (let gid = 1; gid < Math.min(cff.topDict.CharStrings.length, 65536); gid++) {
    const name = cff.getGlyphName(gid)
    if (name && !byName.has(name)) byName.set(name, gid)
  }
  return byName
}
function cffCidToGid(font: FontkitFont) {
  const cff = font['CFF ']
  if (!cff?.isCIDFont) return undefined
  const charset = cff.topDict.charset, map = new Map<number, number>()
  if (Array.isArray(charset)) return undefined
  if (charset.version === 0) charset.glyphs.forEach((cid: number, i: number) => map.set(cid, i + 1))
  else for (let gid = 1, r = 0; r < charset.ranges.length; r++) {
    const range = charset.ranges[r]
    for (let k = 0; k <= range.nLeft && gid < 65536; k++) map.set(range.first + k, gid++)
  }
  return map
}
function cffBuiltinEncoding(font: FontkitFont) {
  const cff = font['CFF '], encoding = cff?.topDict.Encoding, codes = new Map<number, number>()
  if (!encoding || Array.isArray(encoding)) return { names: Array.isArray(encoding) ? (encoding as string[]) : undefined, codes }
  if (encoding.version === 0 || encoding.version === 128) (encoding.codes ?? []).forEach((code: number, i: number) => codes.set(code, i + 1))
  else if (encoding.version === 1 || encoding.version === 129) {
    let gid = 1
    for (const range of encoding.ranges ?? []) for (let k = 0; k <= range.nLeft; k++) codes.set(range.first + k, gid++)
  }
  return { names: undefined, codes }
}
/** Resolve a TrueType glyph through any of its cmap subtables (also symbol). */
function trueTypeLookup(font: FontkitFont) {
  const tables: FontkitFont[] = font.cmap?.tables ?? []
  const processor = font._cmapProcessor
  return (cp: number) => {
    for (const t of tables) {
      try { processor.cmap = t.table; const gid = processor.lookup(cp); if (gid) return gid } catch { /* next subtable */ }
    }
    return 0
  }
}

async function fontBytes(file: unknown) {
  if (!(file instanceof PDFRawStream)) return undefined
  return streamBytes(file, MAX_FONT)
}
function finish(input: {
  name: string; codeBytes: 1 | 2; decode: Map<number, string>; widths: Map<number, number>; defaultWidth: number
  bbox: number[]; program?: Program; gidOf?: (code: number) => number; embedded: boolean; locked?: string
  scale?: number; availableWithoutProgram?: (code: number) => boolean; family?: string
}): SourceFont {
  const { program } = input, scale = input.scale ?? (program ? 1000 / program.unitsPerEm : 1)
  const boxes = new Map<number, number[]>(), glyphs: SourceGlyph[] = [], advances = new Map(input.widths)
  const byChar = new Map<string, { code: number; width: number }[]>()
  let budget = 0
  for (const [code, text] of [...input.decode].sort((a, b) => a[0] - b[0])) {
    const width = input.widths.get(code) ?? input.defaultWidth
    if (!Number.isFinite(width) || width < 0 || width > 10000) continue
    advances.set(code, width)
    let proved = false
    if (program && input.gidOf) {
      const gid = input.gidOf(code)
      if (gid && ++budget < 20000) {
        const box = program.box(gid)
        const blank = /^[\s\u00a0]$/u.test(text)
        if (box) { boxes.set(code, box.map(v => v * scale)); proved = true }
        else if (blank && program.empty(gid)) { boxes.set(code, [0, 0, 0, 0]); proved = true }
      }
    } else if (input.availableWithoutProgram?.(code)) proved = true
    if (!proved || input.locked || Array.from(text).length !== 1 || !supportedSourceText(text)) continue
    byChar.set(text, [...(byChar.get(text) ?? []), { code, width }])
  }
  for (const [character, all] of byChar) {
    // Several glyphs for one character: insert only when they are metrically
    // interchangeable; unchanged text always keeps its original codes. Unused
    // encoding slots are commonly declared with width 0 and are ignored; a
    // character with only zero-width slots is not in the subset at all (Word
    // writes space-only subsets whose other slots are 0).
    const list = all.filter(v => v.width > 0)
    if (!list.length) continue
    if (list.some(v => Math.abs(v.width - list[0].width) > 1e-6)) continue
    glyphs.push({ character, code: list[0].code.toString(16).padStart(input.codeBytes * 2, '0'), advance: list[0].width })
  }
  const codec = glyphs.length ? sourceFontCodec(glyphs, input.codeBytes) : undefined
  const outlines = new Map<number, string | undefined>()
  return {
    codec: codec?.ok ? codec.value : noCodec,
    insertable: codec?.ok ? glyphs.map(g => [g.character, parseInt(g.code, 16), g.advance] as [string, number, number]) : [],
    decode: input.decode,
    codeBytes: input.codeBytes,
    name: input.name,
    bbox: input.bbox,
    advances,
    boxes,
    defaultWidth: input.defaultWidth,
    locked: input.locked,
    embedded: input.embedded,
    family: input.family,
    outline: program && input.gidOf ? (code: number) => {
      if (!outlines.has(code)) {
        const gid = input.gidOf!(code), raw = gid ? program.path(gid) : undefined
        outlines.set(code, raw === undefined ? undefined : scalePath(raw, scale))
      }
      return outlines.get(code)
    } : undefined,
  }
}
const scalePath = (path: string, scale: number) => scale === 1 ? path : path.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi, v => String(Math.round(Number(v) * scale * 100) / 100))
const familyHint = (name: string) => {
  const b = baseName(name).toLowerCase()
  if (/courier|mono|code|consol/.test(b)) return 'monospace'
  if (/times|roman|serif|garamond|georgia|minion|cambria|book|palatino/.test(b) && !/sans/.test(b)) return 'serif'
  return 'sans-serif'
}
function locked(name: string, codeBytes: 1 | 2, widths: Map<number, number>, defaultWidth: number, bbox: number[], reason: string, decode = new Map<number, string>()): SourceFont {
  return finish({ name, codeBytes, decode, widths, defaultWidth, bbox, embedded: false, locked: reason, family: familyHint(name) })
}
const bboxOf = (dict: PDFDict | undefined) => {
  const b = numbers(dict?.lookup(n('FontBBox')))
  return b && b.length === 4 && b.every(v => v !== undefined && Math.abs(v) <= 100000) ? (b as number[]) : [0, -250, 1000, 1000]
}

async function readType0(font: PDFDict, name: string): Promise<SourceFont> {
  const encoding = font.lookup(n('Encoding'))
  if (nameOf(encoding) === 'Identity-V') unmeasurable('Vertikal gesetzte Schriften werden nicht unterstützt.')
  if (nameOf(encoding) !== 'Identity-H') unmeasurable('Die CMap dieser Schrift hat keine eindeutig bestimmbaren Zeichencodes.')
  const descendants = font.lookup(n('DescendantFonts'))
  const cid = descendants instanceof PDFArray && descendants.size() === 1 ? descendants.lookup(0) : undefined
  if (!(cid instanceof PDFDict)) unmeasurable('Die Unterschrift einer CID-Schrift fehlt.')
  const widths = new Map<number, number>(), raw = (cid as PDFDict).lookup(n('W'))
  if (raw instanceof PDFArray) {
    for (let i = 0; i < raw.size();) {
      const first = num(raw.lookup(i++)), next = raw.lookup(i++)
      if (first === undefined || !Number.isInteger(first) || first < 0 || first > 65535) unmeasurable('Ungültige CID-Breiten.')
      if (next instanceof PDFArray) {
        items(next).forEach((w, j) => { const v = num(w); if (v !== undefined && first! + j <= 65535) widths.set(first! + j, v) })
      } else {
        const last = num(next), width = num(raw.lookup(i++))
        if (last === undefined || width === undefined || last < first! || last > 65535) unmeasurable('Ungültige CID-Breiten.')
        for (let c = first!; c <= last!; c++) widths.set(c, width!)
      }
    }
  } else if (raw) unmeasurable('Ungültige CID-Breiten.')
  const dw = num((cid as PDFDict).lookup(n('DW'))) ?? 1000
  const descriptor = (cid as PDFDict).lookup(n('FontDescriptor'))
  const fd = descriptor instanceof PDFDict ? descriptor : undefined
  const bbox = bboxOf(fd)
  const toUni = font.lookup(n('ToUnicode'))
  let decode = toUni instanceof PDFRawStream ? lenientToUnicode(new TextDecoder('latin1').decode(await streamBytes(toUni, 1024 * 1024)), 2) : new Map<number, string>()
  const subtype = nameOf((cid as PDFDict).lookup(n('Subtype')))
  try {
    let program: Program | undefined, gidOf: ((code: number) => number) | undefined
    const tt = await fontBytes(fd?.lookup(n('FontFile2'))), ff3 = fd?.lookup(n('FontFile3'))
    if (subtype === 'CIDFontType2' && tt) {
      const f = fontkit.create(tt) as FontkitFont
      const map = (cid as PDFDict).lookup(n('CIDToGIDMap'))
      let gids: Uint8Array | undefined
      if (map instanceof PDFRawStream) gids = await streamBytes(map, 131072)
      else if (map && nameOf(map) !== 'Identity') throw new Error('CIDToGIDMap')
      gidOf = code => gids ? (code * 2 + 1 < gids.length ? gids[code * 2] * 256 + gids[code * 2 + 1] : 0) : code
      program = fontkitProgram(f, gidOf)
      if (!decode.size) {
        // No ToUnicode: derive meaning from the program's own Unicode cmap.
        const reverse = new Map<number, string>()
        for (const cp of f.characterSet ?? []) { const g = f.glyphForCodePoint(cp); if (g?.id && !reverse.has(g.id)) reverse.set(g.id, String.fromCodePoint(cp)) }
        const codes = gids ? Array.from({ length: gids.length / 2 }, (_, c) => c) : [...reverse.keys()]
        decode = new Map(codes.flatMap(c => { const v = reverse.get(gidOf!(c)); return v ? [[c, v] as [number, string]] : [] }))
      }
    } else if (subtype === 'CIDFontType0' && ff3 instanceof PDFRawStream) {
      const kind = nameOf(ff3.dict.lookup(n('Subtype')))
      const bytes = (await fontBytes(ff3))!
      const f = fontkit.create(kind === 'OpenType' ? bytes : wrapCff(bytes)) as FontkitFont
      const cids = cffCidToGid(f)
      gidOf = code => (cids ? cids.get(code) ?? 0 : code)
      const matrix = f['CFF ']?.topDict.FontMatrix
      program = fontkitProgram(f, gidOf, matrix && matrix[0] ? 1 / matrix[0] : undefined)
    }
    if (!program) return locked(name, 2, widths, dw, bbox, 'Die Schrift ist nicht eingebettet oder ihr Format wird nicht unterstützt.', decode)
    return finish({ name, codeBytes: 2, decode, widths, defaultWidth: dw, bbox, program, gidOf, embedded: true, family: familyHint(name) })
  } catch (error) {
    if (error instanceof UnmeasurableFont) throw error
    return locked(name, 2, widths, dw, bbox, 'Das eingebettete Schriftprogramm ist nicht lesbar.', decode)
  }
}

async function readSimple(font: PDFDict, subtype: string, name: string): Promise<SourceFont> {
  const descriptor = font.lookup(n('FontDescriptor')), fd = descriptor instanceof PDFDict ? descriptor : undefined
  const first = num(font.lookup(n('FirstChar'))), widthList = numbers(font.lookup(n('Widths')))
  const missing = num(fd?.lookup(n('MissingWidth'))) ?? 0
  const standard = !fd?.has(n('FontFile')) && !fd?.has(n('FontFile2')) && !fd?.has(n('FontFile3')) && standardNames.includes(baseName(name)) ? baseName(name) : undefined
  const embedder = standard ? StandardFontEmbedder.for(standard as Parameters<typeof StandardFontEmbedder.for>[0]) : undefined
  let matrixScale = 1, bbox = embedder ? [...embedder.font.FontBBox] : bboxOf(fd)
  if (subtype === 'Type3') {
    const m = numbers(font.lookup(n('FontMatrix')))
    if (!m || m.length !== 6 || m.some(v => v === undefined) || m[1] || m[2] || !m[0] || !m[3]) unmeasurable('Die Matrix einer Type3-Schrift wird nicht unterstützt.')
    matrixScale = m![0]! * 1000
    const b = numbers(font.lookup(n('FontBBox')))
    if (b && b.length === 4 && b.every(v => v !== undefined)) bbox = [b[0]! * matrixScale, b[1]! * m![3]! * 1000, b[2]! * matrixScale, b[3]! * m![3]! * 1000].map(v => Math.max(-100000, Math.min(100000, v)))
  }
  // Code -> glyph name from the PDF encoding.
  const encoding = font.lookup(n('Encoding'))
  const symbolic = fd ? ((num(fd.lookup(n('Flags'))) ?? 0) & 4) !== 0 : false
  const encName = nameOf(encoding) ?? nameOf(encoding instanceof PDFDict ? encoding.lookup(n('BaseEncoding')) : undefined)
  const tableFor = (e?: string) => e === 'WinAnsiEncoding' ? WIN_ANSI_ENCODING : e === 'MacRomanEncoding' ? MAC_ROMAN_ENCODING : e === 'StandardEncoding' ? STANDARD_ENCODING : undefined
  let base = tableFor(encName)
  const builtin = !base
  if (!base && standard && !['Symbol', 'ZapfDingbats'].includes(standard)) base = STANDARD_ENCODING
  const names: (string | undefined)[] = Array.from({ length: 256 }, (_, c) => base?.[c])
  if (encoding instanceof PDFDict) {
    const diff = encoding.lookup(n('Differences'))
    if (diff instanceof PDFArray) {
      let code = 0
      for (const item of items(diff)) {
        if (item instanceof PDFNumber) code = item.asNumber()
        else if (item instanceof PDFName && code >= 0 && code < 256) names[code++] = item.decodeText()
      }
    }
  }
  const widths = new Map<number, number>()
  if (first !== undefined && widthList) widthList.forEach((w, i) => { if (w !== undefined && first + i >= 0 && first + i < 256) widths.set(first + i, w * matrixScale) })
  else if (embedder) for (let c = 0; c < 256; c++) { const g = names[c]; const w = g ? embedder.font.getWidthOfGlyph(g) : undefined; if (w !== undefined) widths.set(c, w) }
  else if (subtype !== 'Type1' || !standard) unmeasurable('Die Zeichenbreiten der Schrift fehlen.')
  const toUni = font.lookup(n('ToUnicode'))
  const fromCMap = toUni instanceof PDFRawStream ? lenientToUnicode(new TextDecoder('latin1').decode(await streamBytes(toUni, 1024 * 1024)), 1) : new Map<number, string>()
  const decode = new Map<number, string>()
  const fill = (glyphName: (c: number) => string | undefined) => {
    decode.clear()
    for (let c = 0; c < 256; c++) {
      const v = fromCMap.get(c) ?? (glyphName(c) ? glyphNameUnicode(glyphName(c)!) : undefined)
      if (v !== undefined) decode.set(c, v.normalize('NFKC') === v ? v : /^[\ufb00-\ufb04]$/.test(v) ? v.normalize('NFKC') : v)
    }
  }
  fill(c => names[c])
  const family = familyHint(name)
  if (subtype === 'Type3') return locked(name, 1, widths, missing, bbox, 'Type3-Schriften bestehen aus Zeichenprozeduren und werden nicht bearbeitet.', decode)
  try {
    const t1 = fd?.lookup(n('FontFile')), tt = fd?.lookup(n('FontFile2')), ff3 = fd?.lookup(n('FontFile3'))
    if (t1 instanceof PDFRawStream) {
      const bytes = (await fontBytes(t1))!
      const l1 = num(t1.dict.lookup(n('Length1'))) ?? 0, l2 = num(t1.dict.lookup(n('Length2'))) ?? 0
      const program = parseType1(bytes, l1, l2)
      if (!program) return locked(name, 1, widths, missing, bbox, 'Das eingebettete Type1-Programm ist nicht lesbar.', decode)
      if (builtin && program.encoding) { for (const [c, g] of program.encoding) if (names[c] === undefined) names[c] = g; fill(c => names[c]) }
      else if (builtin) { for (let c = 0; c < 256; c++) names[c] ??= STANDARD_ENCODING[c]; fill(c => names[c]) }
      const upm = 1 / (program.matrix[0] || 0.001)
      const ids = new Map([...program.glyphs.keys()].map((g, i) => [g, i + 1]))
      const byId = [...program.glyphs.keys()]
      const p: Program = {
        unitsPerEm: upm,
        gid: c => (names[c] && names[c] !== '.notdef' ? ids.get(names[c]!) ?? 0 : 0),
        box: gid => type1Outline(program, byId[gid - 1])?.box,
        path: gid => type1Outline(program, byId[gid - 1])?.path,
        empty: gid => !type1Outline(program, byId[gid - 1])?.path,
      }
      if (!(upm >= 16 && upm <= 16384)) unmeasurable('Ungültige Schriftmatrix.')
      return finish({ name, codeBytes: 1, decode, widths, defaultWidth: missing, bbox, program: p, gidOf: c => p.gid(c), embedded: true, family })
    }
    if (ff3 instanceof PDFRawStream || tt instanceof PDFRawStream) {
      const cff = ff3 instanceof PDFRawStream, kind = cff ? nameOf(ff3.dict.lookup(n('Subtype'))) : 'TrueType'
      const bytes = (await fontBytes(cff ? ff3 : tt))!
      const f = fontkit.create(kind === 'Type1C' ? wrapCff(bytes) : bytes) as FontkitFont
      let gidOf: (code: number) => number
      if (f['CFF ']) {
        const byName = cffGidByName(f), own = cffBuiltinEncoding(f)
        if (builtin) { for (let c = 0; c < 256; c++) if (names[c] === undefined) { const g = own.names?.[c] ?? (own.codes.get(c) ? f['CFF '].getGlyphName(own.codes.get(c)) : undefined); if (g) names[c] = g } fill(c => names[c]) }
        gidOf = c => (names[c] ? byName.get(names[c]!) ?? 0 : builtin ? own.codes.get(c) ?? 0 : 0)
        const matrix = f['CFF '].topDict.FontMatrix
        const program = fontkitProgram(f, gidOf, matrix && matrix[0] ? 1 / matrix[0] : undefined)
        return finish({ name, codeBytes: 1, decode, widths, defaultWidth: missing, bbox, program, gidOf, embedded: true, family })
      }
      const lookup = trueTypeLookup(f)
      // Symbolic subsets address glyphs by code (3,0 / 1,0); others by Unicode.
      gidOf = c => {
        const text = decode.get(c)
        const viaUnicode = !symbolic && text && Array.from(text).length === 1 ? lookup(text.codePointAt(0)!) : 0
        return viaUnicode || lookup(0xf000 + c) || lookup(c)
      }
      if (symbolic && !fromCMap.size && builtin) {
        // Symbolic without encoding or ToUnicode: the glyph's own Unicode mapping
        // (when the program also has one) is the only meaning that can be proved.
        const reverse = new Map<number, string>()
        for (const cp of f.characterSet ?? []) { const g = f.glyphForCodePoint(cp); if (g?.id && !reverse.has(g.id) && cp < 0xf000) reverse.set(g.id, String.fromCodePoint(cp)) }
        decode.clear()
        for (let c = 0; c < 256; c++) { const v = reverse.get(lookup(0xf000 + c) || lookup(c)); if (v) decode.set(c, v) }
      }
      const program = fontkitProgram(f, gidOf)
      return finish({ name, codeBytes: 1, decode, widths, defaultWidth: missing, bbox, program, gidOf, embedded: true, family })
    }
    if (embedder) {
      // Standard 14 font: viewer-provided, metrics from the AFM, names prove glyphs.
      return finish({ name, codeBytes: 1, decode, widths, defaultWidth: missing, bbox, embedded: false, family: /Times/.test(standard!) ? 'serif' : /Courier/.test(standard!) ? 'monospace' : 'sans-serif', availableWithoutProgram: c => !!names[c] && embedder.font.getWidthOfGlyph(names[c]!) !== undefined && widths.has(c) })
    }
    // Non-embedded, non-standard font: the viewer substitutes it; the PDF widths
    // still position every glyph, so declared widths are the proof.
    return finish({ name, codeBytes: 1, decode, widths, defaultWidth: missing, bbox, embedded: false, family, availableWithoutProgram: c => widths.has(c) && !symbolic })
  } catch (error) {
    if (error instanceof UnmeasurableFont) throw error
    return locked(name, 1, widths, missing, bbox, 'Das eingebettete Schriftprogramm ist nicht lesbar.', decode)
  }
}

export async function readPageFont(page: PDFPage, key: string): Promise<SourceFont> {
  const font = page.node.Resources()?.lookupMaybe(n('Font'), PDFDict)?.lookup(n(key))
  if (!(font instanceof PDFDict)) unmeasurable('Die Schriftressource fehlt.')
  const dict = font as PDFDict
  const name = nameOf(dict.lookup(n('BaseFont'))) ?? nameOf(dict.lookup(n('Name'))) ?? key
  const subtype = nameOf(dict.lookup(n('Subtype')))
  if (subtype === 'Type0') return readType0(dict, name)
  if (subtype === 'Type1' || subtype === 'MMType1' || subtype === 'TrueType' || subtype === 'Type3') return readSimple(dict, subtype, name)
  return unmeasurable('Unbekannter Schrifttyp.')
}
