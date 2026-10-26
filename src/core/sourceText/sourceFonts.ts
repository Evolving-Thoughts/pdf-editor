import { PDFArray, PDFDict, PDFName, PDFNumber, PDFPage, PDFRawStream, StandardFontEmbedder, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { sourceFontCodec, supportedSourceText } from './encoding'
import type { SourceFontCodec } from './encoding'
import { streamBytes } from './streams'

export interface SourceFont { codec: SourceFontCodec; decode: Map<number, string>; codeBytes: 1 | 2; name: string; bbox: number[]; advances?: Map<number, number>; boxes?: Map<number, number[]> }
const n = PDFName.of
function fail(): never { throw new Error('Diese Originalschrift oder ihre Zeichenkodierung ist nicht eindeutig unterstützt. Es wurde nichts verändert.') }
const alphabet = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join('') + 'ÄÖÜäöüßẞ–—‘’‚‛“”„…'
const standardNames: string[] = Object.values(StandardFonts).filter(value => value !== StandardFonts.Symbol && value !== StandardFonts.ZapfDingbats)

/** Intentionally small, fully consumed bfchar CMap grammar. No executable CMap,
 * usecmap, variable codespaces, ligature strings or inferred character codes. */
export function unicodeMap(text: string, extended = false): Map<number, string> {
  text = text.replace(/%[^\r\n]*/g, '').replace(/\s+/g, ' ').trim()
  const map = new Map<number, string>(), characters = new Set<string>()
  const add = (code: number, hex: string) => {
    if (hex.length % 4 || !hex.length || hex.length > 32 || !code || code > 65535 || map.has(code)) fail()
    const character = String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map(value => parseInt(value, 16)))
    if ((!extended && character.length !== 1) || characters.has(character)) fail()
    map.set(code, character); characters.add(character)
  }
  const blocks = text.match(/\d+ beginbf(?:char|range) .*? endbf(?:char|range)/g) ?? []
  if (!blocks.length) fail()
  for (const block of blocks) {
    const count = Number(block.split(' ')[0]); let seen = 0
    if (count > 65536) fail()
    let body = block.replace(/^\d+ beginbf(?:char|range) /, '').replace(/ endbf(?:char|range)$/, '')
    if (block.includes('beginbfchar')) {
      body = body.replace(/<([\da-f]{4})>\s*<([\da-f]+)>/gi, (_, code, hex) => { add(parseInt(code, 16), hex); seen++; return '' })
    } else {
      if (!extended) fail()
      body = body.replace(/<([\da-f]{4})>\s*<([\da-f]{4})>\s*(<([\da-f]{4})>|\[([^\]]*)\])/gi, (_, lo, hi, _dest, base, list) => {
        const start = parseInt(lo, 16), end = parseInt(hi, 16)
        if (end < start || end - start > 65535) fail()
        const values = list === undefined ? null : [...list.matchAll(/<([\da-f]+)>/gi)].map((v: RegExpMatchArray) => v[1])
        if (values && (values.length !== end - start + 1 || list.replace(/<[\da-f]+>/gi, '').trim())) fail()
        for (let code = start; code <= end; code++) {
          const value = parseInt(base ?? '0', 16) + code - start
          if (!values && value > 65535) fail()
          add(code, values ? values[code - start] : value.toString(16).padStart(4, '0'))
        }
        seen++; return ''
      })
    }
    if (body.trim() || seen !== count) fail()
  }
  const skeleton = text.replace(/\d+ beginbf(?:char|range) .*? endbf(?:char|range)/g, 'MAP')
  if (!/^\/CIDInit \/ProcSet findresource begin \d+ dict begin begincmap \/CIDSystemInfo << \/Registry \(Adobe\) \/Ordering \(UCS\) \/Supplement 0 >> def \/CMapName \/[A-Za-z0-9_-]+ def \/CMapType 2 def 1 begincodespacerange <0000>\s*<ffff> endcodespacerange (?:MAP ?)+endcmap CMapName currentdict \/CMap defineresource pop end end$/i.test(skeleton)) fail()
  return map
}

