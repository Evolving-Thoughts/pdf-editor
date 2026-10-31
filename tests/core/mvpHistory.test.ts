import 'fake-indexeddb/auto'
import { expect, test } from 'vitest'
import { addOverlay, updateOverlay } from '../../src/core/commands'
import { EditorStore } from '../../src/core/editorStore'
import {
  formKey,
  setNativeFieldValue,
  type NativeWidget,
} from '../../src/core/forms'
import type { Textbox } from '../../src/core/model'
import { movePage, rotatePage, type DocumentPage } from '../../src/core/pages'
import { replaceRedactions } from '../../src/core/redactions'
import {
  openDraftDb,
  saveDraft,
  loadDraft,
} from '../../src/core/persistence/drafts'
import { PNG_DATA_URL } from '../imageFixtures.js'

test('40 mixed actions undo and redo every exact state, including page order, forms and marks', async () => {
  const store = new EditorStore()
  const pages: DocumentPage[] = [0, 1, 2].map((i) => ({
    id: `p${i}`,
    name: `Page ${i}`,
    sourceId: 'source',
    sourceIndex: i,
    box: { x: 0, y: 0, width: 600, height: 800 },
    unit: 1,
    rotation: 0,
  }))
  store.restore({ overlays: [], pages: pages, pageSources: [
    { id: 'source', bytes: new Uint8Array([1, 2, 3]).buffer },
  ] })
  const field: NativeWidget = {
    id: 'field',
    key: formKey('source', 'Name'),
    name: 'Name',
    label: 'Name',
    kind: 'text',
    value: '',
    pageIndex: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    inputWidth: 100,
    inputHeight: 20,
    rotation: 0,
    readOnly: false,
    fontSize: 12,
    alignment: 'left',
  }
  const states = [structuredClone(store.state)]
  const execute = (command: Parameters<typeof store.dispatch>[0]) => {
    store.dispatch(command)
    states.push(structuredClone(store.state))
  }
  for (let i = 0; i < 4; i++) {
    const box: Textbox = {
      id: `text${i}`,
      pageId: 'p0',
      x: 40,
      y: 700,
      text: 'before',
      font: 'helvetica',
      fontSize: 14,
      bold: false,
      italic: false,
      underline: false,
    }
    execute(addOverlay(box))
    execute(updateOverlay(box.id, { text: 'before' }, { text: `after${i}` }))
    execute(
      addOverlay({
        id: `stroke${i}`,
        pageId: 'p1',
        points: [
          { x: 20, y: 30 },
          { x: 40, y: 50 },
        ],
        color: '#000000',
        width: 2,
      }),
    )
    execute(
      addOverlay({
        id: `shape${i}`,
        kind: 'shape',
        shape: 'rect',
        pageId: 'p1',
        x: 50,
        y: 60,
        width: 100,
        height: 50,
        rotation: 0,
        fill: '#ffffff',
        strokeColor: null,
        strokeWidth: 0,
      }),
    )
    execute(
      addOverlay({
        id: `image${i}`,
        kind: 'image',
        pageId: 'p2',
        x: 10,
        y: 10,
        width: 50,
        height: 50,
        lockAspectRatio: true,
        name: 'fixture.png',
        pixelWidth: 1,
        pixelHeight: 1,
        dataUrl: PNG_DATA_URL,
      }),
    )
    execute(rotatePage(store.state, 'p0', true))
    execute(movePage(store.state, 'p0', i % 2 ? 0 : 2))
    execute(setNativeFieldValue(store.state, field, `Value${i}`, `edit${i}`))
    execute(
      replaceRedactions(store.state, [
        {
          id: `mark${i}`,
          pageId: 'p1',
          x: 30,
          y: 40,
          width: 50,
          height: 20,
          fill: 'black',
        },
      ]),
    )
    execute(replaceRedactions(store.state, []))
  }
  expect(states).toHaveLength(41)
  for (let i = states.length - 2; i >= 0; i--) {
    store.undo()
    expect(store.state).toEqual(states[i])
  }
  expect(store.canUndo).toBe(false)
  for (let i = 1; i < states.length; i++) {
    store.redo()
    expect(store.state).toEqual(states[i])
  }
  // One record contains all four overlay kinds, edited native values and reordered pages.
  const db = await openDraftDb()
  try {
    const expected = structuredClone(store.state)
    await saveDraft(db, {
      id: 'mvp-combined',
      name: 'combined.pdf',
      createdAt: 1,
      pdfBytes: new Uint8Array([1, 2, 3]).buffer,
      overlays: expected.overlays,
      pages: expected.pages,
      pageSources: expected.pageSources,
      formValues: expected.formValues,
      redactions: expected.redactions,
    })
    db.close()
    const reopened = await openDraftDb()
    try {
      const draft = await loadDraft(reopened, 'mvp-combined')
      expect(draft).not.toBeNull()
      const fresh = new EditorStore()
      fresh.restore({ overlays: draft!.overlays, pages: draft!.pages, pageSources: draft!.pageSources, formValues: draft!.formValues, redactions: draft!.redactions })
      expect(fresh.state).toEqual(expected)
      expect(fresh.canUndo).toBe(false) // history is session-local, not persisted
    } finally {
      reopened.close()
    }
  } finally {
    db.close()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('pdf-editor-drafts')
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  expect(store.canRedo).toBe(false)
})
