import { inspectImage } from './imageFormat'

/** Local-only browser decoding, separate from UI and PDF libraries. */
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 40_000_000

export async function importImage(file: File): Promise<{ dataUrl: string; pixelWidth: number; pixelHeight: number; name: string }> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Das Bild ist größer als 50 MB. Bitte verwende eine kleinere PNG- oder JPG-Datei.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const dimensions = inspectImage(bytes)
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) throw new Error('Das Bild hat mehr als 40 Megapixel. Bitte verkleinere es zuerst.')
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }) }
  catch { throw new Error('Das Bild konnte nicht gelesen werden. Ist die Datei beschädigt?') }
  try {
    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) throw new Error('Das Bild hat mehr als 40 Megapixel. Bitte verkleinere es zuerst.')
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Das Bild konnte auf diesem Gerät nicht geladen werden.')
    context.drawImage(bitmap, 0, 0)
    const dataUrl = canvas.toDataURL('image/png')
    if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Das Bild konnte auf diesem Gerät nicht geladen werden.')
    return { dataUrl, pixelWidth: bitmap.width, pixelHeight: bitmap.height, name: file.name }
  } finally { bitmap.close() }
}
