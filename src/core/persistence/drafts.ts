// Draft persistence in IndexedDB (framework-free, ADR-004). A draft holds the
// original PDF bytes plus the full overlay state, so closing the tab and
// reopening restores everything. Multiple drafts live side by side.
import type { Overlay } from '../model'

export interface DraftRecord {
  id: string
  /** Display name, usually the original file name. */
  name: string
  createdAt: number
  updatedAt: number
  pdfBytes: ArrayBuffer
  overlays: Overlay[]
}

/** Draft metadata for the menu list; the heavy bytes stay outside this record. */
export interface DraftSummary {
  id: string
  name: string
  updatedAt: number
  sizeBytes: number
  overlayCount: number
}

/** Spec: files beyond this get a warning instead of silent slowness. */
export const DRAFT_SIZE_WARN_BYTES = 50 * 1024 * 1024

const DB_NAME = 'pdf-editor-drafts'
const STORE = 'drafts'
const BYTES_STORE = 'draft-bytes'
const DB_VERSION = 2

type StoredDraft = Omit<DraftRecord, 'pdfBytes'> & { sizeBytes: number }

export function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(BYTES_STORE)) {
        db.createObjectStore(BYTES_STORE)
      }

      // v1 stored metadata, overlays and the PDF bytes in one record. Split
      // existing rows so listing drafts never has to clone large PDF buffers.
      if (event.oldVersion < 2) {
        const transaction = request.transaction
        if (!transaction) return
        const drafts = transaction.objectStore(STORE)
        const bytesStore = transaction.objectStore(BYTES_STORE)
        const cursorRequest = drafts.openCursor()
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (!cursor) return
          const value = cursor.value as StoredDraft & { pdfBytes?: ArrayBuffer }
          if (value.pdfBytes) {
            bytesStore.put(value.pdfBytes, value.id)
            const { pdfBytes, ...metadata } = value
            const stored: StoredDraft = { ...metadata, sizeBytes: pdfBytes.byteLength }
            cursor.update(stored)
          }
          cursor.continue()
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function saveDraft(db: IDBDatabase, draft: Omit<DraftRecord, 'updatedAt'>): Promise<DraftRecord> {
  const record: DraftRecord = { ...draft, updatedAt: Date.now() }
  const { pdfBytes, ...metadata } = record
  const stored: StoredDraft = { ...metadata, sizeBytes: pdfBytes.byteLength }
  const transaction = db.transaction([STORE, BYTES_STORE], 'readwrite')
  transaction.objectStore(STORE).put(stored)
  transaction.objectStore(BYTES_STORE).put(pdfBytes, record.id)
  await transactionDone(transaction)
  return record
}

export async function loadDraft(db: IDBDatabase, id: string): Promise<DraftRecord | null> {
  const transaction = db.transaction([STORE, BYTES_STORE], 'readonly')
  const storedRequest = transaction.objectStore(STORE).get(id)
  const bytesRequest = transaction.objectStore(BYTES_STORE).get(id)
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      const stored = storedRequest.result as StoredDraft | undefined
      if (!stored) {
        resolve(null)
        return
      }
      resolve({
        id: stored.id,
        name: stored.name,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        overlays: stored.overlays,
        pdfBytes: (bytesRequest.result as ArrayBuffer | undefined) ?? new ArrayBuffer(0),
      })
    }
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function listDrafts(db: IDBDatabase): Promise<DraftSummary[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly')
    const recordsRequest = transaction.objectStore(STORE).getAll()
    transaction.oncomplete = () => {
      const records = recordsRequest.result as StoredDraft[]
      resolve(
        records
          .map((record) => ({
            id: record.id,
            name: record.name,
            updatedAt: record.updatedAt,
            sizeBytes: record.sizeBytes,
            overlayCount: record.overlays.length,
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      )
    }
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function deleteDraft(db: IDBDatabase, id: string): Promise<void> {
  const transaction = db.transaction([STORE, BYTES_STORE], 'readwrite')
  transaction.objectStore(STORE).delete(id)
  transaction.objectStore(BYTES_STORE).delete(id)
  await transactionDone(transaction)
}
