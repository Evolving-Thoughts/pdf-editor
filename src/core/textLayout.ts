// Stored textbox y is the first text baseline, not the CSS input's top edge.
export const TEXT_LINE_HEIGHT = 1.2
export function textLineBaseline(fontSize: number, ascent: number, descent: number): number {
  return (fontSize * TEXT_LINE_HEIGHT - ascent - descent) / 2 + ascent
}
