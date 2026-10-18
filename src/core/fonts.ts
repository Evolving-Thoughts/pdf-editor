import type { OverlayFont, Textbox } from './model'
import sansPlain from '@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff?url'
import sansBold from '@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff?url'
import sansItalic from '@fontsource/noto-sans/files/noto-sans-latin-400-italic.woff?url'
import sansBoldItalic from '@fontsource/noto-sans/files/noto-sans-latin-700-italic.woff?url'
import serifPlain from '@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff?url'
import serifBold from '@fontsource/noto-serif/files/noto-serif-latin-700-normal.woff?url'
import serifItalic from '@fontsource/noto-serif/files/noto-serif-latin-400-italic.woff?url'
import serifBoldItalic from '@fontsource/noto-serif/files/noto-serif-latin-700-italic.woff?url'

export type BundledFont = Extract<OverlayFont, 'noto-sans' | 'noto-serif'>
export function isBundledFont(font: OverlayFont): font is BundledFont {
  return font === 'noto-sans' || font === 'noto-serif'
}
const assets = {
  'noto-sans': { plain: sansPlain, bold: sansBold, italic: sansItalic, boldItalic: sansBoldItalic },
  'noto-serif': { plain: serifPlain, bold: serifBold, italic: serifItalic, boldItalic: serifBoldItalic },
}
export function bundledFontUrl(box: Pick<Textbox, 'font' | 'bold' | 'italic'>) {
  if (!isBundledFont(box.font)) throw new Error('Keine gebündelte Schriftart.')
  const variant = box.bold ? (box.italic ? 'boldItalic' : 'bold') : (box.italic ? 'italic' : 'plain')
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
