import type { OverlayFont } from '../core/model'

export const FONT_CSS: Record<OverlayFont, string> = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, monospace",
  'noto-sans': "'Noto Sans', sans-serif",
  'noto-serif': "'Noto Serif', serif",
  'carlito': "'Carlito', sans-serif",
  'lato': "'Lato', sans-serif",
  'eb-garamond': "'EB Garamond', serif",
  'roboto-mono': "'Roboto Mono', monospace",
  'caveat': "'Caveat', cursive",
  // Browsers have no ZapfDingbats; the box stores Unicode symbols anyway,
  // so the editor renders them with system fonts. Export maps to the font.
  zapfdingbats: 'system-ui, sans-serif',
}
