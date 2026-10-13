import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { addImage, clearDrawing, nudgeImage, nudgeShape, nudgeTextbox, removeImage, removeShape, removeTextbox } from '../core/commands'
import { EditorStore } from '../core/editorStore'
import { cloneOverlay, createId, isImage, isMarker, isShape, isStroke, isTextbox } from '../core/model'
import {
  deleteDraft,
  DRAFT_SIZE_WARN_BYTES,
  listDrafts,
  loadDraft,
  openDraftDb,
  saveDraft,
  type DraftRecord,
  type DraftSummary,
} from '../core/persistence/drafts'
import { loadPdf, type PdfHandle } from '../core/pdf/loadPdf'
import { importImage } from '../core/images/importImage'
import { imageGeometry, initialImageGeometry, moveImage } from '../core/images/geometry'
import { shapeGeometry, moveShape, type ShapeStyle } from '../core/shapes'
import { ShapeToolbar } from './ShapeToolbar'
import { SHAPE_TOOLS } from './tools'
import { zoomIn, zoomOut } from '../core/viewerState'
import { DraftsMenu } from './DraftsMenu'
import { DrawingToolbar } from './DrawingToolbar'
import { PageView } from './PageView'
import { SymbolPicker } from './SymbolPicker'
import type { Tool } from './tools'
import './app.css'

interface ActiveDraft {
  id: string
  name: string
  createdAt: number
  bytes: ArrayBuffer
}

function draftSummary(record: DraftRecord): DraftSummary {
  return {
    id: record.id,
    name: record.name,
    updatedAt: record.updatedAt,
    sizeBytes: record.pdfBytes.byteLength,
    overlayCount: record.overlays.length,
  }
}

