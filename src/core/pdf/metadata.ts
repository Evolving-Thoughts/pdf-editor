// Core module: document info (T24). A PDF can store the same field twice, in the
// Info dictionary and in an XMP packet, so both are read and both are changed.
// A removal only counts as done when neither copy still holds the value.
import { decodePDFRawStream, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFString } from 'pdf-lib'
import { dropUnreachableObjects } from './optimizePdf'

export const METADATA_FIELDS = ['title', 'author', 'subject', 'keywords'] as const
export type MetadataField = (typeof METADATA_FIELDS)[number]

/** Per field: the new text, or null to remove it. Fields left out stay as they are. */
export interface MetadataEdit {
  fields: Partial<Record<MetadataField, string | null>>
  /** Also removes producing software, dates and XMP tool entries. */
  removeTechnical?: boolean
}

export interface FieldValue { info?: string; xmp?: string }
export interface DocumentMetadata {
  fields: Record<MetadataField, FieldValue>
  technical: { creator?: string; producer?: string; created?: string; modified?: string }
  /** XMP exists, but its structure could not be read. */
  xmpUnreadable: boolean
}
export interface MetadataResult { bytes: Uint8Array; xmpRemoved: boolean }

const key = PDFName.of
const INFO_KEYS: Record<MetadataField, string> = { title: 'Title', author: 'Author', subject: 'Subject', keywords: 'Keywords' }
const TECHNICAL_INFO = ['Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped']
const TECHNICAL_XMP = ['xmp:CreatorTool', 'pdf:Producer', 'xmp:CreateDate', 'xmp:ModifyDate', 'xmp:MetadataDate', 'xmpMM:DocumentID', 'xmpMM:InstanceID', 'xmpMM:OriginalDocumentID', 'xmpMM:History']
const XMP_TAGS: Record<MetadataField, string[]> = {
  title: ['dc:title'],
  author: ['dc:creator'],
  subject: ['dc:description'],
  keywords: ['pdf:Keywords', 'dc:subject'],
}
const NAMESPACES = 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"'

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const unescapeXml = (text: string) => text
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

function infoDict(doc: PDFDocument): PDFDict | undefined {
  const info = doc.context.trailerInfo.Info
  const value = info instanceof PDFRef ? doc.context.lookup(info) : info
  return value instanceof PDFDict ? value : undefined
}
function infoText(info: PDFDict | undefined, name: string): string | undefined {
  const value = info?.lookup(key(name))
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined
}

function metadataStream(doc: PDFDocument): PDFRawStream | undefined {
  const stream = doc.catalog.lookup(key('Metadata'))
  return stream instanceof PDFRawStream ? stream : undefined
}
function xmpText(stream: PDFRawStream | undefined): string | undefined {
  if (!stream) return undefined
  return new TextDecoder('utf-8').decode(stream.dict.has(key('Filter')) ? decodePDFRawStream(stream).decode() : stream.contents)
}

/** Reads an element, or the attribute form some producers write on rdf:Description. */
function readTag(xmp: string, tag: string): string | undefined {
  const name = tag.replace(':', '\\:')
  const element = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xmp)
  if (element) {
    const items = [...element[1].matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map(match => match[1])
    const text = (items.length ? items : [element[1]]).map(item => unescapeXml(item.trim())).filter(Boolean).join(', ')
    return text || undefined
  }
  const attribute = new RegExp(`\\s${name}="([^"]*)"`).exec(xmp)
  return attribute?.[1] ? unescapeXml(attribute[1]) : undefined
}
function removeTag(xmp: string, tag: string): string {
  const name = tag.replace(':', '\\:')
  return xmp
    .replace(new RegExp(`\\s*<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, 'g'), '')
    .replace(new RegExp(`\\s*<${name}(?:\\s[^>]*)?/>`, 'g'), '')
    .replace(new RegExp(`\\s${name}="[^"]*"`, 'g'), '')
}
function fieldElement(field: MetadataField, text: string): string {
  const value = escapeXml(text)
  if (field === 'title') return `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${value}</rdf:li></rdf:Alt></dc:title>`
  if (field === 'author') return `<dc:creator><rdf:Seq><rdf:li>${value}</rdf:li></rdf:Seq></dc:creator>`
  if (field === 'subject') return `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${value}</rdf:li></rdf:Alt></dc:description>`
  return `<pdf:Keywords>${value}</pdf:Keywords>`
}

export async function readMetadata(bytes: Uint8Array): Promise<DocumentMetadata> {
  const doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false })
  const info = infoDict(doc)
  let xmp: string | undefined
  try { xmp = xmpText(metadataStream(doc)) } catch { xmp = undefined }
  const xmpUnreadable = doc.catalog.has(key('Metadata')) && !xmp?.includes('</rdf:RDF>')
  const readable = xmpUnreadable ? undefined : xmp
  const fields = Object.fromEntries(METADATA_FIELDS.map(field => {
    const fromXmp = readable === undefined ? undefined : XMP_TAGS[field].map(tag => readTag(readable, tag)).find(Boolean)
    return [field, { info: infoText(info, INFO_KEYS[field]) || undefined, xmp: fromXmp }]
  })) as DocumentMetadata['fields']
  return {
    fields,
    technical: {
      creator: infoText(info, 'Creator') || (readable && readTag(readable, 'xmp:CreatorTool')) || undefined,
      producer: infoText(info, 'Producer') || (readable && readTag(readable, 'pdf:Producer')) || undefined,
      created: infoText(info, 'CreationDate') || (readable && readTag(readable, 'xmp:CreateDate')) || undefined,
      modified: infoText(info, 'ModDate') || (readable && readTag(readable, 'xmp:ModifyDate')) || undefined,
    },
    xmpUnreadable,
  }
}

