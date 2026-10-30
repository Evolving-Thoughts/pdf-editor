// Core module: read-only document check before export (T17). It reports what a
// PDF contains and what an operation does to it. "unknown" never reads as safe,
// and a finding is not a security or conformance statement.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream, type PDFObject } from 'pdf-lib'
import { isTextbox, type Overlay, type Textbox } from '../model'
import type { DocumentPage, PageSource } from '../pages'
import { embedOverlayFont, unsupportedCharacters } from './exportPdf'
import { keepsPageTree } from './pageOperations'

export type StructureKind = 'signature' | 'activeContent' | 'attachments' | 'xfa' | 'forms' | 'outline' | 'tags'
export type StructureState = 'none' | 'present' | 'unknown'
export interface StructureFinding { kind: StructureKind; state: StructureState; count: number }
export type Decision = 'ok' | 'confirm' | 'reject'
export interface Assessment { kind: StructureKind; state: StructureState; decision: Decision; message: string }
export interface TextIssue { overlayId: string; pageIndex: number; characters: string[]; font: string; excerpt: string }
export interface PreflightReport { rebuilt: boolean; assessments: Assessment[]; textIssues: TextIssue[] }

const key = PDFName.of
const WALK_LIMIT = 50_000
const ACTIVE_ACTIONS = new Set(['/JavaScript', '/Launch', '/SubmitForm', '/ImportData', '/Rendition', '/Sound', '/Movie'])
const ACTIVE_ANNOTATIONS = new Set(['/Screen', '/Movie', '/Sound', '/RichMedia', '/3D'])

function dict(doc: PDFDocument, value: PDFObject | undefined): PDFDict | undefined {
  const object = value instanceof PDFRef ? doc.context.lookup(value) : value
  if (object instanceof PDFDict) return object
  return object instanceof PDFStream ? object.dict : undefined
}
function array(doc: PDFDocument, value: PDFObject | undefined): PDFArray | undefined {
  const object = value instanceof PDFRef ? doc.context.lookup(value) : value
  return object instanceof PDFArray ? object : undefined
}
function items(doc: PDFDocument, value: PDFObject | undefined): PDFObject[] {
  const list = array(doc, value)
  return list ? Array.from({ length: list.size() }, (_, index) => list.get(index)) : []
}

/** Name trees hold pairs in /Names and child nodes in /Kids. */
function nameTreeSize(doc: PDFDocument, root: PDFDict | undefined): number {
  let size = 0
  const seen = new Set<PDFDict>(), pending = root ? [root] : []
  while (pending.length) {
    const node = pending.pop()!
    if (seen.has(node)) continue
    if (seen.size > WALK_LIMIT) throw new Error('Name tree too large')
    seen.add(node)
    size += Math.floor(items(doc, node.get(key('Names'))).length / 2)
    for (const child of items(doc, node.get(key('Kids')))) {
      const next = dict(doc, child)
      if (next) pending.push(next)
    }
  }
  return size
}

function isActiveAction(doc: PDFDocument, value: PDFObject | undefined): boolean {
  const action = dict(doc, value)
  return !!action && ACTIVE_ACTIONS.has(action.get(key('S'))?.toString() ?? '')
}
function hasActiveTriggers(doc: PDFDocument, owner: PDFDict): boolean {
  if (isActiveAction(doc, owner.get(key('A')))) return true
  const triggers = dict(doc, owner.get(key('AA')))
  return !!triggers && [...triggers.values()].some(action => isActiveAction(doc, action))
}

function allFields(doc: PDFDocument, form: PDFDict | undefined): PDFDict[] {
  const seen = new Set<PDFDict>(), pending = items(doc, form?.get(key('Fields'))).map(field => dict(doc, field))
  while (pending.length) {
    const field = pending.pop()
    if (!field || seen.has(field)) continue
    if (seen.size > WALK_LIMIT) throw new Error('Form too large')
    seen.add(field)
    for (const child of items(doc, field.get(key('Kids')))) pending.push(dict(doc, child))
  }
  return [...seen]
}