export default function App() {
  const [pdf, setPdf] = useState<PdfHandle | null>(null)
  const [zoom, setZoom] = useState(1)
  const [tool, setTool] = useState<Tool>('select')
  const [symbol, setSymbol] = useState('✓')
  const [strokeColor, setStrokeColor] = useState('#111111')
  const [strokeWidth, setStrokeWidth] = useState(3)
  const [shapeStyle,setShapeStyle] = useState<ShapeStyle>({fill:null,strokeColor:'#2455c7',strokeWidth:3})
  const [markerStyle,setMarkerStyle] = useState<ShapeStyle>({fill:null,strokeColor:'#ffe34d',strokeWidth:24})
  const [shapePageSize,setShapePageSize] = useState<{pdf:PdfHandle;pageIndex:number;size:{width:number;height:number}}|null>(null)
  const [eraserRadius, setEraserRadius] = useState(8)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sizeWarning, setSizeWarning] = useState(false)
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [draftsError, setDraftsError] = useState<string | null>(null)
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null)
  const [loadingDraftId, setLoadingDraftId] = useState<string | null>(null)
  // Current handle in a ref so destroy() runs outside React state updaters
  // (updaters must stay pure; StrictMode double-invokes them in dev).
  const pdfRef = useRef<PdfHandle | null>(null)
  // Active auto-save draft + lazily opened IndexedDB handle.
  const draftRef = useRef<ActiveDraft | null>(null)
  const dbRef = useRef<IDBDatabase | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const documentIntentRef = useRef(0)
  const imageImportRef = useRef(0)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const persistenceGenerationRef = useRef(0)

  // Editor state lives in the framework-free store (ADR-002/ADR-004);
  // React re-renders on store notifications.
  const [store] = useState(() => new EditorStore())
  useSyncExternalStore(store.subscribe, store.getVersion)
  const overlays = store.state.overlays
  const selectedShape = overlays.find(o=>o.id===selectedId && isShape(o))
  const shapePage = selectedShape?.pageIndex
  useEffect(()=>{
    let cancelled=false
    if(pdf && shapePage!==undefined) void pdf.getPageSize(shapePage+1).then(size=>{if(!cancelled)setShapePageSize({pdf,pageIndex:shapePage,size})})
    return ()=>{cancelled=true}
  },[pdf,shapePage])

  const ensureDraftDb = useCallback(async () => {
    dbRef.current ??= await openDraftDb()
    return dbRef.current
  }, [])

  // IndexedDB operations are serialized. That keeps delete-after-autosave and
  // document switches deterministic even when a debounced save is in flight.
  const queuePersistence = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const queued = saveQueueRef.current.then(work)
    saveQueueRef.current = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }, [])

  const rememberDraft = useCallback((record: DraftRecord) => {
    const summary = draftSummary(record)
    setDrafts((current) =>
      [summary, ...current.filter((draft) => draft.id !== summary.id)].sort((a, b) => b.updatedAt - a.updatedAt),
    )
  }, [])

  const reportDraftProblem = useCallback((problem: unknown, message: string) => {
    console.warn(message, problem)
    setDraftsError(message)
  }, [])

  const persistActiveDraft = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const draft = draftRef.current
    if (!draft) return
    const generation = persistenceGenerationRef.current
    // Copy the overlays now: the record must describe this save point even if
    // the user keeps editing while the queued IndexedDB write is waiting.
    const overlaysSnapshot = store.state.overlays.map(cloneOverlay)
    const record = await queuePersistence(async () => {
      if (generation !== persistenceGenerationRef.current) return null
      const db = await ensureDraftDb()
      return saveDraft(db, {
        id: draft.id,
        name: draft.name,
        createdAt: draft.createdAt,
        pdfBytes: draft.bytes,
        overlays: overlaysSnapshot,
      })
    })
    if (record) {
      rememberDraft(record)
      setDraftsError(null)
    }
  }, [ensureDraftDb, queuePersistence, rememberDraft, store])

  const refreshDrafts = useCallback(async () => {
    const list = await queuePersistence(async () => listDrafts(await ensureDraftDb()))
    setDrafts(list)
    setDraftsError(null)
  }, [ensureDraftDb, queuePersistence])

  useEffect(() => {
    let cancelled = false
    void queuePersistence(async () => listDrafts(await ensureDraftDb()))
      .then((list) => {
        if (!cancelled) setDrafts(list)
      })
      .catch((problem) => {
        if (!cancelled) reportDraftProblem(problem, 'Gespeicherte Entwürfe sind auf diesem Gerät nicht verfügbar.')
      })
    return () => {
      cancelled = true
    }
  }, [ensureDraftDb, queuePersistence, reportDraftProblem])

  const replaceDocument = useCallback(
    (next: PdfHandle, draft: ActiveDraft, nextOverlays: typeof store.state.overlays) => {
      documentIntentRef.current += 1
      persistenceGenerationRef.current += 1
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      const previous = pdfRef.current
      pdfRef.current = next
      draftRef.current = draft
      setActiveDraftId(draft.id)
      setSelectedId(null)
      setSizeWarning(draft.bytes.byteLength > DRAFT_SIZE_WARN_BYTES)
      setPdf(next)
      if (nextOverlays.length === 0) store.reset()
      else store.restore(nextOverlays)
      void previous?.destroy()
    },
    [store],
  )

  const onOpenFile = useCallback(
    async (file: File) => {
      documentIntentRef.current += 1
      setError(null)
      try {
        await persistActiveDraft().catch((problem) =>
          reportDraftProblem(problem, 'Der bisherige Entwurf konnte nicht gespeichert werden.'),
        )
        const buffer = await file.arrayBuffer()
        const next = await loadPdf(file.name, new Uint8Array(buffer))
        replaceDocument(next, { id: createId(), name: file.name, createdAt: Date.now(), bytes: buffer }, [])
        void persistActiveDraft().catch((problem) =>
          reportDraftProblem(problem, 'Der neue Entwurf konnte nicht gespeichert werden.'),
        )
      } catch {
        setError(`„${file.name}“ konnte nicht geöffnet werden (beschädigt oder passwortgeschützt?).`)
      }
    },
    [persistActiveDraft, replaceDocument, reportDraftProblem],
  )

  const onOpenDraft = useCallback(
    async (id: string) => {
      if (loadingDraftId) return
      documentIntentRef.current += 1
      setError(null)
      setLoadingDraftId(id)
      try {
        await persistActiveDraft().catch((problem) =>
          reportDraftProblem(problem, 'Der bisherige Entwurf konnte nicht gespeichert werden.'),
        )
        const record = await queuePersistence(async () => loadDraft(await ensureDraftDb(), id))
        if (!record) {
          setDrafts((current) => current.filter((draft) => draft.id !== id))
          setError('Dieser Entwurf ist nicht mehr vorhanden.')
          return
        }
        const bytes = record.pdfBytes.slice(0)
        const next = await loadPdf(record.name, new Uint8Array(bytes))
        replaceDocument(
          next,
          { id: record.id, name: record.name, createdAt: record.createdAt, bytes },
          record.overlays.map(cloneOverlay),
        )
      } catch {
        setError('Der Entwurf konnte nicht geöffnet werden.')
      } finally {
        setLoadingDraftId(null)
      }
    },
    [ensureDraftDb, loadingDraftId, persistActiveDraft, queuePersistence, replaceDocument, reportDraftProblem],
  )

  const onDeleteDraft = useCallback(
    async (id: string) => {
      const draft = drafts.find((item) => item.id === id)
      if (draft && !window.confirm(`Entwurf „${draft.name}“ löschen? Das kann nicht rückgängig gemacht werden.`)) {
        return
      }
      const isActive = id === activeDraftId
      const pausedDraft = isActive ? draftRef.current : null
      if (isActive) {
        documentIntentRef.current += 1
        // Pause auto-save while deleting; on failure it resumes and persists
        // any edits made during the confirmation/DB round trip.
        persistenceGenerationRef.current += 1
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        draftRef.current = null
      }
      try {
        await queuePersistence(async () => deleteDraft(await ensureDraftDb(), id))
        setDrafts((current) => current.filter((item) => item.id !== id))
        setDraftsError(null)
        if (isActive) {
          const previous = pdfRef.current
          pdfRef.current = null
          setPdf(null)
          setActiveDraftId(null)
          setSelectedId(null)
          setSizeWarning(false)
          store.reset()
          void previous?.destroy()
        }
      } catch (problem) {
        if (pausedDraft) {
          draftRef.current = pausedDraft
          void persistActiveDraft().catch((saveProblem) =>
            reportDraftProblem(saveProblem, 'Der Entwurf konnte nicht gespeichert werden.'),
          )
        }
        reportDraftProblem(problem, 'Der Entwurf konnte nicht gelöscht werden.')
      }
    },
    [activeDraftId, drafts, ensureDraftDb, persistActiveDraft, queuePersistence, reportDraftProblem, store],
  )

  const onDraftsMenuOpen = useCallback(() => {
    void (async () => {
      await persistActiveDraft()
      await refreshDrafts()
    })().catch((problem) => reportDraftProblem(problem, 'Die Entwurfsliste konnte nicht aktualisiert werden.'))
  }, [persistActiveDraft, refreshDrafts, reportDraftProblem])

  // Release the worker document when the app unmounts.
  useEffect(() => () => { documentIntentRef.current += 1; void pdfRef.current?.destroy() }, [])

  // Auto-save: every store change (edits, moves, deletes) persists the draft
  // to IndexedDB, debounced so gestures like dragging or typing coalesce.
  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      if (!draftRef.current) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        // Persistence must never break editing (e.g. private browsing).
        void persistActiveDraft().catch((problem) =>
          reportDraftProblem(problem, 'Der Entwurf konnte nicht gespeichert werden.'),
        )
      }, 500)
    })
    return () => {
      unsubscribe()
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [persistActiveDraft, reportDraftProblem, store])

  const onImportImage = useCallback(async (file: File, targetPage?: number, dropPoint?: { x: number; y: number }) => {
    const handle = pdfRef.current
    if (!handle) return
    const intent = documentIntentRef.current
    const request = ++imageImportRef.current
    const stillCurrent = () => pdfRef.current === handle && documentIntentRef.current === intent && imageImportRef.current === request
    setError(null)
    try {
      // Pick the page with the largest visible area, not always page one.
      const workspace = workspaceRef.current!.getBoundingClientRect()
      const pages = Array.from(workspaceRef.current!.querySelectorAll<HTMLElement>('[data-page-index]'))
      const visibleArea = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        return Math.max(0, Math.min(rect.bottom, workspace.bottom) - Math.max(rect.top, workspace.top)) *
          Math.max(0, Math.min(rect.right, workspace.right) - Math.max(rect.left, workspace.left))
      }
      const visiblePage = pages.sort((a, b) => visibleArea(b) - visibleArea(a))[0]
      const pageIndex = targetPage ?? Number(visiblePage?.dataset.pageIndex ?? 0)
      const element = pages.find(page => Number(page.dataset.pageIndex) === pageIndex)
      const rect = element?.getBoundingClientRect()
      const source = await importImage(file)
      if (!stillCurrent()) return
      const pageSize = await handle.getPageSize(pageIndex + 1)
      if (!stillCurrent()) return
      const center = dropPoint ?? (rect ? {
        x: (Math.max(rect.left, workspace.left) + Math.min(rect.right, workspace.right)) / 2 / zoom - rect.left / zoom,
        y: pageSize.height - ((Math.max(rect.top, workspace.top) + Math.min(rect.bottom, workspace.bottom)) / 2 - rect.top) / zoom,
      } : { x: pageSize.width / 2, y: pageSize.height / 2 })
      const image = { ...source, ...initialImageGeometry(source.pixelWidth, source.pixelHeight, pageSize, center),
        kind: 'image' as const, id: createId(), pageIndex }
      store.dispatch(addImage(image))
      setTool('select')
      setSelectedId(image.id)
    } catch (problem) {
      if (stillCurrent()) setError(problem instanceof Error ? problem.message : 'Das Bild konnte nicht geladen werden.')
    }
  }, [store, zoom])

  // Global shortcuts. While a textarea is focused, it keeps its own editing
  // keys (Escape blurs there, see TextboxView).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('textarea, input, select, [contenteditable]')) return
      if (event.key === 'Escape') {
        setSelectedId(null)
        setTool('select')
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        const box = store.state.overlays.find((o) => o.id === selectedId)
        if (box && (isTextbox(box) || isImage(box) || isShape(box))) {
          event.preventDefault()
          store.dispatch(isImage(box) ? removeImage(box) : isShape(box) ? removeShape(box) : removeTextbox(box))
          setSelectedId(null)
        }
        return
      }
      if (selectedId && event.key.startsWith('Arrow')) {
        const box = store.state.overlays.find((o) => o.id === selectedId)
        if (!box || isStroke(box)) return
        event.preventDefault()
        if (isImage(box) || isShape(box)) {
          const step = event.shiftKey ? 10 : 1
          const element = workspaceRef.current?.querySelector<HTMLElement>(`[data-page-index="${box.pageIndex}"]`)
          if (!element) return
          const stepX = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
          const stepY = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
          const page = {width:element.clientWidth/zoom,height:element.clientHeight/zoom}
          if(isImage(box)) {
            const before=imageGeometry(box), next=moveImage(before,stepX,stepY,page)
            if(next.x!==box.x || next.y!==box.y) store.dispatch(nudgeImage(box.id,before,next))
          } else {
            const before=shapeGeometry(box), next=moveShape(before,stepX,stepY,page)
            if(next.x!==box.x || next.y!==box.y) store.dispatch(nudgeShape(box.id,before,next))
          }
          return
        }
        const step = event.shiftKey ? 10 : 1
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
        const dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
        store.dispatch(
          nudgeTextbox(box.id, { x: box.x, y: box.y }, { x: Math.max(0, box.x + dx), y: Math.max(0, box.y + dy) }),
        )
        return
      }
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 'z' && event.shiftKey) {
        event.preventDefault()
        store.redo()
      } else if (key === 'z') {
        event.preventDefault()
        store.undo()
      } else if (key === 'y') {
        event.preventDefault()
        store.redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [store, selectedId, zoom])

  const onExport = useCallback(async () => {
    if (!pdf) return
    const bytes = await pdf.exportBytes(store.state.overlays)
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }))
    const link = document.createElement('a')
    link.href = url
    link.download = pdf.fileName
    link.click()
    // Defer revocation: Firefox/Safari may abort the download if the URL
    // is revoked in the same tick as the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [pdf, store])

  return (
    <div className="app">
      <header className="toolbar">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void onOpenFile(file)
          }}
        />
        <input ref={imageInputRef} type="file" accept="image/png,image/jpeg" className="visually-hidden"
          tabIndex={-1} aria-hidden="true" onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void onImportImage(file)
          }} />
        <button type="button" onClick={() => fileInputRef.current?.click()}>
          PDF öffnen
        </button>
        <DraftsMenu
          drafts={drafts}
          activeDraftId={activeDraftId}
          loadingDraftId={loadingDraftId}
          error={draftsError}
          onMenuOpen={onDraftsMenuOpen}
          onOpenDraft={(id) => void onOpenDraft(id)}
          onDeleteDraft={(id) => void onDeleteDraft(id)}
          onNewPdf={() => fileInputRef.current?.click()}
        />
        {pdf && (
          <>
            <span className="file-info">
              {pdf.fileName} · {pdf.pageCount} {pdf.pageCount === 1 ? 'Seite' : 'Seiten'}
            </span>
            <button type="button" onClick={() => setZoom((z) => zoomOut(z))}>
              −
            </button>
            <span className="zoom-label">{Math.round(zoom * 100)} %</span>
            <button type="button" onClick={() => setZoom((z) => zoomIn(z))}>
              +
            </button>
            <span className="separator" />
            <button type="button" onClick={() => imageInputRef.current?.click()} title="PNG- oder JPG-Bild einfügen · auch per Drag & Drop">
              + Bild einfügen
            </button>
            <button
              type="button"
              className="tool"
              aria-pressed={tool === 'select'}
              title="Auswahl-Werkzeug (Esc)"
              onClick={() => setTool('select')}
            >
              ⬚ Auswahl
            </button>
            <button
              type="button"
              className="tool"
              aria-pressed={tool === 'text'}
              title="Text-Werkzeug"
              onClick={() => setTool('text')}
            >
              T Text
            </button>
            <SymbolPicker
              value={symbol}
              active={tool === 'symbol'}
              onPick={(nextSymbol) => {
                setSymbol(nextSymbol)
                setTool('symbol')
              }}
            />
            <button
              type="button"
              className="tool"
              aria-label="Stift"
              aria-pressed={tool === 'pen'}
              onClick={() => {
                setSelectedId(null)
                setTool('pen')
              }}
            >
              <svg className="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m 4 16 12 -12 4 4 -12 12 -5 1 1 -5 M 13 7 l 4 4" />
              </svg>
              Stift
            </button>
            <button
              type="button"
              className="tool"
              aria-label="Radierer"
              aria-pressed={tool === 'eraser'}
              onClick={() => {
                setSelectedId(null)
                setTool('eraser')
              }}
            >
              <svg className="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m 4 14 10 -10 7 7 -10 10 H 7 l -3 -3 Z M 9 9 l 7 7 M 11 21 h 10" />
              </svg>
              Radierer
            </button>
            {SHAPE_TOOLS.map(option=><button key={option.tool} type="button" className="tool" aria-label={option.label}
              aria-pressed={tool===option.tool} onClick={()=>{setSelectedId(null);setTool(option.tool)}}>
              <svg className="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d={option.path} /></svg>{option.label}
            </button>)}
            <span className="separator" />
            <button type="button" aria-label="Rückgängig" disabled={!store.canUndo} onClick={() => store.undo()} title="Rückgängig (Strg+Z)">
              ↩︎
            </button>
            <button type="button" aria-label="Wiederholen" disabled={!store.canRedo} onClick={() => store.redo()} title="Wiederholen (Strg+Y)">
              ↪︎
            </button>
            <button type="button" onClick={() => void onExport()}>
              Exportieren
            </button>
          </>
        )}
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {sizeWarning && !error && (
        <p role="status" className="hint">
          ⚠️ Große Datei (über 50 MB) – automatisches Speichern und Exportieren können träge werden.
        </p>
      )}
      {!pdf && !error && (
        <p className="hint">
          Wähle eine PDF-Datei – oder öffne über <b>Entwürfe&nbsp;▾</b> einen früheren Stand.
        </p>
      )}
      <div className="workspace" ref={workspaceRef}>
        {pdf && (
          <DrawingToolbar workspaceRef={workspaceRef} tool={tool} color={strokeColor} width={strokeWidth}
            eraserRadius={eraserRadius} onColor={setStrokeColor} onWidth={setStrokeWidth} onEraserRadius={setEraserRadius} />
        )}
        {pdf && tool==='select' && selectedShape && isShape(selectedShape) && shapePageSize?.pdf===pdf && shapePageSize.pageIndex===shapePage && <ShapeToolbar
          key={activeDraftId} workspaceRef={workspaceRef} shape={selectedShape} pageSize={shapePageSize.size} store={store} onSelect={setSelectedId}
          onStyle={shape=>{const next={fill:shape.fill,strokeColor:shape.strokeColor,strokeWidth:shape.strokeWidth};if(shape.shape==='marker')setMarkerStyle(next);else setShapeStyle(next)}} />}
        <div className="pages">
        {pdf &&
          Array.from({ length: pdf.pageCount }, (_, index) => (
            <PageView
              key={`${activeDraftId}-${index}`}
              pdf={pdf}
              pageIndex={index}
              zoom={zoom}
              tool={tool}
              symbol={symbol}
              strokeColor={strokeColor}
              strokeWidth={strokeWidth}
              eraserRadius={eraserRadius}
              shapeStyle={shapeStyle}
              markerStyle={markerStyle}
              onTool={setTool}
              overlays={overlays}
              store={store}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onImageDrop={(file, pageIndex, point) => void onImportImage(file, pageIndex, point)}
            />
          ))}
        </div>
      </div>
      {pdf && (
        <footer className="drawing-footer">
          <button type="button" disabled={!overlays.some(o=>isStroke(o)||isMarker(o))}
            title="Freihandstriche und Textmarker löschen · Formen, Texte, Bilder und PDF bleiben erhalten"
            onClick={() => {
              if (store.state.overlays.some(o=>isStroke(o)||isMarker(o))) store.dispatch(clearDrawing(store.state.overlays))
            }}>
            Zeichnung löschen
          </button>
        </footer>
      )}
    </div>
  )
}
