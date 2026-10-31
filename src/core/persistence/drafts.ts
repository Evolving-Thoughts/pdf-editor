import type { Redaction } from '../redactions'
import type { FormValues } from '../forms'
import type { DocumentPage, PageSource } from '../pages'
// Draft persistence in IndexedDB (framework-free, ADR-004). A draft holds the
// original PDF bytes plus the full overlay state, so closing the tab and
// reopening restores everything. Multiple drafts live side by side.
import { isImage, type ImageOverlay, type Overlay } from '../model'
import type { MetadataEdit } from '../pdf/metadata'

export interface DraftRecord {
  redactionApplied?: boolean
  redactions?: Redaction[]
  formValues?: FormValues
  id: string
  /** Display name, usually the original file name. */
  name: string
  createdAt: number
  updatedAt: number
  pdfBytes: ArrayBuffer
  overlays: Overlay[]
  pages?: DocumentPage[]
  pageSources?: PageSource[]
  metadata?: MetadataEdit
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
const ASSETS_STORE = 'image-assets'
const DB_VERSION = 3

type StoredImage = Omit<ImageOverlay, 'dataUrl'> & { imageAssetKey: string[] }
type StoredOverlay = Exclude<Overlay, ImageOverlay> | StoredImage
type StoredDraft = Omit<DraftRecord, 'pdfBytes' | 'overlays' | 'pageSources'> & { sizeBytes: number; overlays: StoredOverlay[]; pageSourceIds?: string[] }
interface ImageAsset { key: string[]; draftId: string; dataUrl: string }
const isStoredImage = (overlay: StoredOverlay): overlay is StoredImage => 'imageAssetKey' in overlay

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

      if (!db.objectStoreNames.contains(ASSETS_STORE)) {
        const assets = db.createObjectStore(ASSETS_STORE, { keyPath: 'key' })
        assets.createIndex('draftId', 'draftId')
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
  const { pdfBytes, overlays, pageSources, ...metadata } = record
  const transaction = db.transaction([STORE, BYTES_STORE, ASSETS_STORE], 'readwrite')
  const assets = transaction.objectStore(ASSETS_STORE)
  const storedOverlays: StoredOverlay[] = overlays.map((overlay) => {
    if (!isImage(overlay)) return overlay
    const { dataUrl, ...imageMetadata } = overlay
    const imageAssetKey = [record.id, overlay.id]
    const existing = assets.getKey(imageAssetKey)
    existing.onsuccess = () => {
      // Source is immutable across moves/resizes; autosave only rewrites geometry.
      if (existing.result === undefined) assets.put({ key: imageAssetKey, draftId: record.id, dataUrl })
    }
    return { ...imageMetadata, imageAssetKey }
  })
  // Prune only this draft, atomically with its new metadata. Key cursors avoid
  // cloning large data URLs just to decide whether an asset is still referenced.
  const referencedIds = new Set(overlays.filter(isImage).map(image => image.id))
  const unusedAssets = assets.index('draftId').openKeyCursor(record.id)
  unusedAssets.onsuccess = () => {
    const cursor = unusedAssets.result
    if (!cursor) return
    const key = cursor.primaryKey as string[]
    if (!referencedIds.has(key[1])) assets.delete(cursor.primaryKey)
    cursor.continue()
  }
  const activeSources=(pageSources??[]).filter(source=>metadata.pages?.some(p=>p.sourceId===source.id))
  const stored: StoredDraft = { ...metadata, overlays: storedOverlays,
    pageSourceIds: activeSources.map(s=>s.id),
    sizeBytes: pdfBytes.byteLength + activeSources.reduce((total,s)=>total+s.bytes.byteLength,0) }
  transaction.objectStore(STORE).put(stored)
  const bytesStore = transaction.objectStore(BYTES_STORE)
  const existingBytesKey = bytesStore.getKey(record.id)
  existingBytesKey.onsuccess = () => {
    // PDF bytes are immutable for a draft ID. Autosave therefore updates the
    // lightweight metadata record only after the first write.
    if (existingBytesKey.result === undefined) bytesStore.put(pdfBytes, record.id)
  }
  for(const source of activeSources){
    const key=[record.id,source.id], existing=bytesStore.getKey(key)
    existing.onsuccess=()=>{if(existing.result===undefined)bytesStore.put(source.bytes,key)}
  }
  const sourceCursor=bytesStore.openKeyCursor(IDBKeyRange.bound([record.id],[record.id,[]]))
  sourceCursor.onsuccess=()=>{const c=sourceCursor.result;if(!c)return
    if(!activeSources.some(s=>s.id===(c.primaryKey as string[])[1]))bytesStore.delete(c.primaryKey)
    c.continue()
  }
  await transactionDone(transaction)
  return record
}

export async function loadDraft(db: IDBDatabase, id: string): Promise<DraftRecord | null> {
  const transaction = db.transaction([STORE, BYTES_STORE, ASSETS_STORE], 'readonly')
  const storedRequest = transaction.objectStore(STORE).get(id)
  const bytesRequest = transaction.objectStore(BYTES_STORE).get(id)
  const sourceRequests = new Map<string, IDBRequest<ArrayBuffer | undefined>>()
  const assetRequests = new Map<string, IDBRequest<ImageAsset | undefined>>()
  storedRequest.onsuccess = () => {
    const stored = storedRequest.result as StoredDraft | undefined
    for(const id of stored?.pageSourceIds??[])sourceRequests.set(id,transaction.objectStore(BYTES_STORE).get([stored!.id,id]))
    for (const overlay of stored?.overlays ?? []) {
      if (isStoredImage(overlay)) assetRequests.set(overlay.id, transaction.objectStore(ASSETS_STORE).get(overlay.imageAssetKey))
    }
  }
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      const stored = storedRequest.result as StoredDraft | undefined
      if (!stored) {
        resolve(null)
        return
      }
      if (stored.overlays.some((overlay) => isStoredImage(overlay) && !assetRequests.get(overlay.id)?.result)) {
        reject(new Error('Bilddaten im Entwurf fehlen.'))
        return
      }
      if([...sourceRequests.values()].some(r=>!r.result)) { reject(new Error('Quelldaten einer Seite im Entwurf fehlen.'));return }
      const overlays: Overlay[] = stored.overlays.map((overlay) => {
        if (!isStoredImage(overlay)) return overlay
        const { imageAssetKey, ...imageMetadata } = overlay
        void imageAssetKey
        return { ...imageMetadata, dataUrl: assetRequests.get(overlay.id)!.result!.dataUrl }
      })
      resolve({
        id: stored.id,
        name: stored.name,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        overlays,
        formValues: stored.formValues,
        redactionApplied: stored.redactionApplied,
        redactions: stored.redactions,
        pages: stored.pages,
        metadata: stored.metadata,
        pageSources: [...sourceRequests].map(([id,request])=>({id,bytes:request.result!})),
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
  const transaction = db.transaction([STORE, BYTES_STORE, ASSETS_STORE], 'readwrite')
  transaction.objectStore(STORE).delete(id)
  transaction.objectStore(BYTES_STORE).delete(id)
  const sources=transaction.objectStore(BYTES_STORE).openKeyCursor(IDBKeyRange.bound([id],[id,[]]))
  sources.onsuccess=()=>{const c=sources.result;if(c){transaction.objectStore(BYTES_STORE).delete(c.primaryKey);c.continue()}}
  const cursorRequest = transaction.objectStore(ASSETS_STORE).index('draftId').openCursor(IDBKeyRange.only(id))
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (cursor) { cursor.delete(); cursor.continue() }
  }
  await transactionDone(transaction)
}