function annotations(doc: PDFDocument): PDFDict[] {
  return doc.getPages().flatMap(page => items(doc, page.node.get(key('Annots'))).flatMap(annotation => {
    const value = dict(doc, annotation)
    return value ? [value] : []
  }))
}

function count(kind: StructureKind, measure: () => number): StructureFinding {
  try {
    const size = measure()
    return { kind, state: size > 0 ? 'present' : 'none', count: size }
  } catch {
    return { kind, state: 'unknown', count: 0 }
  }
}

function unknownFindings(): StructureFinding[] {
  return (['signature', 'activeContent', 'attachments', 'xfa', 'forms', 'outline', 'tags'] as const)
    .map(kind => ({ kind, state: 'unknown', count: 0 }))
}

/** One finding per kind. A part that cannot be read stays unknown; it never counts as absent. */
export async function inspectStructures(bytes: Uint8Array): Promise<StructureFinding[]> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false, throwOnInvalidObject: false })
  } catch {
    return unknownFindings()
  }
  const catalog = doc.catalog
  const form = () => dict(doc, catalog.get(key('AcroForm')))
  const names = () => dict(doc, catalog.get(key('Names')))
  const fields = () => allFields(doc, form())
  return [
    count('signature', () => fields().filter(field => field.get(key('FT'))?.toString() === '/Sig' && field.has(key('V'))).length + (dict(doc, catalog.get(key('Perms'))) ? 1 : 0)),
    count('activeContent', () => {
      const tree = nameTreeSize(doc, dict(doc, dict(doc, catalog.get(key('Names')))?.get(key('JavaScript'))))
      const open = isActiveAction(doc, catalog.get(key('OpenAction'))) ? 1 : 0
      const fieldTriggers = fields().filter(field => hasActiveTriggers(doc, field)).length
      const annotationTriggers = annotations(doc).filter(annotation =>
        ACTIVE_ANNOTATIONS.has(annotation.get(key('Subtype'))?.toString() ?? '') || hasActiveTriggers(doc, annotation)).length
      const pageTriggers = doc.getPages().filter(page => hasActiveTriggers(doc, page.node)).length
      return tree + open + fieldTriggers + annotationTriggers + pageTriggers + (dict(doc, catalog.get(key('AA'))) ? 1 : 0)
    }),
    count('attachments', () => nameTreeSize(doc, dict(doc, names()?.get(key('EmbeddedFiles')))) + items(doc, catalog.get(key('AF'))).length
      + annotations(doc).filter(annotation => annotation.get(key('Subtype'))?.toString() === '/FileAttachment').length),
    count('xfa', () => (form()?.has(key('XFA')) ? 1 : 0)),
    count('forms', () => fields().filter(field => field.has(key('FT'))).length),
    count('outline', () => {
      const root = dict(doc, catalog.get(key('Outlines')))
      if (!root?.has(key('First'))) return 0
      const total = root.get(key('Count'))
      const value = total instanceof PDFRef ? doc.context.lookup(total) : total
      return value instanceof PDFNumber ? Math.max(1, Math.abs(value.asNumber())) : 1
    }),
    count('tags', () => (dict(doc, catalog.get(key('StructTreeRoot'))) ? 1 : 0)),
  ]
}

const LABELS: Record<StructureKind, string> = {
  signature: 'Digitale Signatur',
  activeContent: 'Aktive Inhalte',
  attachments: 'Anhänge',
  xfa: 'XFA-Formular',
  forms: 'Formularfelder',
  outline: 'Lesezeichen',
  tags: 'Struktur-Tags',
}

/** What exporting does to one structure. Rebuilt documents get a new page tree (T7),
 * so structures that hang off the old catalog do not arrive unless the code copies them. */
