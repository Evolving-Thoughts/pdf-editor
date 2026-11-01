import type { SourceFontCodec } from './encoding'

export interface SourceRun {
  id: string
  pageIndex: number
  text: string
  fontName: string
  fontSize: number
  x: number
  baseline: number
  width: number
  selection?: { characters: { offset: number; width: number }[]; groupId?: string }
  paragraph?: { text: string; lineCount: number }
}
export interface SourceSelection { digest: string; runId: string; expectedText: string; scope?: 'line' | 'paragraph' }

export interface SourceFont {
  codec: SourceFontCodec; decode: Map<number, string>; codeBytes: 1 | 2; name: string; bbox: number[]; advances?: Map<number, number>; boxes?: Map<number, number[]>
  /** Width (1/1000 em) for codes without an explicit entry. */
  defaultWidth?: number
  /** Measurement-only font: text stays a protected obstacle, never editable. */
  locked?: string
  /** False when the viewer supplies the glyph program (standard/unembedded fonts). */
  embedded?: boolean
  /** CSS generic family hint for the inline editor when no outline exists. */
  family?: string
  /** SVG outline (1000 units per em, y up) of a code for the inline editor. */
  outline?: (code: number) => string | undefined
  /** Characters the codec can insert: [character, code, width (1/1000 em)]. */
  insertable?: [string, number, number][]
}
