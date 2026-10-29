import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib'
const MAX_STREAM = 512 * 1024
function limit(): never { throw new Error('PDF-Stream überschreitet die sicheren Grenzen der Größenbegrenzung.') }
function unsupported(): never { throw new Error('Nicht unterstützte PDF-Streamkodierung.') }
/** Stream dictionary keys that do not change how the bytes are obtained. */
const allowed = new Set(['/Length', '/Filter', '/DecodeParms', '/DL', '/Length1', '/Length2', '/Length3', '/Subtype', '/Type', '/Metadata'])

async function inflate(input: Uint8Array, maximum: number) {
  const reader = new Blob([Uint8Array.from(input).buffer]).stream().pipeThrough(new DecompressionStream('deflate')).getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      // A damaged/truncated stream fails: rewriting partial content would lose data.
      let next: ReadableStreamReadResult<Uint8Array>
      try { next = await reader.read() } catch { unsupported() }
      if (next.done) break
      length += next.value.length
      if (length > maximum) { await reader.cancel(); limit() }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}
function ascii85(input: Uint8Array, maximum: number) {
  const out: number[] = []
  let group: number[] = []
  const flush = (count: number) => {
    let value = 0
    for (let i = 0; i < 5; i++) value = value * 85 + (group[i] ?? 84)
    for (let i = 0; i < count - 1; i++) out.push((value >>> (24 - 8 * i)) & 255)
    group = []
  }
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === 126) break // ~>
    if (c <= 32) continue
    if (c === 122 && !group.length) { out.push(0, 0, 0, 0); continue }
    if (c < 33 || c > 117) unsupported()
    group.push(c - 33)
    if (group.length === 5) flush(5)
    if (out.length > maximum) limit()
  }
  if (group.length) flush(group.length)
  return Uint8Array.from(out)
}
/** Byte-wise ASCIIHexDecode: no string conversion of the whole input (spreading
 * a large array into String.fromCharCode exceeds the engine's argument limit). */
function asciiHex(input: Uint8Array, maximum: number) {
  const out = new Uint8Array(Math.min(Math.ceil(input.length / 2), maximum))
  let length = 0, high = -1
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === 62) break // >
    if (c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32) continue
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : unsupported()
    if (high < 0) { high = v; continue }
    if (length >= maximum) limit()
    out[length++] = (high << 4) | v
    high = -1
  }
  if (high >= 0) { if (length >= maximum) limit(); out[length++] = high << 4 }
  return out.slice(0, length)
}
function lzw(input: Uint8Array, maximum: number, early = 1) {
  const out: number[] = []
  let dict: number[][] = [], width = 9, prev: number[] | null = null, bits = 0, buffer = 0
  const reset = () => { dict = Array.from({ length: 258 }, (_, i) => (i < 256 ? [i] : [])); width = 9; prev = null }
  reset()
  for (let i = 0; i < input.length; i++) {
    buffer = (buffer << 8) | input[i]; bits += 8
    while (bits >= width) {
      const code = (buffer >> (bits - width)) & ((1 << width) - 1)
      bits -= width
      if (code === 256) { reset(); continue }
      if (code === 257) return Uint8Array.from(out)
      let entry = dict[code]
      if (!entry || (code >= 258 && !entry.length)) {
        if (!prev || code !== dict.length) unsupported()
        entry = [...prev, prev[0]]
      }
      out.push(...entry)
      if (out.length > maximum) limit()
      if (prev) dict.push([...prev, entry[0]])
      prev = entry
      if (dict.length + early >= 1 << width && width < 12) width++
    }
  }
  return Uint8Array.from(out)
}
function runLength(input: Uint8Array, maximum: number) {
  const out: number[] = []
  for (let i = 0; i < input.length;) {
    const n = input[i++]
    if (n === 128) break
    if (n < 128) { for (let k = 0; k <= n; k++) out.push(input[i++]) }
    else { const v = input[i++]; for (let k = 0; k < 257 - n; k++) out.push(v) }
    if (out.length > maximum) limit()
  }
  return Uint8Array.from(out)
}
/** Undo PNG/TIFF predictors only in their trivial forms (none). */
function predictor(params: unknown) {
  if (!(params instanceof PDFDict)) return
  const p = params.lookup(PDFName.of('Predictor'))
  if (p && !(p instanceof PDFNumber && p.asNumber() === 1)) unsupported()
}
export async function streamBytes(raw: PDFRawStream, maximum = MAX_STREAM): Promise<Uint8Array> {
  // Native streaming inflate stops at the output limit. Never use unbounded
  // pdf-lib decode(): a single compressed DEFLATE block may expand enormously.
  if (raw.contents.length > maximum || raw.dict.keys().some(key => !allowed.has(key.toString()))) limit()
  const filter = raw.dict.lookup(PDFName.of('Filter')), parms = raw.dict.lookup(PDFName.of('DecodeParms'))
  const filters = filter instanceof PDFArray ? filter.asArray().map(f => raw.dict.context.lookup(f)) : filter ? [filter] : []
  const params = parms instanceof PDFArray ? parms.asArray().map(f => raw.dict.context.lookup(f)) : [parms]
  if (filters.length > 4) unsupported()
  let bytes: Uint8Array = raw.contents
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i]
    if (!(f instanceof PDFName)) unsupported()
    const name = f.decodeText()
    if (name === 'FlateDecode' || name === 'Fl') { predictor(params[i]); bytes = await inflate(bytes, maximum) }
    else if (name === 'ASCII85Decode' || name === 'A85') bytes = ascii85(bytes, maximum)
    else if (name === 'ASCIIHexDecode' || name === 'AHx') bytes = asciiHex(bytes, maximum)
    else if (name === 'LZWDecode' || name === 'LZW') {
      predictor(params[i])
      const early = params[i] instanceof PDFDict ? (params[i] as PDFDict).lookup(PDFName.of('EarlyChange')) : undefined
      bytes = lzw(bytes, maximum, early instanceof PDFNumber ? early.asNumber() : 1)
    } else if (name === 'RunLengthDecode' || name === 'RL') bytes = runLength(bytes, maximum)
    else unsupported()
    if (bytes.length > maximum) limit()
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
