import { expect, test } from 'vitest'
import { PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { composePages, exportPageDocument, inspectPages, preparePages, tagsSurvive } from '../../src/core/pdf/pageOperations'
import { inspectStructures, preflightExport } from '../../src/core/pdf/preflight'
import { sourceRevision } from '../../src/core/sourceText/revision'
import { deletePages, movePage, type DocumentPage } from '../../src/core/pages'
import type { EditorState } from '../../src/core/model'

const key = PDFName.of

/** Three pages, one marked text each, an outline tree and a tag tree. */
async function structured(pageCount = 3) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica)
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const page = doc.addPage([300, 300])
    page.drawText(`Seite ${index + 1}`, { x: 20, y: 250, size: 12, font })
    return page
  })
  const parent = doc.context.nextRef(), rootRef = doc.context.nextRef()
  const items = pages.map(() => doc.context.nextRef())
  pages.forEach((page, index) => doc.context.assign(items[index], doc.context.obj({
    Title: PDFString.of(`Kapitel ${index + 1}`), Parent: parent, Dest: [page.ref, key('Fit')],
    ...(index ? { Prev: items[index - 1] } : {}), ...(index < pages.length - 1 ? { Next: items[index + 1] } : {}),
  })))
  doc.context.assign(parent, doc.context.obj({ Type: 'Outlines', First: items[0], Last: items.at(-1)!, Count: items.length }))
  doc.catalog.set(key('Outlines'), parent)
  const elements = pages.map((page, index) => doc.context.register(doc.context.obj({ Type: 'StructElem', S: 'P', P: rootRef, Pg: page.ref, K: index })))
  doc.context.assign(rootRef, doc.context.obj({ Type: 'StructTreeRoot', K: elements }))
  doc.catalog.set(key('StructTreeRoot'), rootRef)
  doc.catalog.set(key('MarkInfo'), doc.context.obj({ Marked: true }))
  doc.catalog.set(key('Lang'), PDFString.of('de'))
  return doc.save({ useObjectStreams: false })
}

/** Reads outline titles and their real target page numbers through PDF.js. */
async function outline(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice() })
  const pdf = await task.promise
  const walk = async (items: Awaited<ReturnType<typeof pdf.getOutline>>): Promise<unknown[]> => Promise.all((items ?? []).map(async item => {
    const destination = Array.isArray(item.dest) ? item.dest : item.dest ? await pdf.getDestination(item.dest) : null
    return { title: item.title, page: destination ? await pdf.getPageIndex(destination[0]) + 1 : null, children: await walk(item.items) }
  }))
  const tree = await walk(await pdf.getOutline())
  await task.destroy()
  return tree as { title: string; page: number | null; children: unknown[] }[]
}

const tagged = async (bytes: Uint8Array) => (await inspectStructures(bytes)).find(item => item.kind === 'tags')!.state
const text = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes)

async function fixture(pageCount?: number) {
  const bytes = await structured(pageCount), pages = await inspectPages(bytes, 'a.pdf')
  const state: EditorState = { overlays: [], pages, pageSources: [] }
  return { bytes, pages, state }
}

test('moved pages keep their outline entries, which point at the new positions', async () => {
  const { bytes, pages, state } = await fixture()
  movePage(state, pages[2].id, 0).apply(state)
  expect(await outline(await composePages(bytes, [], state.pages!))).toEqual([
    { title: 'Kapitel 1', page: 2, children: [] },
    { title: 'Kapitel 2', page: 3, children: [] },
    { title: 'Kapitel 3', page: 1, children: [] },
  ])
})

test('an entry for a deleted page goes, and the deleted page does not come back through it', async () => {
  const { bytes, pages, state } = await fixture()
  deletePages(state, [pages[1].id]).apply(state)
  const output = await composePages(bytes, [], state.pages!)
  expect((await outline(output)).map(item => [item.title, item.page])).toEqual([['Kapitel 1', 1], ['Kapitel 3', 2]])
  expect((await PDFDocument.load(output)).getPageCount()).toBe(2)
  const task = getDocument({ data: output.slice() })
  const pdf = await task.promise
  const texts = []
  for (let number = 1; number <= pdf.numPages; number++) texts.push((await (await pdf.getPage(number)).getTextContent()).items.map(item => ('str' in item ? item.str : '')).join(''))
  await task.destroy()
  expect(texts).toEqual(['Seite 1', 'Seite 3'])
})

test('a deleted parent hands its children up', async () => {
  const doc = await PDFDocument.create()
  const first = doc.addPage([200, 200]), second = doc.addPage([200, 200])
  const root = doc.context.nextRef(), parent = doc.context.nextRef(), child = doc.context.nextRef()
  doc.context.assign(child, doc.context.obj({ Title: PDFString.of('Unterpunkt'), Parent: parent, Dest: [second.ref, key('Fit')] }))
  doc.context.assign(parent, doc.context.obj({ Title: PDFString.of('Oberpunkt'), Parent: root, Dest: [first.ref, key('Fit')], First: child, Last: child, Count: 1 }))
  doc.context.assign(root, doc.context.obj({ Type: 'Outlines', First: parent, Last: parent, Count: 2 }))
  doc.catalog.set(key('Outlines'), root)
  const bytes = await doc.save(), pages = await inspectPages(bytes, 'a.pdf')
  const state: EditorState = { overlays: [], pages, pageSources: [] }
  deletePages(state, [pages[0].id]).apply(state)
  expect(await outline(await composePages(bytes, [], state.pages!))).toEqual([{ title: 'Unterpunkt', page: 1, children: [] }])
})