export async function readSourceFont(page: PDFPage, key: string, extended = false): Promise<SourceFont> {
  const font = page.node.Resources()?.lookupMaybe(n('Font'), PDFDict)?.lookup(n(key))
  if (!(font instanceof PDFDict) || font.lookup(n('Type'))?.toString() !== '/Font') fail()
  const base = font.lookup(n('BaseFont'))
  if (!(base instanceof PDFName)) fail()
  const name = base.decodeText()
  if (font.lookup(n('Subtype'))?.toString() === '/Type1') {
    if (font.keys().some(k => ![...['/Type', '/Subtype', '/BaseFont', '/Encoding'], ...(extended ? ['/Name'] : [])].includes(k.toString()))
      || font.lookup(n('Encoding'))?.toString() !== '/WinAnsiEncoding' || !standardNames.includes(name)) fail()
    const embedder = StandardFontEmbedder.for(name as Parameters<typeof StandardFontEmbedder.for>[0])
    const glyphs = [], decode = new Map<number, string>()
    for (const character of alphabet) {
      try { const code = embedder.encodeText(character).asString(); glyphs.push({ character, code, advance: embedder.widthOfTextAtSize(character, 1000) }); decode.set(parseInt(code, 16), character) }
      catch { /* Missing WinAnsi glyph: no fallback. */ }
    }
    const codec = sourceFontCodec(glyphs, 1)
    if (!codec.ok) fail()
    return { codec: codec.value, decode, name, codeBytes: 1, bbox: [...embedder.font.FontBBox] }
  }
  if (extended && font.lookup(n('Subtype'))?.toString() === '/TrueType') return readSimpleTrueType(font, name)
  if (font.lookup(n('Subtype'))?.toString() !== '/Type0' || font.lookup(n('Encoding'))?.toString() !== '/Identity-H') fail()
  const descendants = font.lookup(n('DescendantFonts'))
  if (!(descendants instanceof PDFArray) || descendants.size() !== 1) fail()
  const cid = descendants.lookup(0)
  if (!(cid instanceof PDFDict) || cid.lookup(n('Subtype'))?.toString() !== '/CIDFontType2') fail()
  const descriptor = cid.lookup(n('FontDescriptor')), toUnicode = font.lookup(n('ToUnicode'))
  if (!(descriptor instanceof PDFDict) || !(toUnicode instanceof PDFRawStream) || (descriptor.has(n('FontFile3')) || descriptor.has(n('FontFile')))) fail()
  const file = descriptor.lookup(n('FontFile2'))
  if (!(file instanceof PDFRawStream)) fail()
  const fontBytes = await streamBytes(file, 4 * 1024 * 1024)
  const signature = Array.from(fontBytes.subarray(0, 4)).join(',')
  if (signature !== '0,1,0,0' && signature !== '116,114,117,101') fail()
  const program = fontkit.create(fontBytes)
  if (!Number.isFinite(program.unitsPerEm) || program.unitsPerEm < 16 || program.unitsPerEm > 16384 || program.numGlyphs > 65536) fail()
  const mapping = unicodeMap(new TextDecoder().decode(await streamBytes(toUnicode, 256 * 1024)), extended)
  const gidMap = cid.lookup(n('CIDToGIDMap'))
  let gids: Uint8Array | undefined
  if (gidMap instanceof PDFRawStream) { gids = await streamBytes(gidMap, 131072); if (gids.length % 2) fail() }
  else if (!(gidMap instanceof PDFName) || gidMap.decodeText() !== 'Identity') fail()
  const widths = new Map<number, number>(), rawWidths = cid.lookup(n('W'))
  if (!(rawWidths instanceof PDFArray)) fail()
  for (let i = 0; i < rawWidths.size();) {
    const first = rawWidths.lookup(i++), next = rawWidths.lookup(i++)
    if (!(first instanceof PDFNumber) || !Number.isInteger(first.asNumber()) || first.asNumber() < 0 || first.asNumber() > 65535) fail()
    const start = first.asNumber()
    if (next instanceof PDFArray) {
      if (start + next.size() > 65536) fail()
      for (let j = 0; j < next.size(); j++) { const width = next.lookup(j); if (!(width instanceof PDFNumber) || widths.has(start + j)) fail(); widths.set(start + j, width.asNumber()) }
    } else {
      const width = rawWidths.lookup(i++)
      if (!(next instanceof PDFNumber) || !(width instanceof PDFNumber) || !Number.isInteger(next.asNumber()) || next.asNumber() < start || next.asNumber() > 65535) fail()
      for (let code = start; code <= next.asNumber(); code++) { if (widths.has(code)) fail(); widths.set(code, width.asNumber()) }
    }
  }
  const fallback = cid.lookupMaybe(n('DW'), PDFNumber)?.asNumber() ?? 1000
  const glyphs = [], decode = new Map<number, string>(), advances = new Map<number, number>(), boxes = new Map<number, number[]>()
  for (const [code, character] of mapping) {
    if (!extended && !supportedSourceText(character)) continue
    const gid = gids ? (code * 2 + 1 < gids.length ? gids[code * 2] * 256 + gids[code * 2 + 1] : 0) : code
    if (!gid || gid >= program.numGlyphs) fail()
    const glyph = program.getGlyph(gid), advance = widths.get(code) ?? fallback
    // Materialize the outline, not just ToUnicode: the referenced glyph must
    // exist in the actual embedded TrueType subset. No invented CID/GID.
    const box = glyph.bbox
    const emptySpace = character === ' ' && glyph.path.toSVG().length === 0
    if (!Number.isFinite(advance) || advance < 0 || advance > 10000 || (!emptySpace && ![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite))) fail()
    if (character.length === 1 && supportedSourceText(character)) glyphs.push({ character, code: code.toString(16).padStart(4, '0'), advance })
    decode.set(code, character); advances.set(code, advance); boxes.set(code, emptySpace ? [0, 0, 0, 0] : [box.minX, box.minY, box.maxX, box.maxY].map(v => v * 1000 / program.unitsPerEm))
  }
  const codec = sourceFontCodec(glyphs, 2), box = program.bbox, scale = 1000 / program.unitsPerEm
  const bbox = [box.minX, box.minY, box.maxX, box.maxY].map(value => value * scale)
  if (!codec.ok || !bbox.every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) fail()
  return { codec: codec.value, decode, name, codeBytes: 2, bbox, advances, boxes }
}

