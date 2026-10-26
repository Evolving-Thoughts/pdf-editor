import type { SourceFontCodec, SourceTextResult } from './encoding'
import { supportedSourceText } from './encoding'

export interface SourceParagraphRegion {
  /** PDF points, origin bottom-left; all measurements refer to source space. */
  left: number
  right: number
  firstBaseline: number
  /** Lowest allowed glyph edge, INCLUDING clearance to unrelated content.
   * The future PDF adapter must prove this whole rectangular region free of
   * other text, images, forms, overlays and clips. Never infer it from text alone.
   */
  bottomLimit: number
  fontSize: number
  leading: number
  /** Actual source-font extents in points (positive). */
  ascent: number
  descent: number
  originalLineCount: number
}
export interface SourceParagraphLine { text: string; hex: string; x: number; baseline: number; width: number }
export interface SourceParagraphPlan { lines: SourceParagraphLine[]; lineDelta: number; bottom: number }

/**
 * Pure planning only: does not recognize paragraphs or modify any PDF/state.
 * Caller must certify a uniform left-aligned paragraph, ordinary single spaces,
 * no intentional breaks/hyphenation and supported horizontal text state first.
 * Wraps whole words, never stretches/squeezes, hyphenates or moves neighbours.
 */
export function planSourceParagraph(text: string, codec: SourceFontCodec, region: SourceParagraphRegion): SourceTextResult<SourceParagraphPlan> {
  const { left, right, firstBaseline, bottomLimit, fontSize, leading, ascent, descent, originalLineCount } = region
  const widthLimit = right - left
  if (![widthLimit, firstBaseline - descent, left, right, firstBaseline, bottomLimit, fontSize, leading, ascent, descent].every(Number.isFinite)
    || right <= left || fontSize <= 0 || ascent <= 0 || descent < 0 || leading < ascent + descent
    || !Number.isInteger(originalLineCount) || originalLineCount < 1 || originalLineCount > 256
    || firstBaseline - descent < bottomLimit) return { ok: false, error: 'invalid-geometry' }
  // Do not silently normalize hard breaks, NBSP, indentation or special spacing.
  if (!supportedSourceText(text) || text.trim() !== text || text.includes('  ')) return { ok: false, error: 'unsupported-text' }
  const full = codec.encode(text)
  if (!full.ok) return full
  const lines: SourceParagraphLine[] = []
  const measure = (value: string) => {
    const encoded = codec.encode(value)
    if (!encoded.ok) return encoded
    const width = encoded.value.advance * fontSize / 1000
    if (!Number.isFinite(width) || width < 0) return { ok: false as const, error: 'invalid-font-map' as const }
    return { ok: true as const, value: { ...encoded.value, width } }
  }
  function append(value: string): SourceTextResult<null> {
    const encoded = measure(value)
    if (!encoded.ok) return encoded
    const baseline = firstBaseline - lines.length * leading
    if (!Number.isFinite(baseline) || lines.length >= 256 || baseline - descent < bottomLimit || encoded.value.width > widthLimit) return { ok: false, error: 'overflow' }
    lines.push({ text: value, hex: encoded.value.hex, x: left, baseline, width: encoded.value.width })
    return { ok: true, value: null }
  }
  let current = ''
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word
    const encoded = measure(candidate)
    if (!encoded.ok) return encoded
    if (encoded.value.width <= widthLimit) { current = candidate; continue }
    if (!current) return { ok: false, error: 'overflow' }
    const appended = append(current)
    if (!appended.ok) return appended
    current = word
  }
  const appended = append(current)
  if (!appended.ok) return appended
  return { ok: true, value: { lines, lineDelta: lines.length - originalLineCount, bottom: lines.at(-1)!.baseline - descent } }
}
