import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { EditorState } from '../../../src/core/model'
import { DraftSaver } from '../../../src/core/persistence/draftSaver'
import { deleteDraft, listDrafts, loadDraft, openDraftDb } from '../../../src/core/persistence/drafts'

let state: EditorState, draft: { id: string; name: string; createdAt: number; bytes: ArrayBuffer } | null, saver: DraftSaver, db: IDBDatabase | undefined

beforeEach(async () => {
  state = { overlays: [] }
  draft = { id: 'd', name: 'd.pdf', createdAt: 1, bytes: new Uint8Array([1, 2, 3]).buffer }
  saver = new DraftSaver(async () => (db = await openDraftDb()), () => state, () => draft)
  await saver.queue(async open => { for (const { id } of await listDrafts(open)) await deleteDraft(open, id) })
})
afterEach(() => { vi.useRealTimers(); db?.close() })

test('work runs in turn, and a failure stays with its caller', async () => {
  const order: string[] = []
  const first = saver.queue(async () => { await new Promise(resolve => setTimeout(resolve, 5)); order.push('first'); throw new Error('voll') })
  const second = saver.queue(async () => { order.push('second'); return 2 })
  await expect(first).rejects.toThrow('voll')
  expect(await second).toBe(2)
  expect(order).toEqual(['first', 'second'])
})

test('a save describes the moment it was asked for', async () => {
  const saving = saver.save()
  state.overlays.push({ id: 's', pageId: 'p', points: [], color: '#000', width: 1 })
  await saving
  expect((await saver.queue(open => loadDraft(open, 'd')))!.overlays).toEqual([])
})

test('nothing is saved without an open draft', async () => {
  draft = null
  expect(await saver.save()).toBeNull()
})

test('a pause drops a save that was still waiting', async () => {
  const idle = () => {}
  let release = idle
  const blocked = saver.queue(() => new Promise<void>(resolve => { release = resolve }))
  const saving = saver.save()
  saver.pause()
  await vi.waitFor(() => expect(release).not.toBe(idle))
  release()
  await blocked
  expect(await saving).toBeNull()
  expect(await saver.queue(listDrafts)).toEqual([])
})

test('a save after a pause counts again', async () => {
  saver.pause()
  expect(await saver.save()).not.toBeNull()
})

test('deleting after an autosave leaves nothing behind', async () => {
  const saving = saver.save()
  const removing = saver.queue(open => deleteDraft(open, 'd'))
  await Promise.all([saving, removing])
  expect(await saver.queue(listDrafts)).toEqual([])
})

test('rapid changes end up as one save, and a pause or stop cancels it', () => {
  vi.useFakeTimers()
  const save = vi.fn()
  saver.saveSoon(save)
  vi.advanceTimersByTime(300)
  saver.saveSoon(save)
  vi.advanceTimersByTime(300)
  expect(save).not.toHaveBeenCalled()
  vi.advanceTimersByTime(200)
  expect(save).toHaveBeenCalledOnce()
  saver.saveSoon(save)
  saver.pause()
  saver.saveSoon(save)
  saver.stop()
  vi.advanceTimersByTime(1000)
  expect(save).toHaveBeenCalledOnce()
})