test('nesting survives', async () => {
  const doc = await PDFDocument.create()
  const first = doc.addPage([200, 200]), second = doc.addPage([200, 200])
  const root = doc.context.nextRef(), parent = doc.context.nextRef(), child = doc.context.nextRef()
  doc.context.assign(child, doc.context.obj({ Title: PDFString.of('Unterpunkt'), Parent: parent, Dest: [second.ref, key('Fit')] }))
  doc.context.assign(parent, doc.context.obj({ Title: PDFString.of('Oberpunkt'), Parent: root, Dest: [first.ref, key('Fit')], First: child, Last: child, Count: 1 }))
  doc.context.assign(root, doc.context.obj({ Type: 'Outlines', First: parent, Last: parent, Count: 2 }))
  doc.catalog.set(key('Outlines'), root)
  const bytes = await doc.save(), pages = await inspectPages(bytes, 'a.pdf')
  expect(await outline(await composePages(bytes, [], [pages[1], pages[0]]))).toEqual([
    { title: 'Oberpunkt', page: 2, children: [{ title: 'Unterpunkt', page: 1, children: [] }] },
  ])
})

test('named destinations and GoTo actions are followed', async () => {
  const doc = await PDFDocument.create()
  const first = doc.addPage([200, 200]), second = doc.addPage([200, 200])
  const root = doc.context.nextRef(), named = doc.context.nextRef(), action = doc.context.nextRef()
  doc.context.assign(named, doc.context.obj({ Title: PDFString.of('Benannt'), Parent: root, Dest: PDFString.of('ziel'), Next: action }))
  doc.context.assign(action, doc.context.obj({ Title: PDFString.of('Aktion'), Parent: root, Prev: named, A: { S: 'GoTo', D: [first.ref, key('Fit')] } }))
  doc.context.assign(root, doc.context.obj({ Type: 'Outlines', First: named, Last: action, Count: 2 }))
  doc.catalog.set(key('Outlines'), root)
  doc.catalog.set(key('Names'), doc.context.obj({ Dests: { Names: [PDFString.of('ziel'), doc.context.obj([second.ref, key('Fit')])] } }))
  const bytes = await doc.save(), pages = await inspectPages(bytes, 'a.pdf')
  expect((await outline(await composePages(bytes, [], [pages[1], pages[0]]))).map(item => [item.title, item.page])).toEqual([['Benannt', 1], ['Aktion', 2]])
})

test('appended documents bring their outline along, behind the first', async () => {
  const { bytes, pages } = await fixture(2)
  const appended = await preparePages(await structured(1), 'b.pdf')
  const result = await outline(await composePages(bytes, [appended.source], [...pages, ...appended.pages]))
  expect(result.map(item => [item.title, item.page])).toEqual([['Kapitel 1', 1], ['Kapitel 2', 2], ['Kapitel 1', 3]])
})

test('a page extracted on its own keeps only its own entry', async () => {
  const { bytes, pages } = await fixture()
  expect((await outline(await exportPageDocument(bytes, [], pages, [], { pageId: [pages[2].id] }))).map(item => item.title)).toEqual(['Kapitel 3'])
})

test('a redacted export carries no outline and no tags', async () => {
  const { bytes, pages } = await fixture()
  const output = await composePages(bytes, [], [pages[1], pages[0], pages[2]], { secure: true })
  expect(await outline(output)).toEqual([])
  expect(await tagged(output)).toBe('none')
  expect(text(output)).not.toContain('Kapitel')
})

test('a corrected page keeps outline and tags, which point at the corrected page', async () => {
  const { bytes, pages, state } = await fixture()
  const corrected = await PDFDocument.load(bytes)
  sourceRevision(state, pages[1].id, (await corrected.save()).slice().buffer).apply(state)
  expect(state.pages![1].revisionOf).toBe('original')
  const output = await composePages(bytes, state.pageSources!, state.pages!)
  expect(await tagged(output)).toBe('present')
  expect((await outline(output)).map(item => [item.title, item.page])).toEqual([['Kapitel 1', 1], ['Kapitel 2', 2], ['Kapitel 3', 3]])
  const doc = await PDFDocument.load(output)
  const refs = doc.getPages().map(page => page.ref.toString())
  const elements = doc.context.enumerateIndirectObjects().flatMap(([, object]) => {
    const target = 'get' in object && typeof object.get === 'function' && object.get(key('S'))?.toString() === '/P' ? object.get(key('Pg')) : undefined
    return target ? [target.toString()] : []
  })
  expect([...elements].sort()).toEqual([...refs].sort())
  expect(doc.getPageCount()).toBe(3)
  expect(doc.catalog.get(key('Lang'))).toBeDefined()
  expect(doc.catalog.has(key('MarkInfo'))).toBe(true)
})

