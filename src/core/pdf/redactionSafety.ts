import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, type PDFObject, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib'

const name = PDFName.of
const unsafe = () => new Error('Dieses PDF enthält Ressourcen, die für einen sicheren Schwärzungs-Export nicht unterstützt werden. Es wurde nichts angewendet.')
const categories: Record<string, [string, number]> = {
  Tf: ['Font', -2], Do: ['XObject', -1], gs: ['ExtGState', -1], CS: ['ColorSpace', -1], cs: ['ColorSpace', -1],
  SCN: ['Pattern', -1], scn: ['Pattern', -1], sh: ['Shading', -1], BDC: ['Properties', -1], DP: ['Properties', -1],
}
const operators = new Set('b B b* B* BDC BMC BT BX c cm CS cs d d0 d1 Do DP EMC ET EX f F f* G g gs h i j J K k l m M MP n q Q re RG rg ri s S SC SCN sc scn sh T* Tc Td TD Tf Tj TJ TL Tm Tr Ts Tw Tz v w W W* y \' "'.split(' '))
type Uses = Map<string, Set<string>>
/** Tokenize operators, never names inside strings, comments or composite operands. Inline images fail closed. */
function resourceUses(text: string): Uses {
  if (text.length > 64_000_000) throw unsafe()
  const uses: Uses = new Map(), operands: (string | null)[] = []
  let i = 0
  const whitespace = /[\s\0]/, delimiter = /[\s\0()[\]<>/%{}]/
  const skipString = () => {
    let depth = 1; i++
    while (i < text.length && depth) {
      const c = text[i++]
      if (c === '\\') i++
      else if (c === '(') depth++
      else if (c === ')') depth--
    }
    if (depth) throw unsafe()
  }
  const skipHex = () => { const end = text.indexOf('>', i + 1); if (end < 0) throw unsafe(); i = end + 1 }
  const skipComposite = () => {
    const stack = [text[i] === '[' ? ']' : '>>']; i += text[i] === '[' ? 1 : 2
    while (i < text.length && stack.length) {
      if (text[i] === '%') { while (i < text.length && !/[\r\n]/.test(text[i])) i++; continue }
      if (text[i] === '(') { skipString(); continue }
      if (text.slice(i, i + 2) === '<<') { stack.push('>>'); i += 2; continue }
      if (text[i] === '<') { skipHex(); continue }
      if (text[i] === '[') { stack.push(']'); i++; continue }
      const end = stack[stack.length - 1]
      if (text.slice(i, i + end.length) === end) { stack.pop(); i += end.length; continue }
      if (text[i] === ']' || text[i] === '>') throw unsafe()
      i++
    }
    if (stack.length) throw unsafe()
  }
  while (i < text.length) {
    if (whitespace.test(text[i])) { i++; continue }
    if (text[i] === '%') { while (i < text.length && !/[\r\n]/.test(text[i])) i++; continue }
    if (text[i] === '(') { skipString(); operands.push(null); continue }
    if (text[i] === '[' || text.slice(i, i + 2) === '<<') { skipComposite(); operands.push(null); continue }
    if (text[i] === '<') { skipHex(); operands.push(null); continue }
    const start = i
    if (text[i] === '/') {
      i++; while (i < text.length && !delimiter.test(text[i])) i++
      operands.push(PDFName.of(text.slice(start + 1, i).replace(/#([a-f\d]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))).decodeText()); continue
    }
    while (i < text.length && !delimiter.test(text[i])) i++
    if (i === start) throw unsafe()
    const token = text.slice(start, i)
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token) || ['true', 'false', 'null'].includes(token)) { operands.push(null); continue }
    if (!operators.has(token)) throw unsafe()
    const reference = categories[token]
    if (reference) {
      const key = operands.at(reference[1])
      if (key) { const set = uses.get(reference[0]) ?? new Set<string>(); set.add(key); uses.set(reference[0], set) }
      else if (['Tf', 'Do', 'gs', 'CS', 'cs', 'sh'].includes(token)) throw unsafe()
    }
    operands.length = 0
  }
  if (operands.length) throw unsafe()
  return uses
}

/** Secure mode only: do not carry unused resources or navigation/action references into the new document. */
export function sanitizeRedactedSource(doc: PDFDocument, indices: Set<number>) {
  const context = doc.context, seen = new Set<PDFRawStream>()
  // A shared image/form may contain pixels/text hidden by another page's clip.
  // Keeping it would retain the unmasked original. Fail closed rather than silently
  // changing additional pages or pretending a page-local mask removes that payload.
  const omitted = new Set<PDFRawStream>()
  const collect = (resources: PDFDict | undefined) => {
    const objects = resources?.lookupMaybe(name('XObject'), PDFDict)
    for (const [, raw] of objects?.entries() ?? []) {
      const stream = context.lookup(raw)
      if (!(stream instanceof PDFRawStream) || omitted.has(stream)) continue
      omitted.add(stream)
      collect(stream.dict.lookupMaybe(name('Resources'), PDFDict))
      for (const key of ['SMask', 'Mask']) {
        const mask = stream.dict.lookup(name(key))
        if (mask instanceof PDFRawStream) omitted.add(mask)
      }
    }
  }
  doc.getPages().forEach((page, index) => { if (!indices.has(index)) collect(page.node.Resources()) })
  const textOf = (raw: PDFObject | undefined): string => {
    const object = context.lookup(raw)
    if (object instanceof PDFArray) return object.asArray().map(textOf).join('\n')
    if (!(object instanceof PDFRawStream)) throw unsafe()
    try { return Array.from(decodePDFRawStream(object).decode(), byte => String.fromCharCode(byte)).join('') } catch { throw unsafe() }
  }
  const prune = (resources: PDFDict | undefined, uses: Uses, defaultAppearance = false): PDFDict => {
    const result = context.obj({})
    for (const [category, keys] of uses) {
      const old = resources?.lookupMaybe(name(category), PDFDict), kept = context.obj({})
      for (const key of keys) {
        const raw = old?.get(name(key))
        if (!raw) {
          // PDFs may omit DR for standard viewer fonts in DA; do not invent a source reference.
          if (defaultAppearance && category === 'Font') continue
          if (category === 'ColorSpace' && ['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern'].includes(key)) continue
          throw unsafe()
        }
        kept.set(name(key), raw)
        const object = context.lookup(raw)
        if (object instanceof PDFRawStream) cleanStream(object, resources)
        if (category === 'ExtGState' && object instanceof PDFDict) {
          const mask = object.lookup(name('SMask'))
          if (mask instanceof PDFDict) {
            const group = mask.lookup(name('G')); if (group instanceof PDFRawStream) cleanStream(group, resources)
          }
        }
      }
      if (kept.keys().length) result.set(name(category), kept)
    }
    return result
  }
  const cleanStream = (stream: PDFRawStream, inherited?: PDFDict) => {
    if (omitted.has(stream)) throw new Error('Gemeinsam genutzte Originalbilder oder Formobjekte sind bei der sicheren Schwärzung noch nicht unterstützt. Es wurde nichts angewendet.')
    if (seen.has(stream)) return
    seen.add(stream)
    const dict = stream.dict
    for (const key of ['Metadata', 'PieceInfo', 'OPI', 'Alternates', 'Ref']) dict.delete(name(key))
    if (dict.get(name('Subtype'))?.toString() === '/Form' || dict.has(name('PatternType'))) {
      dict.set(name('Resources'), prune(dict.lookupMaybe(name('Resources'), PDFDict) ?? inherited, resourceUses(textOf(stream))))
    } else if (dict.get(name('Subtype'))?.toString() === '/Image') {
      const color = dict.get(name('ColorSpace'))
      if (color instanceof PDFName && !['DeviceGray', 'DeviceRGB', 'DeviceCMYK'].includes(color.decodeText())) {
        const resolved = inherited?.lookupMaybe(name('ColorSpace'), PDFDict)?.get(color)
        if (!resolved) throw unsafe()
        dict.set(name('ColorSpace'), resolved)
      }
      for (const key of ['SMask', 'Mask']) { const mask = dict.lookup(name(key)); if (mask instanceof PDFRawStream) cleanStream(mask, inherited) }
    }
  }
  const cleanDict = (dict: PDFDict) => {
    for (const key of ['A', 'AA', 'Dest', 'Metadata', 'PieceInfo', 'FS', 'IRT', 'Popup', 'RichMediaContent', 'RichMediaSettings']) dict.delete(name(key))
    const appearances = dict.lookupMaybe(name('AP'), PDFDict)
    if (appearances) for (const [, raw] of appearances.entries()) {
      const object = context.lookup(raw)
      if (object instanceof PDFRawStream) cleanStream(object)
      else if (object instanceof PDFDict) for (const [, value] of object.entries()) {
        const stream = context.lookup(value); if (stream instanceof PDFRawStream) cleanStream(stream)
      }
    }
  }
  const pages = doc.getPages()
  for (const index of indices) {
    const page = pages[index], resources = page.node.Resources(), contents = page.node.get(name('Contents'))
    page.node.set(name('Resources'), prune(resources, contents ? resourceUses(textOf(contents)) : new Map()))
    cleanDict(page.node)
    const annotations = page.node.Annots()
    if (annotations) for (const raw of annotations.asArray()) {
      const dict = context.lookup(raw)
      if (!(dict instanceof PDFDict)) throw unsafe()
      cleanDict(dict)
      if (dict.get(name('Subtype'))?.toString() !== '/Widget') { dict.delete(name('P')); dict.delete(name('Parent')) }
    }
  }
  const form = doc.getForm(), root = form.acroForm.dict, defaults: string[] = []
  const appearance = (dict: PDFDict) => {
    cleanDict(dict)
    const da = dict.lookup(name('DA'))
    if (da instanceof PDFString || da instanceof PDFHexString) defaults.push(da.decodeText())
  }
  // Nonvisual values/calculations must not keep confidential data from removed pages alive.
  for (const field of form.getFields()) {
    const visible = field.acroField.getWidgets().some(widget => {
      const ref = context.getObjectRef(widget.dict)
      return ref && [...indices].some(index => pages[index].node.Annots()?.indexOf(ref) !== undefined)
    })
    if (!visible) { form.acroForm.removeField(field.acroField); continue }
    appearance(field.acroField.dict)
    for (const widget of field.acroField.getWidgets()) appearance(widget.dict)
  }
  for (const [field] of form.acroForm.getAllFields()) appearance(field.dict)
  appearance(root); root.delete(name('CO')); root.delete(name('XFA'))
  const uses: Uses = new Map()
  for (const da of defaults) for (const [category, keys] of resourceUses(da)) {
    const set = uses.get(category) ?? new Set<string>(); for (const key of keys) set.add(key); uses.set(category, set)
  }
  root.set(name('DR'), prune(root.lookupMaybe(name('DR'), PDFDict), uses, true))
  // Fail closed if an uncommon retained object still reaches an omitted page.
  const allowed = new Set<PDFDict>([...indices].map(index => pages[index].node)), visited = new Set<unknown>()
  const check = (raw: PDFObject | undefined) => {
    const object = context.lookup(raw)
    if (!object || visited.has(object)) return
    visited.add(object)
    if (object instanceof PDFRawStream) { check(object.dict); return }
    if (object instanceof PDFArray) { for (const value of object.asArray()) check(value); return }
    if (!(object instanceof PDFDict)) return
    // Auxiliary metadata/actions on retained fonts/resources can also contain private payloads.
    cleanDict(object)
    const type = object.get(name('Type'))?.toString()
    if (type === '/Pages' || type === '/Catalog' || (type === '/Page' && !allowed.has(object))) throw unsafe()
    for (const [key, value] of object.entries()) {
      // Page tree parent is stripped by PDFObjectCopier.copyPDFPage.
      if (type === '/Page' && key.toString() === '/Parent') continue
      check(value)
    }
  }
  for (const index of indices) check(pages[index].node)
  check(root)
}