export const effectiveField = (value: FieldValue) => value.info ?? value.xmp ?? ''
export const hasMetadataEdit = (edit: MetadataEdit | undefined) => !!edit && (edit.removeTechnical || Object.keys(edit.fields).length > 0)

function rewriteXmp(doc: PDFDocument, edit: MetadataEdit, removedValues: string[]): boolean {
  const stream = metadataStream(doc)
  if (!doc.catalog.has(key('Metadata'))) return false
  let xmp: string | undefined
  try { xmp = xmpText(stream) } catch { xmp = undefined }
  const removeWhole = () => { doc.catalog.delete(key('Metadata')); return true }
  if (!stream || xmp === undefined || !xmp.includes('</rdf:RDF>')) return Object.keys(edit.fields).length || edit.removeTechnical ? removeWhole() : false
  for (const [field, value] of Object.entries(edit.fields) as [MetadataField, string | null][]) {
    if (value === undefined) continue
    for (const tag of XMP_TAGS[field]) xmp = removeTag(xmp, tag)
    if (value !== null) xmp = xmp.replace('</rdf:RDF>', `<rdf:Description rdf:about="" ${NAMESPACES}>${fieldElement(field, value)}</rdf:Description></rdf:RDF>`)
  }
  if (edit.removeTechnical) for (const tag of TECHNICAL_XMP) xmp = removeTag(xmp, tag)
  // Producer-specific copies cannot be enumerated. A value that survived means this
  // packet is not understood well enough, so the whole packet goes.
  const escaped = removedValues.flatMap(value => [value, escapeXml(value)])
  if (escaped.some(value => value && xmp!.includes(value))) return removeWhole()
  const dict = stream.dict.clone(doc.context)
  dict.delete(key('Filter'))
  dict.delete(key('DecodeParms'))
  doc.context.assign(doc.context.getObjectRef(stream)!, PDFRawStream.of(dict, new TextEncoder().encode(xmp)))
  return false
}

/** The output of this step keeps exactly what was decided: no library may add metadata back. */
export async function applyMetadata(bytes: Uint8Array, edit: MetadataEdit): Promise<MetadataResult> {
  const doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false })
  const removedValues: string[] = []
  let info = infoDict(doc)
  for (const field of METADATA_FIELDS) {
    const value = edit.fields[field]
    if (value === undefined) continue
    const before = infoText(info, INFO_KEYS[field])
    if (before) removedValues.push(before)
    if (value === null) info?.delete(key(INFO_KEYS[field]))
    else {
      if (!info) {
        info = doc.context.obj({})
        doc.context.trailerInfo.Info = doc.context.register(info)
      }
      info.set(key(INFO_KEYS[field]), PDFHexString.fromText(value))
    }
  }
  if (edit.removeTechnical) for (const name of TECHNICAL_INFO) info?.delete(key(name))
  const xmpBefore = (() => { try { return xmpText(metadataStream(doc)) } catch { return undefined } })()
  if (xmpBefore) for (const field of METADATA_FIELDS) {
    if (edit.fields[field] === undefined) continue
    for (const tag of XMP_TAGS[field]) {
      const value = readTag(xmpBefore, tag)
      if (value) removedValues.push(value)
    }
  }
  const kept = removedValues.filter(value => !Object.values(edit.fields).some(text => text && text.includes(value)))
  const xmpRemoved = rewriteXmp(doc, edit, kept)
  // A replaced or removed copy must leave the file, not just the document structure.
  dropUnreachableObjects(doc)
  return { bytes: await doc.save({ updateFieldAppearances: false, addDefaultPage: false }), xmpRemoved }
}

export function setMetadataCommand(before: MetadataEdit | undefined, after: MetadataEdit | undefined) {
  const from = before ? structuredClone(before) : undefined, to = after ? structuredClone(after) : undefined
  return {
    label: 'Edit document info',
    apply: (state: { metadata?: MetadataEdit }) => { state.metadata = to ? structuredClone(to) : undefined },
    revert: (state: { metadata?: MetadataEdit }) => { state.metadata = from ? structuredClone(from) : undefined },
  }
}
