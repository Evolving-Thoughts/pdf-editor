import 'fake-indexeddb/auto'
import { expect, test } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib'
import { addOverlay, CommandStack, removeOverlay, updateOverlay } from '../../src/core/commands'
import { COMMENT_PIN_SIZE, commentExcerpt, createComment, documentComments, moveComment, placeComment } from '../../src/core/comments'
import { copyEditorState, type CommentOverlay, type EditorState, type Overlay } from '../../src/core/model'
import { nudgeCommand } from '../../src/core/overlayGesture'
import { rotatePages } from '../../src/core/pages'
import { loadDraft, openDraftDb, saveDraft } from '../../src/core/persistence/drafts'
import { exportPdf } from './exportFixture'

const page = { width: 600, height: 800 }

function comment(overrides: Partial<CommentOverlay> = {}): CommentOverlay {
  return { kind: 'comment', id: 'c1', pageId: 'p0', x: 100, y: 700, note: 'Bitte prüfen', createdAt: Date.UTC(2026, 10, 6, 9, 30), ...overrides }
}

test('a new comment starts empty and keeps its whole pin on the page', () => {
  const created = createComment('p0', { x: 595, y: 3 }, page, 42, 'id')
  expect(created).toEqual({ kind: 'comment', id: 'id', pageId: 'p0', x: page.width - COMMENT_PIN_SIZE, y: COMMENT_PIN_SIZE, note: '', createdAt: 42 })
  expect(placeComment({ x: -5, y: 900 }, page)).toEqual({ x: 0, y: 800 })
  expect(moveComment({ x: 100, y: 700 }, 10, -20, page)).toEqual({ x: 110, y: 680 })
})

test('adding, editing, moving and deleting comments are undoable steps', () => {
  const state: EditorState = { overlays: [] }
  const stack = new CommandStack(state)
  stack.execute(addOverlay(comment({ note: '' })))
  stack.execute(updateOverlay('c1', { note: '' }, { note: 'Neu' }))
  stack.execute(nudgeCommand(state.overlays[0], { dx: 1, dy: 0 }, page)!)
  expect(state.overlays[0]).toMatchObject({ note: 'Neu', x: 101 })
  stack.execute(removeOverlay(state.overlays[0]))
  expect(state.overlays).toEqual([])
  stack.undo()
  stack.undo()
  expect(state.overlays[0]).toMatchObject({ note: 'Neu', x: 100 })
  stack.undo()
  expect(state.overlays[0]).toMatchObject({ note: '' })
  stack.undo()
  expect(state.overlays).toEqual([])
})

test('the list shows comments in reading order with short excerpts', () => {
  const overlays: Overlay[] = [
    comment({ id: 'late', pageId: 'p1', y: 700 }),
    comment({ id: 'low', pageId: 'p0', y: 100 }),
    comment({ id: 'top', pageId: 'p0', y: 700 }),
    comment({ id: 'gone', pageId: 'deleted' }),
  ]
  const pages = [{ id: 'p0' }, { id: 'p1' }] as EditorState['pages']
  expect(documentComments({ overlays, pages }).map(c => c.id)).toEqual(['top', 'low', 'late'])
  expect(commentExcerpt('  Erste Zeile\nzweite')).toBe('Erste Zeile')
  expect(commentExcerpt('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`)
})

test('a comment follows its page when the page is rotated', () => {
  const state: EditorState = {
    overlays: [comment()],
    pages: [{ id: 'p0', name: 'Seite', sourceId: 'original', sourceIndex: 0, box: { x: 0, y: 0, width: 600, height: 800 }, unit: 1, rotation: 0 }] as EditorState['pages'],
  }
  new CommandStack(state).execute(rotatePages(state, ['p0'], true))
  expect(state.overlays[0]).toMatchObject({ kind: 'comment', x: 700, y: 500, note: 'Bitte prüfen' })
  expect(state.overlays[0].clips).toBeUndefined()
})

test('comments survive a draft save and restore', async () => {
  const db = await openDraftDb()
  const state: EditorState = { overlays: [comment()] }
  await saveDraft(db, { id: 'with-comment', name: 'a.pdf', createdAt: 1, pdfBytes: new ArrayBuffer(1), ...copyEditorState(state) })
  expect((await loadDraft(db, 'with-comment'))!.overlays).toEqual([comment()])
  db.close()
})

test('comments export as PDF text annotations, not as page content', async () => {
  const source = await PDFDocument.create()
  source.addPage([600, 800])
  const bytes = await exportPdf(await source.save(), [comment(), comment({ id: 'empty', note: '  ' })])
  const doc = await PDFDocument.load(bytes)
  const annots = doc.getPage(0).node.Annots()!
  expect(annots.size()).toBe(1)
  const note = doc.context.lookup(annots.get(0)) as PDFDict
  expect(note.get(PDFName.of('Subtype'))).toBe(PDFName.of('Text'))
  expect((note.get(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe('Bitte prüfen')
  expect((note.get(PDFName.of('NM')) as PDFHexString).decodeText()).toBe('c1')
  expect((note.get(PDFName.of('M')) as PDFString).decodeDate().getTime()).toBe(comment().createdAt)
  const rect = (note.get(PDFName.of('Rect')) as PDFArray).asArray().map(n => (n as PDFNumber).asNumber())
  expect(rect).toEqual([100, 700 - COMMENT_PIN_SIZE, 100 + COMMENT_PIN_SIZE, 700])
})

test('on a rotated page the annotation sits where the pin was shown', async () => {
  const source = await PDFDocument.create()
  source.addPage([600, 800]).setRotation({ type: 'degrees', angle: 90 } as never)
  // Displayed page is 800 wide and 600 high after the clockwise turn.
  const bytes = await exportPdf(await source.save(), [comment({ x: 100, y: 500 })])
  const doc = await PDFDocument.load(bytes)
  const note = doc.context.lookup(doc.getPage(0).node.Annots()!.get(0)) as PDFDict
  const rect = (note.get(PDFName.of('Rect')) as PDFArray).asArray().map(n => (n as PDFNumber).asNumber())
  // Displayed (x, y) maps to PDF (width - y, x) for a 90° page.
  expect(rect).toEqual([100, 100, 120, 120])
})
