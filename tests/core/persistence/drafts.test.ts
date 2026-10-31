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
import { copyEditorState, type EditorState, type Textbox } from '../../../src/core/model'

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

/** Required: a new state field fails to compile here until the test covers it. */
function fullState(): Required<EditorState> {
  return {
    redactionApplied: true,
    redactions: [{ id: 'mark', pageId: 'p', x: 1, y: 2, width: 3, height: 4, fill: 'black' }] as Required<EditorState>['redactions'],
    formValues: { field: 'Wert' },
    pages: [{ id: 'p', name: 'Seite', sourceId: 'extra', sourceIndex: 0, box: { x: 0, y: 0, width: 10, height: 20 }, unit: 1, rotation: 0, ocr: [{ text: 'Wort', x: 1, y: 2, dx: 3, dy: 0, height: 4 }] }] as Required<EditorState>['pages'],
    pageSources: [{ id: 'extra', bytes: new TextEncoder().encode('%PDF-extra').buffer as ArrayBuffer }],
    overlays: sampleOverlays(),
    metadata: { fields: { author: null }, removeTechnical: true },
  }
}

test('the whole editing state survives a copy, a draft and a restore', async () => {
  const state = fullState(), db = await openDb()
  expect(copyEditorState(state)).toEqual(state)
  await saveDraft(db, { id: 'full', name: 'a.pdf', createdAt: 1, pdfBytes: new ArrayBuffer(1), ...copyEditorState(state) })
  const store = new EditorStore()
  store.restore((await loadDraft(db, 'full'))!)
  expect(store.state).toEqual(state)
})

test('a copied state shares nothing that can be edited', () => {
  const state = fullState(), copy = copyEditorState(state)
  copy.overlays[0].x = 999
  copy.pages[0].rotation = 90
  copy.metadata!.fields.title = 'Neu'
  expect(state).toEqual(fullState())
})

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

import type { ImageOverlay } from '../../../src/core/model'
import { PNG_DATA_URL } from '../../imageFixtures.js'
const image: ImageOverlay = { kind: 'image', id: 'image', pageIndex: 1, x: 40, y: 50, width: 120, height: 60,
  lockAspectRatio: true, name: 'logo.png', pixelWidth: 120, pixelHeight: 60, dataUrl: PNG_DATA_URL }

test('image source is stored outside draft listing metadata and restored after reopening', async () => {
  const db = await openDb()
  await saveDraft(db, { ...sampleDraft('images'), overlays: [image] })
  const transaction = db.transaction('drafts', 'readonly')
  const request = transaction.objectStore('drafts').get('images')
  await new Promise<void>((resolve) => { transaction.oncomplete = () => resolve() })
  expect(JSON.stringify(request.result)).not.toContain(PNG_DATA_URL)
  db.close()
  const reopened = await openDb()
  expect((await loadDraft(reopened, 'images'))!.overlays).toEqual([image])
  expect(await listDrafts(reopened)).toHaveLength(1)
  await saveDraft(reopened, { ...sampleDraft('images'), overlays: [{ ...image, x: 200 }] })
  expect((await loadDraft(reopened, 'images'))!.overlays[0]).toEqual({ ...image, x: 200 })
})

test('deleting one draft deletes only its image assets; missing assets fail rather than losing images', async () => {
  const db = await openDb()
  await saveDraft(db, { ...sampleDraft('one'), overlays: [image] })
  await saveDraft(db, { ...sampleDraft('two'), overlays: [image] })
  await deleteDraft(db, 'one')
  expect((await loadDraft(db, 'two'))!.overlays).toEqual([image])
  const tx = db.transaction('image-assets', 'readwrite')
  const request = tx.objectStore('image-assets').getAll()
  await new Promise<void>((resolve) => { tx.oncomplete = () => resolve() })
  expect(request.result).toHaveLength(1)
  expect(request.result[0].draftId).toBe('two')
  const remove = db.transaction('image-assets', 'readwrite')
  remove.objectStore('image-assets').clear()
  await new Promise<void>((resolve) => { remove.oncomplete = () => resolve() })
  await expect(loadDraft(db, 'two')).rejects.toThrow('Bilddaten')
})