export function assessExport(finding: StructureFinding, rebuilt: boolean): Assessment {
  const label = LABELS[finding.kind], assessed = (decision: Decision, message: string): Assessment => ({ kind: finding.kind, state: finding.state, decision, message })
  if (finding.state === 'unknown') return assessed('confirm', `${label}: konnte nicht zuverlässig geprüft werden. Bitte das Ergebnis selbst kontrollieren.`)
  if (finding.state === 'none') return assessed('ok', `${label}: keine gefunden.`)
  switch (finding.kind) {
    case 'signature':
      return assessed('confirm', 'Digitale Signatur: Der Export verändert die Datei, die Signatur wird dadurch ungültig.')
    case 'xfa':
      return rebuilt
        ? assessed('reject', 'XFA-Formular: Seitenänderungen werden hier nicht unterstützt. Der Export ist nicht möglich.')
        : assessed('confirm', 'XFA-Formular: Bleibt in der Datei, zeigt aber hinzugefügte Inhalte nicht. Manche Programme zeigen nur das XFA-Formular.')
    case 'forms':
      return assessed('ok', 'Formularfelder: bleiben erhalten.')
    case 'activeContent':
      return rebuilt
        ? assessed('confirm', 'Aktive Inhalte: gehen durch die Seitenänderungen verloren.')
        : assessed('ok', 'Aktive Inhalte: bleiben in der Datei. Der Editor führt sie nicht aus.')
    default:
      return rebuilt
        ? assessed('confirm', `${label}: gehen durch die Seitenänderungen verloren.`)
        : assessed('ok', `${label}: bleiben erhalten.`)
  }
}

/** Combines sources: the worst state of each kind decides. */
function mergeFindings(reports: StructureFinding[][]): StructureFinding[] {
  const rank: Record<StructureState, number> = { none: 0, present: 1, unknown: 2 }
  const merged = new Map<StructureKind, StructureFinding>()
  for (const finding of reports.flat()) {
    const current = merged.get(finding.kind)
    if (!current || rank[finding.state] > rank[current.state]) merged.set(finding.kind, { ...finding, count: finding.count + (current?.count ?? 0) })
    else current.count += finding.count
  }
  return [...merged.values()]
}

const excerptOf = (text: string, character: string) => {
  const at = text.indexOf(character), start = Math.max(0, at - 12)
  return `${start ? '…' : ''}${text.slice(start, at + character.length + 12).replace(/\s+/g, ' ')}${at + character.length + 12 < text.length ? '…' : ''}`
}

/** Uses the same font selection as the export, so the check cannot disagree with it. */
export async function findTextIssues(overlays: Overlay[]): Promise<TextIssue[]> {
  const doc = await PDFDocument.create(), fonts = new Map(), issues: TextIssue[] = []
  for (const overlay of overlays.filter(isTextbox) as Textbox[]) {
    if (!overlay.text.trim()) continue
    const font = await embedOverlayFont(doc, overlay, fonts)
    const characters = unsupportedCharacters(font, overlay.text)
    if (characters.length) issues.push({ overlayId: overlay.id, pageIndex: overlay.pageIndex, characters, font: font.name, excerpt: excerptOf(overlay.text, characters[0]) })
  }
  return issues
}

export interface PreflightInput {
  original: Uint8Array
  sources: PageSource[]
  pages: DocumentPage[]
  overlays: Overlay[]
  secure: boolean
}

export async function preflightExport({ original, sources, pages, overlays, secure }: PreflightInput): Promise<PreflightReport> {
  const rebuilt = !await keepsPageTree(original, pages, secure)
  const used = new Set(pages.map(page => page.sourceId))
  const inputs = [...(used.has('original') ? [original] : []), ...sources.filter(source => used.has(source.id)).map(source => new Uint8Array(source.bytes))]
  const findings = mergeFindings(await Promise.all(inputs.map(inspectStructures)))
  return { rebuilt, assessments: findings.map(finding => assessExport(finding, rebuilt)), textIssues: await findTextIssues(overlays) }
}

export const needsConfirmation = (report: PreflightReport) => report.assessments.filter(item => item.decision === 'confirm')
export const rejection = (report: PreflightReport) => report.assessments.find(item => item.decision === 'reject')
