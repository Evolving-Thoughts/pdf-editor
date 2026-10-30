// Core module: lossless structure optimization (T18). Never touches pixels,
// never rasterizes. The candidate is read back and compared with the input;
// it is only used when every document structure is proven identical.
import {
  decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, type PDFObject,
} from 'pdf-lib'
import { checkExportAbort } from './compressPdf'

export type OptimizationOutcome = 'smaller' | 'not-smaller' | 'not-verified'
export interface OptimizationResult { bytes: Uint8Array; originalSize: number; outcome: OptimizationOutcome }

const key = PDFName.of
const FILTER = key('Filter'), LENGTH = key('Length')

/** FNV-1a in two seeds: this detects accidental differences, it is no security hash. */
function fingerprint(bytes: Uint8Array): string {
  let a = 0x811c9dc5, b = 0x01000193
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193)
    b = Math.imul(b ^ byte, 0x811c9dc5)
  }
  return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${bytes.length}`
}

function streamContent(stream: PDFRawStream): string {
  try {
    return `decoded:${fingerprint(decodePDFRawStream(stream).decode())}`
  } catch {
    // JPEG and similar image data has no decoder here; its filter is part of its identity.
    return `raw:${stream.dict.get(FILTER)}:${fingerprint(stream.contents)}`
  }
}

const hasReference = (value: PDFObject): boolean =>
  value instanceof PDFRef ||
  (value instanceof PDFDict && [...value.values()].some(hasReference)) ||
  (value instanceof PDFArray && value.asArray().some(hasReference))

/** Everything reachable from the document root, in a form independent of object
 * numbers and stream compression. Two documents with one description draw the same. */
export function describeDocument(doc: PDFDocument): string {
  const numbers = new Map<PDFRef, number>()
  const describe = (value: PDFObject | undefined, depth = 0): string => {
    if (value === undefined) return '∅'
    if (depth > 400) throw new Error('Too deeply nested')
    if (value instanceof PDFRef) {
      const target = doc.context.lookup(value)
      // Plain streams are values: two identical copies describe the same as one shared copy.
      if (target instanceof PDFRawStream && ![...target.dict.values()].some(hasReference)) return describe(target, depth + 1)
      if (numbers.has(value)) return `#${numbers.get(value)}`
      numbers.set(value, numbers.size)
      return describe(target, depth + 1)
    }
    if (value instanceof PDFRawStream) return `stream(${describeDict(value.dict, depth, [FILTER, LENGTH])}|${streamContent(value)})`
    if (value instanceof PDFStream) return `stream(${describeDict(value.dict, depth, [FILTER, LENGTH])})`
    if (value instanceof PDFDict) return describeDict(value, depth, [])
    if (value instanceof PDFArray) return `[${value.asArray().map(item => describe(item, depth + 1)).join(' ')}]`
    return value.toString()
  }
  const describeDict = (dict: PDFDict, depth: number, skipped: PDFName[]): string => {
    const entries = dict.entries().filter(([name]) => !skipped.includes(name)).map(([name, item]) => [name.toString(), item] as const)
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `<${entries.map(([name, item]) => `${name} ${describe(item, depth + 1)}`).join(' ')}>`
  }
  return `${describe(doc.context.trailerInfo.Root as PDFObject)}|${describe(doc.context.trailerInfo.Info as PDFObject | undefined)}`
}

function replaceReferences(value: PDFObject, map: Map<PDFRef, PDFRef>): void {
  if (value instanceof PDFDict) {
    for (const [name, item] of value.entries()) {
      if (item instanceof PDFRef) { if (map.has(item)) value.set(name, map.get(item)!) }
      else replaceReferences(item, map)
    }
  } else if (value instanceof PDFArray) {
    value.asArray().forEach((item, index) => {
      if (item instanceof PDFRef) { if (map.has(item)) value.set(index, map.get(item)!) }
      else replaceReferences(item, map)
    })
  } else if (value instanceof PDFStream) replaceReferences(value.dict, map)
}

/** Shares byte-identical streams that have no references of their own. */
function shareIdenticalStreams(doc: PDFDocument): void {
  const seen = new Map<string, PDFRef>(), map = new Map<PDFRef, PDFRef>()
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || [...object.dict.values()].some(hasReference)) continue
    const identity = `${object.dict.toString()}|${fingerprint(object.contents)}`
    const first = seen.get(identity)
    if (first) map.set(ref, first)
    else seen.set(identity, ref)
  }
  if (!map.size) return
  for (const [, object] of doc.context.enumerateIndirectObjects()) replaceReferences(object, map)
  replaceReferences(doc.context.trailerInfo.Root as PDFObject, map)
}

/** Deflates streams stored without any filter. XMP stays readable, as PDF readers expect. */
function deflatePlainStreams(doc: PDFDocument): void {
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || object.dict.has(FILTER) || object.dict.has(key('F'))) continue
    if (object.dict.get(key('Type'))?.toString() === '/Metadata') continue
    const deflated = doc.context.flateStream(object.contents)
    if (deflated.contents.length >= object.contents.length) continue
    const next = object.dict.clone(doc.context)
    next.set(FILTER, key('FlateDecode'))
    doc.context.assign(ref, PDFRawStream.of(next, deflated.contents))
  }
}

function dropUnreachableObjects(doc: PDFDocument): void {
  const reached = new Set<PDFRef>(), pending: PDFObject[] = [doc.context.trailerInfo.Root as PDFObject]
  if (doc.context.trailerInfo.Info) pending.push(doc.context.trailerInfo.Info as PDFObject)
  while (pending.length) {
    const value = pending.pop()!
    if (value instanceof PDFRef) {
      if (reached.has(value)) continue
      reached.add(value)
      const target = doc.context.lookup(value)
      if (target) pending.push(target)
    } else if (value instanceof PDFDict) pending.push(...value.values())
    else if (value instanceof PDFArray) pending.push(...value.asArray())
    else if (value instanceof PDFStream) pending.push(value.dict)
  }
  for (const [ref] of doc.context.enumerateIndirectObjects()) if (!reached.has(ref)) doc.context.delete(ref)
}

export async function optimizePdfStructure(
  bytes: Uint8Array,
  options: { signal?: AbortSignal } = {},
): Promise<OptimizationResult> {
  const { signal } = options, unchanged = (outcome: OptimizationOutcome): OptimizationResult => ({ bytes, originalSize: bytes.length, outcome })
  checkExportAbort(signal)
  const doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false })
  if (doc.isEncrypted) return unchanged('not-verified')
  let expected: string
  try {
    expected = describeDocument(doc)
    checkExportAbort(signal)
    deflatePlainStreams(doc)
    shareIdenticalStreams(doc)
    dropUnreachableObjects(doc)
  } catch (problem) {
    checkExportAbort(signal)
    if (problem instanceof DOMException && problem.name === 'AbortError') throw problem
    return unchanged('not-verified')
  }
  checkExportAbort(signal)
  const candidate = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false })
  checkExportAbort(signal)
  if (candidate.length >= bytes.length) return unchanged('not-smaller')
  try {
    const reread = await PDFDocument.load(candidate, { updateMetadata: false })
    if (describeDocument(reread) !== expected) return unchanged('not-verified')
  } catch {
    return unchanged('not-verified')
  }
  checkExportAbort(signal)
  return { bytes: candidate, originalSize: bytes.length, outcome: 'smaller' }
}
