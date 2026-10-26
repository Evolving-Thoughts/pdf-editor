/**
 * A codec for an already verified, horizontal source font. This is NOT a font
 * extractor: the PDF adapter must prove glyph availability, encoding, metrics,
 * and absence of shaping/ligatures before constructing it. ToUnicode alone is
 * not evidence that a glyph exists. No fallback font or UTF-8 substitution.
 */
export interface SourceGlyph { character: string; code: string; advance: number }
export type SourceTextError = 'invalid-font-map' | 'unsupported-text' | 'missing-glyph' | 'invalid-geometry' | 'overflow'
export type SourceTextResult<T> = { ok: true; value: T } | { ok: false; error: SourceTextError }
export interface SourceFontCodec {
  /** Hex PDF character codes (not Unicode), and width in 1/1000 font units. */
  encode(text: string): SourceTextResult<{ hex: string; advance: number }>
}

const MAX_TEXT = 4096
export function supportedSourceText(text: string): boolean {
  // Deliberately exclude combining marks, bidi controls, soft hyphens and other
  // shaping-sensitive characters in this initial DE/EN foundation.
  return text.length > 0 && text.length <= MAX_TEXT && /^[\x20-\x7e\u00c4\u00d6\u00dc\u00df\u00e4\u00f6\u00fc\u1e9e\u2013\u2014\u2018-\u201e\u2026]+$/u.test(text)
}

export function sourceFontCodec(glyphs: readonly SourceGlyph[], codeBytes: 1 | 2): SourceTextResult<SourceFontCodec> {
  if ((codeBytes !== 1 && codeBytes !== 2) || !glyphs.length || glyphs.length > 65536) return { ok: false, error: 'invalid-font-map' }
  const byCharacter = new Map<string, SourceGlyph>()
  const codes = new Set<string>()
  for (const glyph of glyphs) {
    const code = glyph.code.toUpperCase()
    if (Array.from(glyph.character).length !== 1 || !supportedSourceText(glyph.character)
      || code.length !== codeBytes * 2 || !/^[0-9A-F]+$/.test(code)
      || !Number.isFinite(glyph.advance) || glyph.advance < 0 || glyph.advance > 10000
      || byCharacter.has(glyph.character) || codes.has(code)) return { ok: false, error: 'invalid-font-map' }
    // Copy: callers cannot mutate the validated map after preview generation.
    byCharacter.set(glyph.character, { ...glyph, code })
    codes.add(code)
  }
  return { ok: true, value: { encode(text) {
    if (!supportedSourceText(text)) return { ok: false, error: 'unsupported-text' }
    let hex = '', advance = 0
    for (const character of text) {
      const glyph = byCharacter.get(character)
      if (!glyph) return { ok: false, error: 'missing-glyph' }
      hex += glyph.code
      advance += glyph.advance
    }
    return { ok: true, value: { hex, advance } }
  } } }
}
