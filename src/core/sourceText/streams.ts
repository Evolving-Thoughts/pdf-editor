import { PDFName, PDFRawStream } from 'pdf-lib'
const MAX_STREAM = 512 * 1024
function limit(): never { throw new Error('PDF-Stream überschreitet die sicheren Grenzen der Größenbegrenzung.') }
function unsupported(): never { throw new Error('Nicht unterstützte PDF-Streamkodierung.') }
export async function streamBytes(raw: PDFRawStream, maximum = MAX_STREAM): Promise<Uint8Array> {
  // Native streaming inflate stops at the output limit. Never use unbounded
  // pdf-lib decode(): a single compressed DEFLATE block may expand enormously.
  if (raw.contents.length > maximum || raw.dict.keys().some(key => !['/Length', '/Filter', '/Length1'].includes(key.toString()))) limit()
  const filter = raw.dict.lookup(PDFName.of('Filter'))
  let bytes: Uint8Array
  if (!filter) bytes = raw.contents
  else {
    if (!(filter instanceof PDFName) || filter.decodeText() !== 'FlateDecode') unsupported()
    const reader = new Blob([Uint8Array.from(raw.contents).buffer]).stream().pipeThrough(new DecompressionStream('deflate')).getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.length
        if (length > maximum) { await reader.cancel(); limit() }
        chunks.push(next.value)
      }
    } finally { reader.releaseLock() }
    bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  }
  if (bytes.length > maximum) limit()
  return Uint8Array.from(bytes)
}
export async function streamText(raw: PDFRawStream): Promise<string> {
  const bytes = await streamBytes(raw)
  let text = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return text
}