/** Embedded one-byte TrueType/WinAnsi fonts, including Word's space-only subsets.
 * The Unicode cmap of the actual program must prove the glyph; no OS font lookup. */
async function readSimpleTrueType(font: PDFDict, name: string): Promise<SourceFont> {
  if (font.lookup(n('Encoding'))?.toString() !== '/WinAnsiEncoding' || font.has(n('ToUnicode'))) fail()
  const descriptor = font.lookup(n('FontDescriptor'))
  if (!(descriptor instanceof PDFDict) || descriptor.has(n('FontFile3')) || descriptor.has(n('FontFile'))) fail()
  const file = descriptor.lookup(n('FontFile2')), first = font.lookup(n('FirstChar')), last = font.lookup(n('LastChar')), widths = font.lookup(n('Widths'))
  if (!(first instanceof PDFNumber) || !(last instanceof PDFNumber) || !(widths instanceof PDFArray)) fail()
  const lo = first.asNumber(), hi = last.asNumber()
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi > 255 || hi < lo || widths.size() !== hi - lo + 1) fail()
  if (!(file instanceof PDFRawStream)) {
    // A declared, non-painted space needs no glyph program. Never offer it as
    // an editable run or infer any other unembedded character.
    if (lo !== 32 || hi !== 32 || descriptor.has(n('FontFile2'))) fail()
    const width = widths.lookup(0)
    if (!(width instanceof PDFNumber) || width.asNumber() < 0 || width.asNumber() > 10000) fail()
    const codec = sourceFontCodec([{ character: ' ', code: '20', advance: width.asNumber() }], 1)
    if (!codec.ok) fail()
    return { codec: codec.value, decode: new Map([[32, ' ']]), name, codeBytes: 1, bbox: [0,0,0,0], advances: new Map([[32,width.asNumber()]]), boxes: new Map([[32,[0,0,0,0]]]) }
  }
  const bytes = await streamBytes(file, 4 * 1024 * 1024)
  if (!['0,1,0,0', '116,114,117,101'].includes(Array.from(bytes.subarray(0, 4)).join(','))) fail()
  const program = fontkit.create(bytes), scale = 1000 / program.unitsPerEm
  if (!Number.isFinite(scale) || program.unitsPerEm < 16 || program.unitsPerEm > 16384 || program.numGlyphs > 65536) fail()
  const decoder = new TextDecoder('windows-1252'), glyphs = [], decode = new Map<number, string>(), advances = new Map<number, number>(), boxes = new Map<number, number[]>()
  for (let code = lo; code <= hi; code++) {
    const character = decoder.decode(Uint8Array.of(code)), width = widths.lookup(code - lo)
    if (!(width instanceof PDFNumber) || !supportedSourceText(character)) continue
    const glyph = program.glyphForCodePoint(character.codePointAt(0)!)
    if (!glyph.id) continue
    const advance = width.asNumber(), box = glyph.bbox, empty = character === ' ' && !glyph.path.toSVG().length
    if (!Number.isFinite(advance) || advance < 0 || advance > 10000 || (!empty && ![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite))) fail()
    glyphs.push({ character, code: code.toString(16).padStart(2, '0'), advance }); decode.set(code, character); advances.set(code, advance)
    boxes.set(code, empty ? [0,0,0,0] : [box.minX, box.minY, box.maxX, box.maxY].map(v => v * scale))
  }
  const codec = sourceFontCodec(glyphs, 1), box = program.bbox, bbox = [box.minX, box.minY, box.maxX, box.maxY].map(v => v * scale)
  if (!codec.ok || !bbox.every(v => Number.isFinite(v) && Math.abs(v) <= 10000)) fail()
  return { codec: codec.value, decode, name, codeBytes: 1, bbox, advances, boxes }
}
