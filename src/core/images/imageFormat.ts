/** Read only PNG/JPEG metadata before decoding potentially huge pixel buffers. */
export function inspectImage(bytes: Uint8Array): { width: number; height: number } {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) {
    if (bytes.length < 24 || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') throw new Error('Beschädigtes PNG-Bild.')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return validSize(view.getUint32(16), view.getUint32(20))
  }
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error('Bitte wähle ein PNG- oder JPG-Bild.')
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) break
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
    if (offset + 2 > bytes.length) break
    const length = bytes[offset] * 256 + bytes[offset + 1]
    if (length < 2 || offset + length > bytes.length) break
    // All SOF variants, excluding DHT, JPG and DAC marker codes.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) break
      return validSize(bytes[offset + 5] * 256 + bytes[offset + 6], bytes[offset + 3] * 256 + bytes[offset + 4])
    }
    offset += length
  }
  throw new Error('Beschädigtes JPG-Bild.')
}
function validSize(width: number, height: number) {
  if (!width || !height) throw new Error('Das Bild hat keine gültige Größe.')
  return { width, height }
}