test('v2 text/stroke drafts migrate to v3 without data loss', async () => {
  const legacy = { ...sampleDraft('v2'), updatedAt: 123 }
  const stroke = { id: 'line', pageIndex: 1, color: '#111111', width: 3, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('pdf-editor-drafts', 2)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts', { keyPath: 'id' })
      request.result.createObjectStore('draft-bytes')
    }
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(['drafts', 'draft-bytes'], 'readwrite')
      const { pdfBytes, ...metadata } = legacy
      tx.objectStore('drafts').put({ ...metadata, sizeBytes: pdfBytes.byteLength, overlays: [...legacy.overlays, stroke] })
      tx.objectStore('draft-bytes').put(pdfBytes, 'v2')
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    request.onerror = () => reject(request.error)
  })
  const db = await openDb()
  expect(db.version).toBe(3)
  expect((await loadDraft(db, 'v2'))!.overlays).toEqual([...legacy.overlays, stroke])
  expect((await loadDraft(db, 'v2'))!.pdfBytes).toEqual(legacy.pdfBytes)
  await saveDraft(db, { ...legacy, overlays: [...legacy.overlays, stroke, image] })
  expect((await loadDraft(db, 'v2'))!.overlays).toEqual([...legacy.overlays, stroke, image])
})

test('arbitrary image angles survive draft save, reopen and geometry edits', async () => {
  const db = await openDb()
  const rotated = { ...image, rotation: 37.5 }
  await saveDraft(db, { ...sampleDraft('angle'), overlays: [rotated] })
  db.close()
  const reopened = await openDb()
  expect((await loadDraft(reopened, 'angle'))!.overlays).toEqual([rotated])
  await saveDraft(reopened, { ...sampleDraft('angle'), overlays: [{ ...rotated, rotation: 270, x: 150 }] })
  expect((await loadDraft(reopened, 'angle'))!.overlays).toEqual([{ ...rotated, rotation: 270, x: 150 }])
})

async function imageAssetKeys(db: IDBDatabase): Promise<IDBValidKey[]> {
  const tx = db.transaction('image-assets', 'readonly')
  const request = tx.objectStore('image-assets').getAllKeys()
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = () => reject(tx.error)
  })
}

test('autosave prunes deleted image assets only in this draft, retaining referenced and other-draft assets', async () => {
  const db = await openDb()
  const keep = { ...image, id: 'keep' }
  await saveDraft(db, { ...sampleDraft('one'), overlays: [image, keep] })
  await saveDraft(db, { ...sampleDraft('two'), overlays: [image] })
  await saveDraft(db, { ...sampleDraft('one'), overlays: [keep] })
  expect(await imageAssetKeys(db)).toEqual([['one', 'keep'], ['two', 'image']])
  expect((await loadDraft(db, 'one'))!.overlays).toEqual([keep])
  expect((await loadDraft(db, 'two'))!.overlays).toEqual([image])
})

import { EditorStore } from '../../../src/core/editorStore'
import { removeImage } from '../../../src/core/commands'
test('undo after a persisted deletion rewrites the pruned source and restores exact image geometry', async () => {
  const db = await openDb(), store = new EditorStore()
  const original = { ...image, rotation: 37.5 }
  store.restore({ overlays: [original] })
  await saveDraft(db, { ...sampleDraft('undo'), overlays: store.state.overlays })
  store.dispatch(removeImage(original))
  await saveDraft(db, { ...sampleDraft('undo'), overlays: store.state.overlays })
  expect(await imageAssetKeys(db)).toEqual([])
  store.undo()
  await saveDraft(db, { ...sampleDraft('undo'), overlays: store.state.overlays })
  expect(await imageAssetKeys(db)).toEqual([['undo', 'image']])
  db.close()
  expect((await loadDraft(await openDb(), 'undo'))!.overlays).toEqual([original])
})

