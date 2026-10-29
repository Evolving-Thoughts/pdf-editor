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
/** Precomposed Latin text only: ASCII, Latin-1 (incl. no-break space and soft
 * hyphen), Latin Extended-A and common typographic punctuation. Combining
 * marks, bidi controls, CJK and other shaping-sensitive scripts stay excluded. */
export const SOURCE_ALPHABET = /^[\x20-\x7e\u00a0-\u017f\u0192\u02c6\u02dc\u1e9e\u2010-\u2022\u2026\u2030\u2032\u2033\u2039\u203a\u20ac\u2122\u2212\ufb00-\ufb04]+$/u
export function supportedSourceText(text: string): boolean {
  return text.length > 0 && text.length <= MAX_TEXT && SOURCE_ALPHABET.test(text)
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
      || codes.has(code)) return { ok: false, error: 'invalid-font-map' }
    // Several glyphs may decode to one character; callers order the preferred one first.
    if (byCharacter.has(glyph.character)) continue
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
