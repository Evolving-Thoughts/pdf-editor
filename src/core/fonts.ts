import type { OverlayFont, Textbox } from './model'
import noto_sans_plain from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url'
import noto_sans_bold from '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff?url'
import noto_sans_italic from '@fontsource/noto-sans/files/noto-sans-latin-400-italic.woff?url'
import noto_sans_boldItalic from '@fontsource/noto-sans/files/noto-sans-latin-700-italic.woff?url'
import noto_serif_plain from '@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff?url'
import noto_serif_bold from '@fontsource/noto-serif/files/noto-serif-latin-700-normal.woff?url'
import noto_serif_italic from '@fontsource/noto-serif/files/noto-serif-latin-400-italic.woff?url'
import noto_serif_boldItalic from '@fontsource/noto-serif/files/noto-serif-latin-700-italic.woff?url'
import carlito_plain from '@fontsource/carlito/files/carlito-latin-400-normal.woff?url'
import carlito_bold from '@fontsource/carlito/files/carlito-latin-700-normal.woff?url'
import carlito_italic from '@fontsource/carlito/files/carlito-latin-400-italic.woff?url'
import carlito_boldItalic from '@fontsource/carlito/files/carlito-latin-700-italic.woff?url'
import lato_plain from '@fontsource/lato/files/lato-latin-400-normal.woff?url'
import lato_bold from '@fontsource/lato/files/lato-latin-700-normal.woff?url'
import lato_italic from '@fontsource/lato/files/lato-latin-400-italic.woff?url'
import lato_boldItalic from '@fontsource/lato/files/lato-latin-700-italic.woff?url'
import eb_garamond_plain from '@fontsource/eb-garamond/files/eb-garamond-latin-400-normal.woff?url'
import eb_garamond_bold from '@fontsource/eb-garamond/files/eb-garamond-latin-700-normal.woff?url'
import eb_garamond_italic from '@fontsource/eb-garamond/files/eb-garamond-latin-400-italic.woff?url'
import eb_garamond_boldItalic from '@fontsource/eb-garamond/files/eb-garamond-latin-700-italic.woff?url'
import roboto_mono_plain from '@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff?url'
import roboto_mono_bold from '@fontsource/roboto-mono/files/roboto-mono-latin-700-normal.woff?url'
import roboto_mono_italic from '@fontsource/roboto-mono/files/roboto-mono-latin-400-italic.woff?url'
import roboto_mono_boldItalic from '@fontsource/roboto-mono/files/roboto-mono-latin-700-italic.woff?url'
import caveat_plain from '@fontsource/caveat/files/caveat-latin-400-normal.woff?url'
import caveat_bold from '@fontsource/caveat/files/caveat-latin-700-normal.woff?url'

const assets = {
  'noto-sans': { plain: noto_sans_plain, bold: noto_sans_bold, italic: noto_sans_italic, boldItalic: noto_sans_boldItalic },
  'noto-serif': { plain: noto_serif_plain, bold: noto_serif_bold, italic: noto_serif_italic, boldItalic: noto_serif_boldItalic },
  'carlito': { plain: carlito_plain, bold: carlito_bold, italic: carlito_italic, boldItalic: carlito_boldItalic },
  'lato': { plain: lato_plain, bold: lato_bold, italic: lato_italic, boldItalic: lato_boldItalic },
  'eb-garamond': { plain: eb_garamond_plain, bold: eb_garamond_bold, italic: eb_garamond_italic, boldItalic: eb_garamond_boldItalic },
  'roboto-mono': { plain: roboto_mono_plain, bold: roboto_mono_bold, italic: roboto_mono_italic, boldItalic: roboto_mono_boldItalic },
  'caveat': { plain: caveat_plain, bold: caveat_bold, italic: caveat_plain, boldItalic: caveat_bold },
}
export type BundledFont = keyof typeof assets
export const BUNDLED_FONTS = Object.keys(assets) as BundledFont[]
export function isBundledFont(font: OverlayFont): font is BundledFont {
  return Object.hasOwn(assets, font)
}
/** Caveat has no native italic; never synthesize a style that the PDF cannot reproduce. */
export function fontSupportsItalic(font: OverlayFont) { return font !== 'caveat' }
export function bundledFontUrl(box: Pick<Textbox, 'font' | 'bold' | 'italic'>) {
  if (!isBundledFont(box.font)) throw new Error('Keine gebündelte Schriftart.')
  const italic = box.italic && fontSupportsItalic(box.font)
  const variant = box.bold ? (italic ? 'boldItalic' : 'bold') : (italic ? 'italic' : 'plain')
  return assets[box.font][variant]
}
const bytes = new Map<string, Promise<Uint8Array>>()
export function loadBundledFont(url: string): Promise<Uint8Array> {
  let pending = bytes.get(url)
  if (!pending) {
    pending = fetch(url).then(async response => {
      if (!response.ok) throw new Error('Schriftart konnte nicht geladen werden. Bitte erneut versuchen.')
      return new Uint8Array(await response.arrayBuffer())
    }).catch(error => { bytes.delete(url); throw error })
    bytes.set(url, pending)
  }
  return pending
}
