import { PDFArray, PDFDict, PDFName, PDFNumber, PDFPage, PDFRawStream, StandardFontEmbedder, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { sourceFontCodec, supportedSourceText } from './encoding'
import type { SourceFontCodec } from './encoding'
import { streamBytes } from './streams'

export interface SourceFont { codec: SourceFontCodec; decode: Map<number, string>; codeBytes: 1 | 2; name: string; bbox: number[] }
const n = PDFName.of
function fail(): never { throw new Error('Diese Originalschrift oder ihre Zeichenkodierung ist nicht eindeutig unterstützt. Es wurde nichts verändert.') }
const alphabet = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join('') + 'ÄÖÜäöüßẞ–—‘’‚‛“”„…'
const standardNames: string[] = Object.values(StandardFonts).filter(value => value !== StandardFonts.Symbol && value !== StandardFonts.ZapfDingbats)

/** Intentionally small, fully consumed bfchar CMap grammar. No executable CMap,
 * usecmap, variable codespaces, ligature strings or inferred character codes. */
export function unicodeMap(text: string): Map<number, string> {
  text = text.replace(/%[^\r\n]*/g, '').replace(/\s+/g, ' ').trim()
  const map = new Map<number, string>(), characters = new Set<string>()
  const blocks = text.match(/\d+ beginbfchar .*? endbfchar/g) ?? []
  if (!blocks.length) fail()
  for (const block of blocks) {
    const count = Number(block.split(' ')[0])
    const pairs = [...block.matchAll(/<([\da-f]{4})>\s*<([\da-f]{4})>/gi)]
    const residual = block.replace(/^\d+ beginbfchar /, '').replace(/ endbfchar$/, '').replace(/<[\da-f]{4}>\s*<[\da-f]{4}>/gi, '').trim()
    if (residual || count !== pairs.length || count > 65536) fail()
    for (const pair of pairs) {
      const code = parseInt(pair[1], 16), character = String.fromCharCode(parseInt(pair[2], 16))
      if (!code || map.has(code) || characters.has(character)) fail()
      map.set(code, character); characters.add(character)
    }
  }
  const skeleton = text.replace(/\d+ beginbfchar .*? endbfchar/g, 'MAP')
  if (!/^\/CIDInit \/ProcSet findresource begin 12 dict begin begincmap \/CIDSystemInfo << \/Registry \(Adobe\) \/Ordering \(UCS\) \/Supplement 0 >> def \/CMapName \/[A-Za-z0-9_-]+ def \/CMapType 2 def 1 begincodespacerange <0000>\s*<ffff> endcodespacerange (?:MAP ?)+endcmap CMapName currentdict \/CMap defineresource pop end end$/i.test(skeleton)) fail()
  return map
}

export async function readSourceFont(page: PDFPage, key: string): Promise<SourceFont> {
  const font = page.node.Resources()?.lookupMaybe(n('Font'), PDFDict)?.lookup(n(key))
  if (!(font instanceof PDFDict) || font.lookup(n('Type'))?.toString() !== '/Font') fail()
  const base = font.lookup(n('BaseFont'))
  if (!(base instanceof PDFName)) fail()
  const name = base.decodeText()
  if (font.lookup(n('Subtype'))?.toString() === '/Type1') {
    if (font.keys().some(k => !['/Type', '/Subtype', '/BaseFont', '/Encoding'].includes(k.toString()))
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
  const mapping = unicodeMap(new TextDecoder().decode(await streamBytes(toUnicode, 256 * 1024)))
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
  const glyphs = [], decode = new Map<number, string>()
  for (const [code, character] of mapping) {
    if (!supportedSourceText(character)) continue
    const gid = gids ? (code * 2 + 1 < gids.length ? gids[code * 2] * 256 + gids[code * 2 + 1] : 0) : code
    if (!gid || gid >= program.numGlyphs) fail()
    const glyph = program.getGlyph(gid), advance = widths.get(code) ?? fallback
    // Materialize the outline, not just ToUnicode: the referenced glyph must
    // exist in the actual embedded TrueType subset. No invented CID/GID.
    const box = glyph.bbox
    const emptySpace = character === ' ' && glyph.path.toSVG().length === 0
    if (!Number.isFinite(advance) || advance < 0 || advance > 10000 || (!emptySpace && ![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite))) fail()
    glyphs.push({ character, code: code.toString(16).padStart(4, '0'), advance }); decode.set(code, character)
  }
  const codec = sourceFontCodec(glyphs, 2), box = program.bbox, scale = 1000 / program.unitsPerEm
  const bbox = [box.minX, box.minY, box.maxX, box.maxY].map(value => value * scale)
  if (!codec.ok || !bbox.every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) fail()
  return { codec: codec.value, decode, name, codeBytes: 2, bbox }
}
