import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { assessExport, findTextIssues, inspectStructures, needsConfirmation, preflightExport, rejection, type StructureFinding, type StructureKind } from '../../src/core/pdf/preflight'
import { exportPageDocument, inspectPages, preparePages } from '../../src/core/pdf/pageOperations'
import type { Textbox } from '../../src/core/model'

const key = PDFName.of

afterEach(() => vi.unstubAllGlobals())
const stubFontFetch = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(readFileSync(resolve(url.replace(/^\//, ''))))))

async function blank(pages = 1) {
  const doc = await PDFDocument.create()
  for (let index = 0; index < pages; index++) doc.addPage([300, 300])
  return doc
}
const save = (doc: PDFDocument) => doc.save({ useObjectStreams: false, updateFieldAppearances: false })
const find = (findings: StructureFinding[], kind: StructureKind) => findings.find(item => item.kind === kind)!
const box = (overrides: Partial<Textbox>): Textbox => ({ id: 't', pageIndex: 0, x: 20, y: 200, text: 'Text', font: 'helvetica', fontSize: 12, bold: false, italic: false, underline: false, ...overrides })

async function withForm() {
  const doc = await blank()
  const field = doc.getForm().createTextField('name')
  field.addToPage(doc.getPage(0), { x: 20, y: 20, width: 100, height: 20 })
  return doc
}

function addOutline(doc: PDFDocument) {
  const item = doc.context.register(doc.context.obj({ Title: PDFString.of('Kapitel'), Dest: doc.context.obj([doc.getPage(0).ref, key('Fit')]) }))
  const root = doc.context.register(doc.context.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }))
  doc.catalog.set(key('Outlines'), root)
}
function addTags(doc: PDFDocument) {
  doc.catalog.set(key('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: 'StructTreeRoot' })))
  doc.catalog.set(key('MarkInfo'), doc.context.obj({ Marked: true }))
}
function addSignature(doc: PDFDocument) {
  const signature = doc.context.register(doc.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', Contents: PDFHexString.of('00') }))
  const field = doc.context.register(doc.context.obj({ FT: 'Sig', T: PDFString.of('Unterschrift'), V: signature }))
  doc.catalog.set(key('AcroForm'), doc.context.obj({ Fields: [field], SigFlags: 3 }))
}
function addJavaScript(doc: PDFDocument) {
  const script = doc.context.register(doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }))
  doc.catalog.set(key('Names'), doc.context.obj({ JavaScript: { Names: [PDFString.of('a'), script] } }))
  doc.catalog.set(key('OpenAction'), script)
}

test('a plain PDF reports nothing and needs no confirmation', async () => {
  const findings = await inspectStructures(await save(await blank()))
  expect(findings.map(item => item.state)).toEqual(Array(7).fill('none'))
  expect(findings.map(item => assessExport(item, false).decision)).toEqual(Array(7).fill('ok'))
})

test('finds forms, outline and tags', async () => {
  const doc = await withForm()
  addOutline(doc)
  addTags(doc)
  const findings = await inspectStructures(await save(doc))
  expect(find(findings, 'forms')).toMatchObject({ state: 'present', count: 1 })
  expect(find(findings, 'outline')).toMatchObject({ state: 'present', count: 1 })
  expect(find(findings, 'tags').state).toBe('present')
})

test('finds a signed field but not an empty signature field', async () => {
  const signed = await blank()
  addSignature(signed)
  expect(find(await inspectStructures(await save(signed)), 'signature')).toMatchObject({ state: 'present', count: 1 })
  const empty = await blank()
  const field = empty.context.register(empty.context.obj({ FT: 'Sig', T: PDFString.of('Offen') }))
  empty.catalog.set(key('AcroForm'), empty.context.obj({ Fields: [field] }))
  expect(find(await inspectStructures(await save(empty)), 'signature').state).toBe('none')
})

test('counts document JavaScript, an open action and active annotations', async () => {
  const doc = await blank()
  addJavaScript(doc)
  const annotation = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Screen', Rect: [0, 0, 10, 10] }))
  doc.getPage(0).node.set(key('Annots'), doc.context.obj([annotation]))
  expect(find(await inspectStructures(await save(doc)), 'activeContent')).toMatchObject({ state: 'present', count: 3 })
})

test('a harmless GoTo open action is not active content', async () => {
  const doc = await blank()
  doc.catalog.set(key('OpenAction'), doc.context.obj({ S: 'GoTo', D: [doc.getPage(0).ref, key('Fit')] }))
  expect(find(await inspectStructures(await save(doc)), 'activeContent').state).toBe('none')
})

test('finds attachments, also in nested name tree nodes', async () => {
  const doc = await blank()
  await doc.attach(new Uint8Array([1, 2, 3]), 'daten.csv', { mimeType: 'text/csv' })
  expect(find(await inspectStructures(await doc.save()), 'attachments').state).toBe('present')
  const nested = await blank()
  const file = nested.context.register(nested.context.obj({ Type: 'Filespec' }))
  const leaf = nested.context.register(nested.context.obj({ Names: [PDFString.of('a'), file, PDFString.of('b'), file] }))
  nested.catalog.set(key('Names'), nested.context.obj({ EmbeddedFiles: { Kids: [leaf] } }))
  expect(find(await inspectStructures(await save(nested)), 'attachments').count).toBe(2)
})

test('finds XFA', async () => {
  const doc = await blank()
  doc.catalog.set(key('AcroForm'), doc.context.obj({ Fields: [], XFA: PDFString.of('<xdp/>') }))
  expect(find(await inspectStructures(await save(doc)), 'xfa').state).toBe('present')
})

test('a damaged file is unknown, never safe, and needs confirmation', async () => {
  const findings = await inspectStructures(new TextEncoder().encode('%PDF-1.7 das ist kein Dokument'))
  expect(findings.every(item => item.state === 'unknown')).toBe(true)
  expect(findings.every(item => assessExport(item, false).decision === 'confirm')).toBe(true)
})

test('a name tree that points at itself ends instead of hanging', async () => {
  const doc = await blank()
  const loop = doc.context.nextRef()
  doc.context.assign(loop, doc.context.obj({ Kids: [loop] }))
  doc.catalog.set(key('Names'), doc.context.obj({ JavaScript: loop }))
  expect(find(await inspectStructures(await save(doc)), 'activeContent').state).toBe('none')
})

test('signature decision: a signature always needs confirmation, with or without page changes', () => {
  const finding: StructureFinding = { kind: 'signature', state: 'present', count: 1 }
  for (const rebuilt of [false, true]) {
    const result = assessExport(finding, rebuilt)
    expect(result.decision).toBe('confirm')
    expect(result.message).toMatch(/ungültig/)
  }
})

test('page changes turn preserved structures into a confirmed loss and reject XFA', () => {
  const state = (kind: StructureKind): StructureFinding => ({ kind, state: 'present', count: 1 })
  for (const kind of ['outline', 'tags', 'attachments', 'activeContent'] as const) {
    // Without a statement about what survives, a rebuild counts as a loss.
    expect(assessExport(state(kind), false).decision).toBe('ok')
    expect(assessExport(state(kind), true).decision).toBe('confirm')
  }
  expect(assessExport(state('forms'), true).decision).toBe('ok')
  expect(assessExport(state('xfa'), false).decision).toBe('confirm')
  expect(assessExport(state('xfa'), true).decision).toBe('reject')
})

test('report on an unchanged document: structures stay, and they really are still there after export', async () => {
  const doc = await withForm()
  addOutline(doc)
  addTags(doc)
  await doc.attach(new Uint8Array([1]), 'a.txt', { mimeType: 'text/plain' })
  const bytes = await doc.save()
  const pages = await inspectPages(bytes, 'a.pdf')
  const report = await preflightExport({ original: bytes, state: { pageSources: [], pages, overlays: [] } })
  expect(report.rebuilt).toBe(false)
  expect(needsConfirmation(report)).toEqual([])
  const output = await inspectStructures(await exportPageDocument(bytes, [], pages, [box({ text: 'Neu' })]))
  for (const kind of ['forms', 'outline', 'tags', 'attachments'] as const) expect(find(output, kind).state).toBe('present')
})

test('report on reordered pages names the lost tags, keeps the outline, and the export confirms both', async () => {
  const doc = await withForm()
  doc.addPage([300, 300])
  addOutline(doc)
  addTags(doc)
  const bytes = await doc.save()
  const pages = (await inspectPages(bytes, 'a.pdf')).reverse()
  const report = await preflightExport({ original: bytes, state: { pageSources: [], pages, overlays: [] } })
  expect(report.rebuilt).toBe(true)
  expect(needsConfirmation(report).map(item => item.kind)).toEqual(['tags'])
  const output = await inspectStructures(await exportPageDocument(bytes, [], pages, []))
  expect(find(output, 'forms').state).toBe('present')
  expect(find(output, 'outline').state).toBe('present')
  expect(find(output, 'tags').state).toBe('none')
})

test('an appended source counts: its signature needs confirmation even when the original has none', async () => {
  const signed = await blank()
  addSignature(signed)
  const appended = await preparePages(await save(signed), 'b.pdf')
  const bytes = await save(await blank())
  const pages = [...await inspectPages(bytes, 'a.pdf'), ...appended.pages]
  const report = await preflightExport({ original: bytes, state: { pageSources: [appended.source], pages, overlays: [] } })
  expect(needsConfirmation(report).map(item => item.kind)).toContain('signature')
})

test('XFA with page changes is rejected', async () => {
  const doc = await blank(2)
  doc.catalog.set(key('AcroForm'), doc.context.obj({ Fields: [], XFA: PDFString.of('<xdp/>') }))
  const bytes = await save(doc)
  const pages = await inspectPages(bytes, 'a.pdf')
  const report = await preflightExport({ original: bytes, state: { pageSources: [], pages: [pages[1], pages[0]], overlays: [] } })
  expect(rejection(report)?.message).toMatch(/nicht möglich/)
})

test('the check never changes its input', async () => {
  const doc = await withForm()
  addSignature(doc)
  const bytes = await save(doc), before = bytes.slice()
  await preflightExport({ original: bytes, state: { pageSources: [], pages: await inspectPages(bytes, 'a.pdf'), overlays: [box({ text: 'Ω' })] } })
  expect(bytes).toEqual(before)
})

test('names the unsupported character, its text and its font', async () => {
  const issues = await findTextIssues([box({ id: 'a', pageIndex: 3, text: 'Gewicht 5 Ω und Rest' })])
  expect(issues).toEqual([{ overlayId: 'a', pageIndex: 3, characters: ['Ω'], font: StandardFonts.Helvetica, excerpt: 'Gewicht 5 Ω und Rest' }])
})

test('German text in a standard font and line breaks are fine, and empty boxes do not count', async () => {
  expect(await findTextIssues([box({ text: 'Größe\nÄpfel Öl Übung ß €' }), box({ id: 'leer', text: '   ' })])).toEqual([])
})

test('a bundled font reports characters outside its glyph set instead of drawing an empty box', async () => {
  stubFontFetch()
  const issues = await findTextIssues([box({ font: 'lato', text: 'Hallo 漢' })])
  expect(issues[0]).toMatchObject({ characters: ['漢'] })
})

test('a bundled font accepts German text', async () => {
  stubFontFetch()
  expect(await findTextIssues([box({ font: 'noto-sans', text: 'Größe prüfen: Äpfel, Öl, Straße' })])).toEqual([])
})

test('symbol boxes report letters that ZapfDingbats cannot show', async () => {
  const issues = await findTextIssues([box({ font: 'zapfdingbats', text: '✓A' })])
  expect(issues[0].characters).toEqual(['A'])
})

test('each character is listed once', async () => {
  expect((await findTextIssues([box({ text: 'ΩΩ α Ω' })]))[0].characters).toEqual(['Ω', 'α'])
})

test('a report does not touch overlays', async () => {
  const overlay = box({ text: 'Ω' }), copy = { ...overlay }
  const doc = await PDFDocument.create()
  doc.addPage()
  const bytes = await doc.save()
  await preflightExport({ original: bytes, state: { pageSources: [], pages: await inspectPages(bytes, 'a.pdf'), overlays: [overlay] } })
  expect(overlay).toEqual(copy)
})
