// Carries outlines and tags into a rebuilt document. Nothing here may pull a page into
// the output that the user removed, so every reference is mapped explicitly.
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFObjectCopier, PDFRef, PDFString, type PDFObject,
} from 'pdf-lib'
import type { DocumentPage } from '../pages'

const key = PDFName.of
const MAX_OUTLINE_ITEMS = 20_000

/** The source a page really stems from: text corrections only swap in a new revision of it. */
export const pageOrigin = (page: DocumentPage) => page.revisionOf ?? page.sourceId

/** Tags describe a whole document, so they survive only when its pages stay complete and in order. */
export function keepsTagOrder(pages: DocumentPage[], sourcePageCount: number): boolean {
  const origin = pageOrigin(pages[0])
  return pages.length === sourcePageCount && pages.every((page, index) => pageOrigin(page) === origin && page.sourceIndex === index)
}

const lookup = (doc: PDFDocument, value: PDFObject | undefined) => (value instanceof PDFRef ? doc.context.lookup(value) : value)

function namedDestination(doc: PDFDocument, name: string): PDFObject | undefined {
  const direct = lookup(doc, doc.catalog.get(key('Dests')))
  if (direct instanceof PDFDict) {
    const entry = lookup(doc, direct.get(key(name)))
    if (entry) return entry instanceof PDFDict ? lookup(doc, entry.get(key('D'))) : entry
  }
  const names = lookup(doc, doc.catalog.get(key('Names')))
  const pending = [names instanceof PDFDict ? lookup(doc, names.get(key('Dests'))) : undefined]
  const seen = new Set<PDFObject>()
  while (pending.length) {
    const node = pending.pop()
    if (!(node instanceof PDFDict) || seen.has(node)) continue
    seen.add(node)
    const pairs = lookup(doc, node.get(key('Names')))
    if (pairs instanceof PDFArray) for (let index = 0; index + 1 < pairs.size(); index += 2) {
      const entryName = lookup(doc, pairs.get(index))
      if ((entryName instanceof PDFString || entryName instanceof PDFHexString) && entryName.decodeText() === name) {
        const entry = lookup(doc, pairs.get(index + 1))
        return entry instanceof PDFDict ? lookup(doc, entry.get(key('D'))) : entry
      }
    }
    const kids = lookup(doc, node.get(key('Kids')))
    if (kids instanceof PDFArray) for (let index = 0; index < kids.size(); index++) pending.push(lookup(doc, kids.get(index)))
  }
  return undefined
}

function destinationOf(doc: PDFDocument, item: PDFDict): PDFArray | undefined {
  const action = lookup(doc, item.get(key('A')))
  const raw = lookup(doc, item.get(key('Dest'))) ??
    (action instanceof PDFDict && action.get(key('S'))?.toString() === '/GoTo' ? lookup(doc, action.get(key('D'))) : undefined)
  if (raw instanceof PDFArray) return raw
  if (raw instanceof PDFString || raw instanceof PDFHexString) { const named = namedDestination(doc, raw.decodeText()); return named instanceof PDFArray ? named : undefined }
  if (raw instanceof PDFName) { const named = namedDestination(doc, raw.decodeText()); return named instanceof PDFArray ? named : undefined }
  return undefined
}

interface OutlineItem { title: PDFObject; target?: { page: PDFRef; rest: PDFObject[] }; flags?: PDFObject; color?: PDFObject; children: OutlineItem[] }

/** Reads the tree; items pointing at a removed page go, their children move up. */
function readOutline(doc: PDFDocument, first: PDFObject | undefined, pages: ReadonlyMap<PDFRef, PDFRef>, seen: Set<PDFObject>): OutlineItem[] {
  const items: OutlineItem[] = []
  for (let current = lookup(doc, first); current instanceof PDFDict && !seen.has(current) && seen.size < MAX_OUTLINE_ITEMS; current = lookup(doc, current.get(key('Next')))) {
    seen.add(current)
    const children = readOutline(doc, current.get(key('First')), pages, seen)
    const destination = destinationOf(doc, current)
    const page = destination?.get(0)
    const mapped = page instanceof PDFRef ? pages.get(page) : undefined
    const title = lookup(doc, current.get(key('Title')))
    if (mapped && destination && title) {
      items.push({ title, children, flags: lookup(doc, current.get(key('F'))), color: lookup(doc, current.get(key('C'))), target: { page: mapped, rest: destination.asArray().slice(1).filter(value => !(value instanceof PDFRef)) } })
    } else items.push(...children)
  }
  return items
}

function writeOutline(output: PDFDocument, items: OutlineItem[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } {
  const refs = items.map(() => output.context.nextRef())
  let count = 0
  items.forEach((item, index) => {
    const entries: Record<string, PDFObject> = { Title: item.title.clone(output.context), Parent: parent }
    if (index > 0) entries.Prev = refs[index - 1]
    if (index < items.length - 1) entries.Next = refs[index + 1]
    if (item.target) entries.Dest = output.context.obj([item.target.page, ...item.target.rest.map(value => value.clone(output.context))])
    if (item.flags) entries.F = item.flags.clone(output.context)
    if (item.color) entries.C = item.color.clone(output.context)
    if (item.children.length) {
      const nested = writeOutline(output, item.children, refs[index])
      entries.First = nested.first
      entries.Last = nested.last
      entries.Count = PDFNumber.of(nested.count)
      count += nested.count
    }
    output.context.assign(refs[index], output.context.obj(entries))
    count += 1
  })
  return { first: refs[0], last: refs[refs.length - 1], count }
}

/** `sources`: documents in page order, each with a map from its page refs to output pages. */
export function copyOutlines(sources: { doc: PDFDocument; pages: ReadonlyMap<PDFRef, PDFRef> }[], output: PDFDocument): void {
  const items = sources.flatMap(({ doc, pages }) => {
    const root = lookup(doc, doc.catalog.get(key('Outlines')))
    return root instanceof PDFDict ? readOutline(doc, root.get(key('First')), pages, new Set()) : []
  })
  if (!items.length) return
  const rootRef = output.context.nextRef()
  const { first, last, count } = writeOutline(output, items, rootRef)
  output.context.assign(rootRef, output.context.obj({ Type: 'Outlines', First: first, Last: last, Count: count }))
  output.catalog.set(key('Outlines'), rootRef)
}

/** Copies the tag tree with page references pointing at the output pages. The caller has
 * made sure every source page exists there, so no removed page can come along. */
export function copyTags(source: PDFDocument, output: PDFDocument, copier: PDFObjectCopier, pages: ReadonlyMap<PDFRef, PDFRef>): void {
  const root = source.catalog.get(key('StructTreeRoot'))
  if (!(root instanceof PDFRef)) return
  // The copier follows every reference. Known pages must resolve to their output pages.
  const traversed = (copier as unknown as { traversedObjects: Map<PDFObject, PDFObject> }).traversedObjects
  for (const [from, to] of pages) traversed.set(from, to)
  output.catalog.set(key('StructTreeRoot'), copier.copy(root))
  for (const name of ['MarkInfo', 'Lang']) {
    const value = source.catalog.get(key(name))
    if (value && value !== PDFNull) output.catalog.set(key(name), copier.copy(value))
  }
}