test('repeated add/delete/save cycles cannot accumulate orphaned image asset rows', async () => {
  const db = await openDb()
  for (let n = 0; n < 8; n++) {
    await saveDraft(db, { ...sampleDraft('cycles'), overlays: [{ ...image, id: `image-${n}` }] })
    expect(await imageAssetKeys(db)).toHaveLength(1)
    await saveDraft(db, { ...sampleDraft('cycles'), overlays: [] })
    expect(await imageAssetKeys(db)).toEqual([])
  }
  expect((await loadDraft(db, 'cycles'))!.overlays).toEqual([])
})

test('shape drafts retain styles, rotation and independent normalized marker samples', async () => {
  const { createShape } = await import('../../../src/core/shapes')
  const marker = createShape('marker',[{x:40,y:50},{x:80,y:90}],0,{fill:null,strokeColor:'#ffe34d',strokeWidth:24},'marker')!
  marker.rotation=37.5
  const shape = createShape('ellipse',[{x:100,y:100},{x:200,y:250}],1,{fill:'#ffffff',strokeColor:null,strokeWidth:3},'ellipse')!
  const db=await openDb(); const expected=structuredClone([marker,shape])
  await saveDraft(db,{...sampleDraft('shapes'),overlays:[marker,shape]})
  marker.markerPoints![0].x=.9
  const loaded=await loadDraft(db,'shapes'); expect(loaded!.overlays).toEqual(expected)
})

test('page order, crop, rotation and inserted PDF sources survive saving and reopening',async()=>{
 const db=await openDb()
 const original=sampleDraft('pages')
 const page={id:'page',name:'Anlage',sourceId:'extra',sourceIndex:0,box:{x:10,y:20,width:100,height:150},unit:2,rotation:90}
 await saveDraft(db,{...original,pages:[page],pageSources:[{id:'extra',bytes:new Uint8Array([1,2,3]).buffer}]})
 const loaded=await loadDraft(db,'pages')
 expect(loaded!.pages).toEqual([page])
 expect(loaded!.pageSources).toEqual([{id:'extra',bytes:new Uint8Array([1,2,3]).buffer}])
 // Metadata updates cannot replace immutable source bytes.
 await saveDraft(db,{...original,pages:[{...page,rotation:180}],pageSources:[{id:'extra',bytes:new Uint8Array([9]).buffer}]})
 expect((await loadDraft(db,'pages'))!.pageSources![0].bytes).toEqual(new Uint8Array([1,2,3]).buffer)
 await deleteDraft(db,'pages');expect(await loadDraft(db,'pages')).toBeNull()
})

test('stores native form values and overlays together and reads older drafts without form values', async () => {
  const db = await openDb(), draft = sampleDraft('native-form')
  const values = { '["original","name"]': 'Grace', '["original","agree"]': true, '["original","choice"]': ['Two', 'Three'] }
  await saveDraft(db, { ...draft, formValues: values })
  const loaded = await loadDraft(db, draft.id)
  expect(loaded?.formValues).toEqual(values); expect(loaded?.overlays).toEqual(draft.overlays)
  await saveDraft(db, sampleDraft('old-format')); expect((await loadDraft(db, 'old-format'))?.formValues).toBeUndefined()
})

test('drafts restore pending redaction geometry without treating it as an exported overlay',async()=>{
 const db=await openDb(),draft=sampleDraft('pending-redaction'),redactions=[{id:'r',pageId:'p',x:10,y:20,width:30,height:40,fill:'white' as const}]
 await saveDraft(db,{...draft,redactions})
 expect((await loadDraft(db,draft.id))?.redactions).toEqual(redactions)
})

test('secure export mode survives saving even after all rasterized pages were deleted',async()=>{
 const db=await openDb(),draft=sampleDraft('applied-redaction')
 await saveDraft(db,{...draft,redactionApplied:true,pages:[],pageSources:[],redactions:[]})
 expect((await loadDraft(db,draft.id))?.redactionApplied).toBe(true)
 await saveDraft(db,{...draft,redactionApplied:undefined})
 expect((await loadDraft(db,draft.id))?.redactionApplied).toBeUndefined()
})
