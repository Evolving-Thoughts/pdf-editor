import 'fake-indexeddb/auto'
import { afterEach, expect, test } from 'vitest'
import {
  deleteDraft,
  DRAFT_SIZE_WARN_BYTES,
  listDrafts,
  loadDraft,
  openDraftDb,
  saveDraft,
} from '../../../src/core/persistence/drafts'
import type { Textbox } from '../../../src/core/model'

function sampleOverlays(): Textbox[] {
  return [
    { id: 'a', pageIndex: 0, x: 50, y: 700, text: 'Hallo', font: 'helvetica', fontSize: 14, bold: false, italic: false, underline: false },
    { id: 'b', pageIndex: 1, x: 100, y: 400, text: '✓', font: 'zapfdingbats', fontSize: 20, bold: false, italic: false, underline: false },
  ]
}

// fake-indexeddb keeps databases across tests in one file: close every
// handle first, otherwise deleteDatabase blocks forever.
const openDbs: IDBDatabase[] = []

async function openDb(): Promise<IDBDatabase> {
  const db = await openDraftDb()
  openDbs.push(db)
  return db
}

afterEach(async () => {
  for (const db of openDbs) db.close()
  openDbs.length = 0
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('pdf-editor-drafts')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
})

function sampleDraft(id: string) {
  return {
    id,
    name: `formular-${id}.pdf`,
    createdAt: 1000,
    pdfBytes: new TextEncoder().encode(`%PDF-fake-${id}`).buffer as ArrayBuffer,
    overlays: sampleOverlays(),
  }
}

test('a saved draft round-trips with pdf bytes and overlays intact', async () => {
  const db = await openDb()
  await saveDraft(db, sampleDraft('one'))

  const loaded = await loadDraft(db, 'one')
  expect(loaded).not.toBeNull()
  expect(loaded!.name).toBe('formular-one.pdf')
  expect(new TextDecoder().decode(loaded!.pdfBytes)).toBe('%PDF-fake-one')
  expect(loaded!.overlays).toEqual(sampleOverlays())
  expect(loaded!.createdAt).toBe(1000)
  expect(loaded!.updatedAt).toBeGreaterThan(0)
})

test('saving the same draft again updates it in place and refreshes updatedAt', async () => {
  const db = await openDb()
  await saveDraft(db, sampleDraft('one'))
  const first = (await loadDraft(db, 'one'))!.updatedAt

  await new Promise((r) => setTimeout(r, 5))
  const updated = { ...sampleDraft('one'), overlays: [] }
  await saveDraft(db, updated)

  const list = await listDrafts(db)
  expect(list).toHaveLength(1)
  const reloaded = (await loadDraft(db, 'one'))!
  expect(reloaded.overlays).toEqual([])
  expect(reloaded.updatedAt).toBeGreaterThanOrEqual(first)
  expect(reloaded.createdAt).toBe(1000)
})

test('saving an existing draft does not rewrite its immutable PDF bytes', async () => {
  const db = await openDb()
  const originalPut = IDBObjectStore.prototype.put
  let byteWrites = 0
  IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
    if (this.name === 'draft-bytes') byteWrites += 1
    return originalPut.call(this, value, key)
  }

  try {
    await saveDraft(db, sampleDraft('one'))
    expect(byteWrites).toBe(1)
    await saveDraft(db, { ...sampleDraft('one'), overlays: [] })
    expect(byteWrites).toBe(1)
  } finally {
    IDBObjectStore.prototype.put = originalPut
  }

  const loaded = await loadDraft(db, 'one')
  expect(loaded).not.toBeNull()
  expect(new TextDecoder().decode(loaded!.pdfBytes)).toBe('%PDF-fake-one')
  expect(loaded!.overlays).toEqual([])
})

test('listDrafts summarizes multiple drafts newest first, without loading bytes', async () => {
  const db = await openDb()
  await saveDraft(db, sampleDraft('a'))
  await new Promise((r) => setTimeout(r, 5))
  await saveDraft(db, sampleDraft('b'))

  const list = await listDrafts(db)
  expect(list.map((d) => d.id)).toEqual(['b', 'a'])
  expect(list[0].name).toBe('formular-b.pdf')
  expect(list[0].sizeBytes).toBeGreaterThan(0)
  expect(list[0].overlayCount).toBe(2)
  expect('pdfBytes' in list[0]).toBe(false)
})

test('openDraftDb migrates v1 records by splitting PDF bytes from metadata', async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('pdf-editor-drafts', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts', { keyPath: 'id' })
    }
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('drafts', 'readwrite')
      transaction.objectStore('drafts').put({ ...sampleDraft('legacy'), updatedAt: 1234 })
      transaction.oncomplete = () => {
        db.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  })

  const db = await openDb()
  expect(db.objectStoreNames.contains('draft-bytes')).toBe(true)
  const loaded = await loadDraft(db, 'legacy')
  expect(loaded).not.toBeNull()
  expect(new TextDecoder().decode(loaded!.pdfBytes)).toBe('%PDF-fake-legacy')
  expect(loaded!.overlays).toEqual(sampleOverlays())
  const list = await listDrafts(db)
  expect(list).toHaveLength(1)
  expect(list[0].sizeBytes).toBeGreaterThan(0)
})

test('loadDraft returns null and deleteDraft removes for unknown ids', async () => {
  const db = await openDb()
  await saveDraft(db, sampleDraft('a'))
  await deleteDraft(db, 'a')
  expect(await loadDraft(db, 'a')).toBeNull()
  expect(await listDrafts(db)).toHaveLength(0)
  expect(await loadDraft(db, 'never-existed')).toBeNull()
})

test('the size warning threshold is 50 MB', () => {
  expect(DRAFT_SIZE_WARN_BYTES).toBe(50 * 1024 * 1024)
})