test('tags stay only for complete pages in their original order', async () => {
  const { bytes, pages } = await fixture()
  expect(await tagsSurvive(bytes, [], pages, false)).toBe(true)
  expect(await tagsSurvive(bytes, [], [pages[1], pages[0], pages[2]], false)).toBe(false)
  expect(await tagsSurvive(bytes, [], pages.slice(0, 2), false)).toBe(false)
  expect(await tagsSurvive(bytes, [], pages, true)).toBe(false)
})

test('a removed page cannot return through the tag tree', async () => {
  const { bytes, pages } = await fixture()
  const output = await composePages(bytes, [], pages.slice(0, 2))
  expect(await tagged(output)).toBe('none')
  const doc = await PDFDocument.load(output)
  const streams = doc.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream)
  expect(streams.length).toBeLessThanOrEqual(2)
})

test('the check and the export agree after a text correction', async () => {
  const { bytes, pages, state } = await fixture()
  sourceRevision(state, pages[0].id, bytes.slice().buffer).apply(state)
  const input = { original: bytes, state: { pageSources: state.pageSources!, pages: state.pages!, overlays: [] } }
  const report = await preflightExport(input)
  expect(report.rebuilt).toBe(true)
  expect(report.assessments.filter(item => item.decision !== 'ok')).toEqual([])
  const output = await inspectStructures(await exportPageDocument(bytes, state.pageSources!, state.pages! as DocumentPage[], []))
  for (const kind of ['outline', 'tags'] as const) expect(output.find(item => item.kind === kind)?.state).toBe('present')
})

test('the check and the export agree for a redacted document', async () => {
  const { bytes, pages } = await fixture()
  const report = await preflightExport({ original: bytes, state: { pages, overlays: [], redactionApplied: true } })
  expect(report.assessments.filter(item => item.decision === 'confirm').map(item => item.kind).sort()).toEqual(['outline', 'tags'])
})

/** A heading without a target, a web link, a script and a plain entry on page 2. */
async function mixedOutline() {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const pages = [doc.addPage([300, 300]), doc.addPage([300, 300])]
  const root = doc.context.nextRef(), [heading, child, emptied, gone, link, script, plain] = Array.from({ length: 7 }, () => doc.context.nextRef())
  const entry = (ref: typeof root, title: string, parent: typeof root, extra: object) =>
    doc.context.assign(ref, doc.context.obj({ Title: PDFString.of(title), Parent: parent, ...extra }))
  entry(heading, 'Kapitel', root, { First: child, Last: child, Count: 1, Next: emptied })
  entry(child, 'Abschnitt', heading, { Dest: [pages[0].ref, key('Fit')] })
  entry(emptied, 'Nur Seite 2', root, { First: gone, Last: gone, Count: 1, Prev: heading, Next: link })
  entry(gone, 'Auf Seite 2', emptied, { Dest: [pages[1].ref, key('Fit')] })
  entry(link, 'Webseite', root, { A: { S: 'URI', URI: PDFString.of('https://example.org/') }, Prev: emptied, Next: script })
  entry(script, 'Skript', root, { A: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') }, Prev: link, Next: plain })
  entry(plain, 'Normal', root, { Dest: [pages[0].ref, key('Fit')], Prev: script })
  doc.context.assign(root, doc.context.obj({ Type: 'Outlines', First: heading, Last: plain, Count: 5 }))
  doc.catalog.set(key('Outlines'), root)
  return doc.save({ useObjectStreams: false })
}
const outlineText = async (bytes: Uint8Array) => {
  const task = getDocument({ data: bytes.slice() })
  const items = await (await task.promise).getOutline()
  const result = JSON.stringify(items)
  await task.destroy()
  return result
}

test('reordering keeps entries without a target and web links, removed pages take theirs along', async () => {
  const bytes = await mixedOutline(), pages = await inspectPages(bytes, 'mixed')
  const reordered = await outlineText(await composePages(bytes, [], [...pages].reverse()))
  for (const title of ['Kapitel', 'Abschnitt', 'Nur Seite 2', 'Webseite', 'Normal']) expect(reordered).toContain(`"title":"${title}"`)
  expect(reordered).toContain('https://example.org/')
  const shortened = await outlineText(await composePages(bytes, [], [pages[0]]))
  for (const title of ['Kapitel', 'Abschnitt', 'Webseite', 'Normal']) expect(shortened).toContain(`"title":"${title}"`)
  expect(shortened).not.toContain('Nur Seite 2')
  expect(shortened).not.toContain('Auf Seite 2')
})

test('a script behind a bookmark is not carried into a rebuilt document', async () => {
  const bytes = await mixedOutline(), pages = await inspectPages(bytes, 'mixed')
  const raw = new TextDecoder('latin1').decode(await composePages(bytes, [], [...pages].reverse()))
  expect(raw).not.toContain('JavaScript')
  expect(raw).not.toContain('app.alert')
})
