import { expect, test } from 'vitest'
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { applyMetadata, effectiveField, readMetadata, setMetadataCommand } from '../../src/core/pdf/metadata'
import { CommandStack } from '../../src/core/commands'
import type { EditorState } from '../../src/core/model'

const key = PDFName.of

const xmpPacket = (body: string) => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`

const FULL_XMP = xmpPacket(`
  <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Größenbericht</rdf:li></rdf:Alt></dc:title>
  <dc:creator><rdf:Seq><rdf:li>Mira Muster</rdf:li></rdf:Seq></dc:creator>
  <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Äpfel &amp; Birnen</rdf:li></rdf:Alt></dc:description>
  <pdf:Keywords>Obst, Bericht</pdf:Keywords>
  <dc:subject><rdf:Bag><rdf:li>Obst</rdf:li><rdf:li>Bericht</rdf:li></rdf:Bag></dc:subject>
  <xmp:CreatorTool>Textprogramm 9</xmp:CreatorTool>
  <pdf:Producer>Druckwerk 3</pdf:Producer>
  <xmp:CreateDate>2024-01-02T03:04:05Z</xmp:CreateDate>
  <xmpMM:DocumentID>uuid:1234</xmpMM:DocumentID>`)

async function pdf(xmp?: string, info = true) {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage([200, 200])
  if (info) {
    doc.setTitle('Größenbericht')
    doc.setAuthor('Mira Muster')
    doc.setSubject('Äpfel & Birnen')
    doc.setKeywords(['Obst', 'Bericht'])
    doc.setCreator('Textprogramm 9')
    doc.setProducer('Druckwerk 3')
  }
  if (xmp !== undefined) {
    const stream = doc.context.register(PDFRawStream.of(doc.context.obj({ Type: 'Metadata', Subtype: 'XML' }), new TextEncoder().encode(xmp)))
    doc.catalog.set(key('Metadata'), stream)
  }
  return doc.save({ useObjectStreams: false })
}

/** Independent reading through PDF.js and the raw bytes, not through our parser. */
async function independent(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice() })
  const document = await task.promise
  const { info, metadata } = await document.getMetadata()
  await task.destroy()
  return { info: info as Record<string, string>, xmp: metadata?.getRaw() ?? '', raw: new TextDecoder('latin1').decode(bytes) }
}

test('reads Info and XMP side by side, including Unicode', async () => {
  const metadata = await readMetadata(await pdf(FULL_XMP))
  expect(metadata.fields.title).toEqual({ info: 'Größenbericht', xmp: 'Größenbericht' })
  expect(metadata.fields.subject).toEqual({ info: 'Äpfel & Birnen', xmp: 'Äpfel & Birnen' })
  expect(metadata.fields.keywords.xmp).toBe('Obst, Bericht')
  expect(metadata.technical).toMatchObject({ creator: 'Textprogramm 9', producer: 'Druckwerk 3' })
  expect(metadata.xmpUnreadable).toBe(false)
})

test('empty fields are absent, not empty strings', async () => {
  const metadata = await readMetadata(await pdf(undefined, false))
  expect(metadata.fields.title).toEqual({ info: undefined, xmp: undefined })
  expect(effectiveField(metadata.fields.title)).toBe('')
})

test('a field stored only in XMP is found', async () => {
  const metadata = await readMetadata(await pdf(FULL_XMP, false))
  expect(metadata.fields.author).toEqual({ info: undefined, xmp: 'Mira Muster' })
  expect(effectiveField(metadata.fields.author)).toBe('Mira Muster')
})

test('reads the attribute form of XMP', async () => {
  const xmp = xmpPacket('').replace('rdf:about=""', 'rdf:about="" pdf:Keywords="Kurzform"')
  expect((await readMetadata(await pdf(xmp, false))).fields.keywords.xmp).toBe('Kurzform')
})

test('an unreadable XMP packet is reported, not treated as empty', async () => {
  expect((await readMetadata(await pdf('<kaputt'))).xmpUnreadable).toBe(true)
})

test('editing changes both representations, read independently', async () => {
  const { bytes, xmpRemoved } = await applyMetadata(await pdf(FULL_XMP), { fields: { title: 'Neuer Größentitel & mehr' } })
  expect(xmpRemoved).toBe(false)
  const read = await independent(bytes)
  expect(read.info.Title).toBe('Neuer Größentitel & mehr')
  expect(read.xmp).toContain('Neuer Größentitel &amp; mehr')
  expect(read.xmp).not.toContain('Größenbericht')
  expect(read.info.Author).toBe('Mira Muster')
  expect(read.xmp).toContain('Mira Muster')
})

test('removing a field empties both representations', async () => {
  const { bytes } = await applyMetadata(await pdf(FULL_XMP), { fields: { author: null } })
  const read = await independent(bytes)
  expect(read.info.Author).toBeUndefined()
  expect(read.xmp).not.toContain('Mira Muster')
  expect(read.raw).not.toContain('Mira Muster')
  expect(read.info.Title).toBe('Größenbericht')
})

test('removing keywords clears the XMP keyword list too', async () => {
  const { bytes } = await applyMetadata(await pdf(FULL_XMP), { fields: { keywords: null } })
  const read = await independent(bytes)
  expect(read.xmp).not.toContain('Obst')
  expect(read.info.Keywords).toBeUndefined()
})

test('an XMP packet that hides the value elsewhere is removed completely instead of reporting a fake removal', async () => {
  const xmp = xmpPacket('<dc:creator><rdf:Seq><rdf:li>Mira Muster</rdf:li></rdf:Seq></dc:creator><foo:copy xmlns:foo="urn:x">Mira Muster</foo:copy>')
  const { bytes, xmpRemoved } = await applyMetadata(await pdf(xmp), { fields: { author: null } })
  expect(xmpRemoved).toBe(true)
  const read = await independent(bytes)
  expect(read.xmp).toBe('')
  expect(read.raw).not.toContain('Mira Muster')
})

test('an unreadable packet goes completely when a field changes', async () => {
  const { bytes, xmpRemoved } = await applyMetadata(await pdf('<kaputt Mira Muster'), { fields: { author: null } })
  expect(xmpRemoved).toBe(true)
  expect((await independent(bytes)).raw).not.toContain('Mira Muster')
})

test('an old copy left unreferenced in the file does not survive', async () => {
  const doc = await PDFDocument.load(await pdf(undefined), { updateMetadata: false })
  doc.context.register(PDFRawStream.of(doc.context.obj({}), new TextEncoder().encode('Mira Muster, alte Fassung')))
  const { bytes } = await applyMetadata(await doc.save({ useObjectStreams: false }), { fields: { author: null } })
  expect((await independent(bytes)).raw).not.toContain('alte Fassung')
})

test('removing technical data leaves no software names or dates, and saving adds none back', async () => {
  const { bytes } = await applyMetadata(await pdf(FULL_XMP), { fields: {}, removeTechnical: true })
  const read = await independent(bytes)
  for (const name of ['Creator', 'Producer', 'CreationDate', 'ModDate']) expect(read.info[name]).toBeUndefined()
  for (const text of ['Textprogramm', 'Druckwerk', 'uuid:1234', '2024-01-02', 'pdf-lib']) expect(read.raw + read.xmp).not.toContain(text)
  const again = await PDFDocument.load(bytes, { updateMetadata: false })
  expect(new TextDecoder('latin1').decode(await again.save())).not.toContain('pdf-lib')
})

test('a document without XMP gets none, and one without Info gets one when needed', async () => {
  const { bytes } = await applyMetadata(await pdf(undefined, false), { fields: { title: 'Erster Titel' } })
  const read = await independent(bytes)
  expect(read.info.Title).toBe('Erster Titel')
  expect(read.xmp).toBe('')
})

test('other XMP content stays', async () => {
  const xmp = FULL_XMP.replace('</rdf:Description>', '<foo:Projekt xmlns:foo="urn:x">Alpha</foo:Projekt></rdf:Description>')
  const { bytes } = await applyMetadata(await pdf(xmp), { fields: { title: null } })
  expect((await independent(bytes)).xmp).toContain('Alpha')
})

test('a title containing the old value does not count as a surviving removal', async () => {
  const { bytes, xmpRemoved } = await applyMetadata(await pdf(FULL_XMP), { fields: { title: 'Größenbericht 2026' } })
  expect(xmpRemoved).toBe(false)
  expect((await independent(bytes)).info.Title).toBe('Größenbericht 2026')
})

test('page content is untouched', async () => {
  const { bytes } = await applyMetadata(await pdf(FULL_XMP), { fields: {}, removeTechnical: true })
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
})

test('the edit is one undo step, and undo restores the previous decision', () => {
  const state: EditorState = { overlays: [] }, stack = new CommandStack(state)
  stack.execute(setMetadataCommand(undefined, { fields: { title: 'A' } }))
  expect(state.metadata?.fields.title).toBe('A')
  stack.execute(setMetadataCommand(state.metadata, { fields: { title: null } }))
  stack.undo()
  expect(state.metadata?.fields.title).toBe('A')
  stack.undo()
  expect(state.metadata).toBeUndefined()
  stack.redo()
  expect(state.metadata?.fields.title).toBe('A')
})
