import { beforeEach, expect, test, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { addOverlay } from '../../src/core/commands'
import { DocumentSession, type DraftPorts, type FilePorts } from '../../src/core/documentSession'
import { EditorStore } from '../../src/core/editorStore'
import { movePage } from '../../src/core/pages'
import type { PdfHandle } from '../../src/core/pdf/loadPdf'
import { inspectPages } from '../../src/core/pdf/pageOperations'
import type { Textbox } from '../../src/core/model'
import type { DraftRecord } from '../../src/core/persistence/drafts'

const handle = () => ({ destroy: vi.fn(async () => undefined) }) as unknown as PdfHandle & { destroy: ReturnType<typeof vi.fn> }
const pdfBytes = async (pages = 2) => {
  const doc = await PDFDocument.create()
  for (let index = 0; index < pages; index++) doc.addPage([200, 300])
  return doc.save()
}
const file = async (name: string) => new File([(await pdfBytes()).slice()], name, { type: 'application/pdf' })
const box = (pageId: string): Textbox => ({ id: 't', pageId, x: 1, y: 1, text: 'x', font: 'helvetica', fontSize: 12, bold: false, italic: false, underline: false })

let store: EditorStore, handles: ReturnType<typeof handle>[], session: DocumentSession
const ports = (extra: Partial<FilePorts> = {}): FilePorts => ({ save: async () => undefined, beforeReplace: () => undefined, askPassword: async () => null, ...extra })
const flush = () => new Promise(resolve => setTimeout(resolve, 20))

beforeEach(() => {
  store = new EditorStore()
  handles = []
  session = new DocumentSession(store, async () => {
    const next = handle()
    handles.push(next)
    return next
  })
})

test('opening a file publishes it and releases the previous document once', async () => {
  expect(await session.openFile(await file('a.pdf'), ports())).toBe(true)
  const first = session.pdf
  expect(session.draft?.name).toBe('a.pdf')
  expect(store.state.pages).toHaveLength(2)
  expect(session.pagesStale).toBe(false)
  expect(session.busy).toBe(false)
  await session.openFile(await file('b.pdf'), ports())
  expect(session.pdf).not.toBe(first)
  expect(handles[0].destroy).toHaveBeenCalledOnce()
  expect(handles[1].destroy).not.toHaveBeenCalled()
})

test('a newer opening wins, and the older one leaves nothing behind', async () => {
  let release = () => {}
  const slow = session.openFile(await file('slow.pdf'), ports({ save: () => new Promise<void>(resolve => { release = resolve }) }))
  const fast = await file('fast.pdf')
  expect(await session.openFile(fast, ports())).toBe(true)
  release()
  expect(await slow).toBe(false)
  expect(session.draft?.name).toBe('fast.pdf')
  expect(session.busy).toBe(false)
  expect(handles).toHaveLength(1)
})

test('the lock holds until the last opening is done', async () => {
  let release = () => {}
  const first = session.openFile(await file('a.pdf'), ports({ save: () => new Promise<void>(resolve => { release = resolve }) }))
  expect(session.running('opening')).toBe(true)
  const second = session.openFile(await file('b.pdf'), ports({ save: async () => { await flush() } }))
  release()
  await first
  expect(session.running('opening')).toBe(true)
  await second
  expect(session.running('opening')).toBe(false)
})

test('a failed opening keeps the open document and reports the problem', async () => {
  await session.openFile(await file('a.pdf'), ports())
  const before = session.draft
  await expect(session.openFile(new File([new Uint8Array([1, 2, 3])], 'kaputt.pdf'), ports())).rejects.toThrow()
  expect(session.draft).toBe(before)
  expect(session.busy).toBe(false)
  await expect(session.openFile(await file('c.pdf'), ports({ save: async () => { throw new Error('voll') } }))).rejects.toThrow('voll')
  expect(session.draft).toBe(before)
})

test('a failure of an outdated opening is not reported', async () => {
  let fail: (problem: Error) => void = () => {}
  const old = session.openFile(await file('a.pdf'), ports({ save: () => new Promise<void>((_, reject) => { fail = reject }) }))
  await session.openFile(await file('b.pdf'), ports())
  fail(new Error('zu spät'))
  expect(await old).toBe(false)
})

test('saving is paused before the new document enters the store', async () => {
  const seen: unknown[] = []
  await session.openFile(await file('a.pdf'), ports({ beforeReplace: () => seen.push(store.state.pages) }))
  expect(seen).toEqual([undefined])
})

test('an activity notices when the document or its state moved on', async () => {
  await session.openFile(await file('a.pdf'), ports())
  const page = store.state.pages![0].id
  const edited = session.begin('redacting')
  expect(session.busy).toBe(true)
  expect(edited.sameState()).toBe(true)
  store.dispatch(addOverlay(box(page)))
  expect(edited.sameState()).toBe(false)
  expect(edited.sameDocument()).toBe(true)
  edited.finish()
  expect(session.busy).toBe(false)
  const replaced = session.watch()
  await session.openFile(await file('b.pdf'), ports())
  expect(replaced.sameDocument()).toBe(false)
  expect(replaced.sameState()).toBe(false)
})

test('a page change makes the view stale until the viewer shows it', async () => {
  await session.openFile(await file('a.pdf'), ports())
  const [first, second] = store.state.pages!
  store.dispatch(movePage(store.state, second.id, 0))
  expect(session.pagesStale).toBe(true)
  const shown = session.pdf
  session.refreshPages(problem => { throw problem })
  await vi.waitFor(() => expect(session.pagesStale).toBe(false))
  expect(session.pdf).not.toBe(shown)
  expect(handles[0].destroy).toHaveBeenCalledOnce()
  expect(store.state.pages![1].id).toBe(first.id)
})

test('an abandoned page rebuild does not reach the viewer', async () => {
  await session.openFile(await file('a.pdf'), ports())
  store.dispatch(movePage(store.state, store.state.pages![1].id, 0))
  const shown = session.pdf
  session.refreshPages(() => undefined)()
  await vi.waitFor(() => expect(handles).toHaveLength(2))
  await flush()
  expect(session.pdf).toBe(shown)
  expect(handles[1].destroy).toHaveBeenCalledOnce()
  expect(session.pagesStale).toBe(true)
})

test('deleting pauses saving; a failed delete resumes the same draft, a success closes', async () => {
  await session.openFile(await file('a.pdf'), ports())
  const running = session.watch()
  const draft = session.suspend()!
  expect(session.draft).toBeNull()
  expect(session.activeDraftId).toBe(draft.id)
  expect(running.sameDocument()).toBe(false)
  session.resume(draft)
  expect(session.draft).toBe(draft)
  const shown = handles[0]
  session.close()
  expect([session.pdf, session.draft, session.activeDraftId, session.original]).toEqual([null, null, null, null])
  expect(store.state.pages).toBeUndefined()
  expect(shown.destroy).toHaveBeenCalledOnce()
})

test('opening a draft reports a missing one and an outdated one', async () => {
  const draftPorts = (read: DraftPorts['read']): DraftPorts => ({ save: async () => undefined, beforeReplace: () => undefined, read })
  expect(await session.openDraft('weg', draftPorts(async () => null))).toBe('missing')
  expect(session.loadingDraftId).toBeNull()
  const bytes = await pdfBytes()
  const record: DraftRecord = { id: 'd', name: 'd.pdf', createdAt: 1, updatedAt: 2, overlays: [], pages: await inspectPages(bytes, 'd.pdf'), pageSources: [], pdfBytes: bytes.slice().buffer as ArrayBuffer }
  const opening = session.openDraft('d', draftPorts(async () => record))
  expect(session.loadingDraftId).toBe('d')
  expect(await opening).toBe('opened')
  expect(session.activeDraftId).toBe('d')
  let release: (record: DraftRecord) => void = () => {}
  const old = session.openDraft('d', draftPorts(() => new Promise(resolve => { release = resolve })))
  await session.openFile(await file('a.pdf'), ports())
  release(record)
  expect(await old).toBe('outdated')
  expect(session.draft?.name).toBe('a.pdf')
})

test('after disposal nothing publishes, and the document is released', async () => {
  await session.openFile(await file('a.pdf'), ports())
  let release = () => {}
  const opening = session.openFile(await file('b.pdf'), ports({ save: () => new Promise<void>(resolve => { release = resolve }) }))
  session.dispose()
  release()
  expect(await opening).toBe(false)
  expect(handles[0].destroy).toHaveBeenCalledOnce()
  expect(session.draft?.name).toBe('a.pdf')
})
