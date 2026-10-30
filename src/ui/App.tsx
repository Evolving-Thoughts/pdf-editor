import { SourceTextPanel } from './SourceTextPanel'
import type { SourceHistory } from './SourceTextPanel'
import { ExportDialog, type PreparedExport } from './ExportDialog'
import { compressPdf, checkExportAbort, type CompressionPreset } from '../core/pdf/compressPdf'
import { encodeCompressedImage } from '../core/images/compressImage'
import { preparePdf, unlockPdf, encryptPdf, PasswordRequiredError, IncorrectPasswordError } from '../core/pdf/unlockPdf'
import { PasswordDialog, type PasswordRequest } from './PasswordDialog'
import { SearchWindow } from './SearchWindow'
import type { SearchHit } from '../core/search'
import { applyRedactionResult,replaceRedactions,type Redaction } from '../core/redactions'
import { prepareRedaction } from '../core/pdf/redactDocument'
import { RedactionBar } from './RedactionBar'
import type { FormValues, NativeWidget } from '../core/forms'
import { inspectNativeForms, needsNativeFormInspection } from '../core/pdf/acroForm'
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
import { assertFileBudget } from '../core/pdf/documentBudget'
import { importImage } from '../core/images/importImage'
import { imageGeometry, initialImageGeometry, moveImage } from '../core/images/geometry'
import { shapeGeometry, moveShape, type ShapeStyle } from '../core/shapes'
import { ShapeToolbar } from './ShapeToolbar'
import { SHAPE_TOOLS, isShapeTool } from './tools'
import { zoomIn, zoomOut } from '../core/viewerState'
import { DraftsMenu } from './DraftsMenu'
import { DrawingToolbar } from './DrawingToolbar'
import { PageView } from './PageView'
import { VirtualPage } from './VirtualPage'
import { PagesManager } from './PagesManager'
import { downloadPdf } from '../core/pdf/downloadPdf'
import { composePages, exportPageDocument, inspectPages } from '../core/pdf/pageOperations'
import { pageSize, type DocumentPage, type PageSource } from '../core/pages'
import { SymbolPicker } from './SymbolPicker'
import type { Tool } from './tools'
import './app.css'

interface ManualSave {
  draftId: string
  version: number
  status: 'saving' | 'saved' | 'error'
}

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
    sizeBytes: record.pdfBytes.byteLength + (record.pageSources ?? []).filter(source => record.pages?.some(page => page.sourceId === source.id)).reduce((size, source) => size + source.bytes.byteLength, 0),
    overlayCount: record.overlays.length,
  }
}

export default function App() {
  const [sourceTextOpen, setSourceTextOpen] = useState(false)
  // Unchecked inline drafts of the correction panel come before document history.
  const [sourceHistory, setSourceHistory] = useState<SourceHistory | null>(null)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchResult, setSearchResult] = useState<{
    hits: SearchHit[]
    active: number
  }>({ hits: [], active: 0 })
  const [openingFile, setOpeningFile] = useState(false)
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(
    null,
  )
  const passwordPending = useRef<((password: string | null) => void) | null>(null)
  const passwordEpoch = useRef(0)
  const openingIntent = useRef(0)
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const onSearchHits = useCallback(
    (hits: SearchHit[], active: number) => setSearchResult({ hits, active }),
    [],
  )
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    requestAnimationFrame(() => searchButtonRef.current?.focus())
  }, [])

  const [redactionFill,setRedactionFill]=useState<Redaction['fill']>('black')
  const [redactionBusy,setRedactionBusy]=useState(false)
  const [highlightFields, setHighlightFields] = useState(true)
  const [formInfo, setFormInfo] = useState<{ pages: DocumentPage[]; widgets: NativeWidget[]; unsupported: string[] } | null>(null)
  const [pageManagerOpen, setPageManagerOpen] = useState(false)
  const [renderedPages, setRenderedPages] = useState<DocumentPage[] | undefined>(undefined)
  const [originalBytes, setOriginalBytes] = useState<ArrayBuffer | null>(null)
  const [cropActive, setCropActive] = useState(false)
  const pdfPagesRef = useRef<DocumentPage[] | undefined>(undefined)
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
  const [manualSave, setManualSave] = useState<ManualSave | null>(null)
  const manualSaveRequestRef = useRef<object | null>(null)
  const inputEpochRef = useRef(0)
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
  // Page shown in the normal view before switching to the page manager or the
  // text correction (and the page shown there): both views open at that page,
  // and the normal view returns to it.
  const viewedPageRef = useRef(0), returnPageRef = useRef<number | null>(null)
  const visiblePageIndex = useCallback(() => {
    const scroller = workspaceRef.current?.querySelector<HTMLElement>('.pages')
    if (!scroller) return viewedPageRef.current
    const view = scroller.getBoundingClientRect()
    let best = viewedPageRef.current, area = 0
    for (const page of scroller.querySelectorAll<HTMLElement>('.page[data-page-index]')) {
      const rect = page.getBoundingClientRect()
      const visible = Math.max(0, Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top)) * Math.max(0, Math.min(rect.right, view.right) - Math.max(rect.left, view.left))
      if (visible > area) { area = visible; best = Number(page.dataset.pageIndex) }
    }
    return best
  }, [])
  const onViewedPage = useCallback((index: number) => { viewedPageRef.current = index }, [])
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const persistenceGenerationRef = useRef(0)

  // Editor state lives in the framework-free store (ADR-002/ADR-004);
  // React re-renders on store notifications.
  const [store] = useState(() => new EditorStore())
  useSyncExternalStore(store.subscribe, store.getVersion)
  const redactions = store.state.redactions ?? []
  const overlays = store.state.overlays
  const documentPages = store.state.pages
  const documentSources = store.state.pageSources
  const nativeWidgets = formInfo?.pages === documentPages ? formInfo?.widgets ?? [] : []
  useEffect(() => {
    if (!originalBytes || !documentPages || !documentPages.some(needsNativeFormInspection)) return
    let cancelled = false
    void inspectNativeForms(new Uint8Array(originalBytes), documentSources ?? [], documentPages).then(result => {
      if (!cancelled) setFormInfo({ pages: documentPages, ...result })
    }).catch(problem => { if (!cancelled) setError(problem instanceof Error ? problem.message : 'Formularfelder konnten nicht erkannt werden.') })
    return () => { cancelled = true }
  }, [originalBytes, documentPages, documentSources])
  const pageBusy = !!documentPages?.length && renderedPages !== documentPages
  useEffect(() => {
    if (!documentPages || !draftRef.current || pdfPagesRef.current === documentPages) return
    const draft = draftRef.current, sources = [...(store.state.pageSources ?? [])]
    let cancelled = false
    if (!documentPages.length) {
      pdfPagesRef.current = documentPages
      return
    }
    void composePages(new Uint8Array(draft.bytes), sources, documentPages, undefined, store.state.redactionApplied||documentPages.some(page=>page.redacted)).then(bytes => loadPdf(draft.name, bytes)).then(next => {
      if (cancelled || draftRef.current !== draft) { void next.destroy(); return }
      const old = pdfRef.current
      pdfRef.current = next; pdfPagesRef.current = documentPages
      setPdf(next); setRenderedPages(documentPages)
      void old?.destroy()
    }).catch(problem => {
      if (!cancelled) {setError(problem instanceof Error ? problem.message : 'Die Seiten konnten nicht aktualisiert werden.')}
    })
    return () => {cancelled = true}
  }, [documentPages, store])
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
    if (!draft) return null
    const generation = persistenceGenerationRef.current
    // Copy the overlays now: the record must describe this save point even if
    // the user keeps editing while the queued IndexedDB write is waiting.
    const overlaysSnapshot = store.state.overlays.map(cloneOverlay)
    const redactionAppliedSnapshot = store.state.redactionApplied
    const redactionSnapshot = structuredClone(store.state.redactions ?? [])
    const formSnapshot = store.state.formValues ? structuredClone(store.state.formValues) : undefined
    const pagesSnapshot = store.state.pages ? structuredClone(store.state.pages) : undefined
    const sourcesSnapshot = [...(store.state.pageSources ?? [])]
    const record = await queuePersistence(async () => {
      if (generation !== persistenceGenerationRef.current) return null
      const db = await ensureDraftDb()
      return saveDraft(db, {
        id: draft.id,
        name: draft.name,
        createdAt: draft.createdAt,
        pdfBytes: draft.bytes,
        overlays: overlaysSnapshot,
        pages: pagesSnapshot,
        pageSources: sourcesSnapshot,
        formValues: formSnapshot,
        redactionApplied: redactionAppliedSnapshot,
        redactions: redactionSnapshot,
      })
    })
    if (record) {
      rememberDraft(record)
      setDraftsError(null)
    }
    return record
  }, [ensureDraftDb, queuePersistence, rememberDraft, store])

  const onManualSave = useCallback(async () => {
    const draft = draftRef.current
    if (!draft || (manualSave?.draftId === draft.id && manualSave.status === 'saving')) return
    const request = {}
    manualSaveRequestRef.current = request
    const generation = persistenceGenerationRef.current
    const version = store.getVersion()
    const inputEpoch = inputEpochRef.current
    const stillCurrent = () => manualSaveRequestRef.current === request &&
      draftRef.current?.id === draft.id && persistenceGenerationRef.current === generation
    setManualSave({ draftId: draft.id, version, status: 'saving' })
    try {
      // A normal button click blurs the active textarea first, committing its
      // text before persistActiveDraft snapshots and queues this save point.
      const record = await persistActiveDraft()
      if (!stillCurrent()) return
      setManualSave(record && store.getVersion() === version && inputEpochRef.current === inputEpoch
        ? { draftId: draft.id, version, status: 'saved' } : null)
    } catch (problem) {
      if (!stillCurrent()) return
      reportDraftProblem(problem, 'Der Entwurf konnte nicht gespeichert werden. Bitte erneut versuchen.')
      setManualSave({ draftId: draft.id, version, status: 'error' })
    }
  }, [manualSave, persistActiveDraft, reportDraftProblem, store])

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
    (next: PdfHandle, draft: ActiveDraft, nextOverlays: typeof store.state.overlays, pages: DocumentPage[], sources: PageSource[] = [], formValues?: FormValues, pendingRedactions?: Redaction[], redactionApplied?: boolean) => {
      documentIntentRef.current += 1
      persistenceGenerationRef.current += 1
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      const previous = pdfRef.current
      pdfRef.current = next
      draftRef.current = draft
      setSourceTextOpen(false)
      setActiveDraftId(draft.id)
      setManualSave(null)
      manualSaveRequestRef.current = null
      setSearchOpen(false)
      setSelectedId(null)
      setTool('select')
      setRedactionFill('black')
      setPageManagerOpen(false)
      setCropActive(false)
      setOriginalBytes(draft.bytes)
      setSizeWarning(draft.bytes.byteLength > DRAFT_SIZE_WARN_BYTES)
      setPdf(next)
      store.restore(nextOverlays, pages, sources, formValues, pendingRedactions, redactionApplied)
      pdfPagesRef.current = store.state.pages
      setRenderedPages(store.state.pages)
      void previous?.destroy()
    },
    [store],
  )

  const onOpenFile = useCallback(
    async (file: File) => {
      const intent = ++documentIntentRef.current
      openingIntent.current = intent
      passwordPending.current?.(null)
      setError(null)
      setOpeningFile(true)
      try {
        // Do not discard the current document if its last save failed.
        await persistActiveDraft()
        assertFileBudget(file.size)
        const input = new Uint8Array(await file.arrayBuffer())
        if (documentIntentRef.current !== intent) return
        let bytes: Uint8Array
        try {
          bytes = await preparePdf(input)
        } catch (problem) {
          if (!(problem instanceof PasswordRequiredError)) throw problem
          let message: string | null = null
          for (;;) {
            if (documentIntentRef.current !== intent) return
            const password = await new Promise<string | null>((resolve) => {
              const finish = (value: string | null) => {
                passwordPending.current = null
                setPasswordRequest(null)
                resolve(value)
              }
              passwordPending.current = finish
              passwordEpoch.current++
              setPasswordRequest({
                fileName: file.name,
                error: message,
                resolve: finish,
              })
            })
            if (password === null || documentIntentRef.current !== intent) return
            try {
              bytes = await unlockPdf(input, password)
              break
            } catch (error) {
              if (error instanceof IncorrectPasswordError) {
                message = error.message
                continue
              }
              throw error
            }
          }
        }
        if (documentIntentRef.current !== intent) return
        const buffer = bytes.slice().buffer as ArrayBuffer
        const pages = await inspectPages(bytes, file.name)
        const next = await loadPdf(file.name, bytes)
        if (documentIntentRef.current !== intent) {
          void next.destroy()
          return
        }
        replaceDocument(
          next,
          {
            id: createId(),
            name: file.name,
            createdAt: Date.now(),
            bytes: buffer,
          },
          [],
          pages,
        )
        void persistActiveDraft().catch((problem) =>
          reportDraftProblem(
            problem,
            'Der neue Entwurf konnte nicht gespeichert werden.',
          ),
        )
      } catch (problem) {
        if (documentIntentRef.current === intent)
          setError(
            problem instanceof IncorrectPasswordError
              ? problem.message
              : `„${file.name}“ konnte nicht geöffnet werden. ${problem instanceof Error && /entschlüsselt|Möglich sind/.test(problem.message) ? problem.message : 'Datei beschädigt, kein gültiges PDF oder bisheriger Entwurf nicht speicherbar. Der bisherige Stand bleibt geöffnet.'}`,
          )
      } finally {
        if (openingIntent.current === intent) setOpeningFile(false)
      }
    },
    [persistActiveDraft, replaceDocument, reportDraftProblem],
  )

  const onOpenDraft = useCallback(
    async (id: string) => {
      if (loadingDraftId) return
      const intent=++documentIntentRef.current
      setError(null)
      setLoadingDraftId(id)
      try {
        await persistActiveDraft().catch((problem) =>
          reportDraftProblem(problem, 'Der bisherige Entwurf konnte nicht gespeichert werden.'),
        )
        const record = await queuePersistence(async () => loadDraft(await ensureDraftDb(), id))
        if(documentIntentRef.current!==intent)return
        if (!record) {
          setDrafts((current) => current.filter((draft) => draft.id !== id))
          setError('Dieser Entwurf ist nicht mehr vorhanden.')
          return
        }
        const bytes = record.pdfBytes.slice(0)
        const pages = record.pages ?? await inspectPages(new Uint8Array(bytes), record.name)
        const sources = record.pageSources ?? []
        const base = pages.length ? await composePages(new Uint8Array(bytes), sources, pages, undefined, record.redactionApplied||pages.some(page=>page.redacted)) : new Uint8Array(bytes)
        const next = await loadPdf(record.name, base)
        if(documentIntentRef.current!==intent){void next.destroy();return}
        replaceDocument(
          next,
          { id: record.id, name: record.name, createdAt: record.createdAt, bytes },
          record.overlays.map(cloneOverlay),
          pages, sources, record.formValues, record.redactions, record.redactionApplied,
        )
      } catch {
        if(documentIntentRef.current===intent)setError('Der Entwurf konnte nicht geöffnet werden.')
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
        setManualSave(null)
        manualSaveRequestRef.current = null
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
  useEffect(() => () => { documentIntentRef.current += 1; passwordPending.current?.(null); void pdfRef.current?.destroy() }, [])

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
      if (target.closest('dialog')) return
      if (sourceTextOpen || loadingDraftId || exportBusy || openingFile || redactionBusy || pageBusy || (pageManagerOpen && cropActive)) return
      if (pdf && (event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='f') {
        event.preventDefault();setPageManagerOpen(false);setSelectedId(null);setSearchOpen(true);return
      }
      if (target.closest('textarea, input, select, [contenteditable]')) return
      if (event.key === 'Escape') {
        setSelectedId(null)
        setTool('select')
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        const mark=store.state.redactions?.find(m=>m.id===selectedId)
        if(mark){event.preventDefault();store.dispatch(replaceRedactions(store.state,store.state.redactions!.filter(m=>m.id!==mark.id)));setSelectedId(null);return}
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
  }, [sourceTextOpen, store, selectedId, zoom, pageBusy, pageManagerOpen, cropActive, redactionBusy, openingFile, exportBusy, loadingDraftId, pdf])

  const onSearchJump = useCallback(
    (hit: SearchHit) => {
      const scroller = workspaceRef.current?.querySelector<HTMLElement>('.pages')
      const page = workspaceRef.current?.querySelector<HTMLElement>(
        `.page[data-page-index="${hit.pageIndex}"]`,
      )
      if (!scroller || !page || !hit.polygons[0]?.length) return
      const polygon = hit.polygons[0],
        x = polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length,
        y = polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length
      const rect = page.getBoundingClientRect(),
        view = scroller.getBoundingClientRect()
      const panel=workspaceRef.current?.querySelector<HTMLElement>('.search-window')?.getBoundingClientRect()
      const centeredX=view.left+scroller.clientWidth/2
      const coveredTop=panel && centeredX>=panel.left && centeredX<=panel.right ? Math.max(0,Math.min(scroller.clientHeight,panel.bottom-view.top+8)) : 0
      const centerY=coveredTop+(scroller.clientHeight-coveredTop)/2
      scroller.scrollTo({
        left:
          scroller.scrollLeft +
          rect.left -
          view.left +
          x * zoom -
          scroller.clientWidth / 2,
        top:
          scroller.scrollTop +
          rect.top -
          view.top +
          y * zoom -
          centerY,
      })
    },
    [zoom],
  )

  useEffect(() => {
    const index = returnPageRef.current
    if (index === null || pageManagerOpen || sourceTextOpen || pageBusy || !pdf) return
    let frame = 0, tries = 0
    // Page boxes get their size once the page geometry is known: retry briefly.
    const scroll = () => {
      const scroller = workspaceRef.current?.querySelector<HTMLElement>('.pages')
      const page = scroller?.querySelector<HTMLElement>(`.page[data-page-index="${index}"]`)
      if (scroller && page && page.offsetHeight > 0) {
        scroller.scrollTop += page.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12
        returnPageRef.current = null
        if (tries++ < 3) frame = requestAnimationFrame(scroll)
        else return
      } else if (tries++ < 30) frame = requestAnimationFrame(scroll)
    }
    frame = requestAnimationFrame(scroll)
    return () => cancelAnimationFrame(frame)
  }, [pageManagerOpen, sourceTextOpen, pageBusy, pdf])

  const prepareExport = useCallback(
    async (preset: CompressionPreset | undefined, signal: AbortSignal, onProgress: (done: number, total: number) => void): Promise<PreparedExport> => {
      const draft = draftRef.current
      if (!draft || !store.state.pages?.length || pageBusy || exportBusy)
        throw new Error('Der Export ist gerade nicht verfügbar.')
      setExportBusy(true)
      try {
        checkExportAbort(signal)
        if (store.state.redactions?.length)
          throw new Error('Vorgemerkte Schwärzungen zuerst anwenden oder verwerfen; sie sind noch nicht sicher entfernt.')
        const original = await exportPageDocument(
          new Uint8Array(draft.bytes), store.state.pageSources ?? [], store.state.pages,
          store.state.overlays.map(cloneOverlay), undefined, store.state.formValues,
          store.state.redactionApplied || store.state.pages.some(page => page.redacted),
        )
        checkExportAbort(signal)
        const compression = preset ? await compressPdf(original, preset, encodeCompressedImage, { signal, onProgress }) : undefined
        checkExportAbort(signal)
        return { name: draft.name, original, compression }
      } finally { setExportBusy(false) }
    }, [store, pageBusy, exportBusy],
  )
  const downloadExport = useCallback(async (bytes: Uint8Array, name: string, password: string | undefined, signal: AbortSignal) => {
    setExportBusy(true)
    try {
      checkExportAbort(signal)
      const output = password === undefined ? bytes : await encryptPdf(bytes, password)
      checkExportAbort(signal)
      downloadPdf(output, name)
    } finally { setExportBusy(false) }
  }, [])

  const onApplyRedactions = async () => {
    const draft=draftRef.current,version=store.getVersion(),intent=documentIntentRef.current
    if(!draft||redactionBusy||pageBusy||!store.state.redactions?.length)return
    setError(null);setRedactionBusy(true)
    try {
      const prepared=await prepareRedaction(new Uint8Array(draft.bytes),store.state)
      if(store.getVersion()!==version||draftRef.current!==draft||documentIntentRef.current!==intent)throw new Error('Der Stand hat sich geändert. Schwärzung bitte erneut prüfen und anwenden.')
      store.dispatch(applyRedactionResult(store.state,prepared.source,prepared.replacements,prepared.newText))
      setSelectedId(prepared.newText[0]?.id??null);setTool(prepared.newText.length?'text':'select')
    } catch(problem) {if(draftRef.current===draft)setError(problem instanceof Error?problem.message:'Die Schwärzung konnte nicht angewendet werden. Der Stand bleibt unverändert.')}
    finally {setRedactionBusy(false)}
  }

  const visibleSave = manualSave?.draftId === activeDraftId &&
    (manualSave.status !== 'saved' || manualSave.version === store.getVersion()) ? manualSave : null
  const saveMessage = visibleSave?.status === 'saving' ? 'Entwurf wird gespeichert …'
    : visibleSave?.status === 'saved' ? '✓ Entwurf gespeichert · Nur auf diesem Gerät.'
    : visibleSave?.status === 'error' ? 'Der Entwurf konnte nicht gespeichert werden. Bitte erneut versuchen.'
    : 'Automatisches Speichern ist aktiv · Entwürfe bleiben unverschlüsselt auf diesem Gerät.'

  const shapeToolButton = (option: (typeof SHAPE_TOOLS)[number]) => (
    <button
      key={option.tool}
      type="button"
      className="tool"
      aria-label={option.label}
      aria-pressed={tool === option.tool}
      onClick={() => {
        setSelectedId(null)
        setTool(option.tool)
      }}
    >
      <svg
        className="tool-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <path d={option.path} />
      </svg>
      {option.label}
    </button>
  )

  return (
    <div className="app" onDragOverCapture={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy'}}}
      onDropCapture={event=>{
        const files=Array.from(event.dataTransfer.files)
        if(!files.length)return
        if(exportDialogOpen){event.preventDefault();event.stopPropagation();return}
        const pdfFiles=files.filter(file=>file.type==='application/pdf'||/\.pdf$/i.test(file.name))
        if(!pdfFiles.length && (event.target as HTMLElement).closest('.page') && files.every(file=>/^image\/(png|jpeg)$/.test(file.type)))return
        event.preventDefault();event.stopPropagation()
        if(loadingDraftId||exportBusy||openingFile||redactionBusy||pageBusy||cropActive)return
        if(files.length!==1||pdfFiles.length!==1){setError('Bitte genau eine PDF-Datei zum Öffnen ziehen. Bilder auf einer Dokumentseite ablegen.');return}
        void onOpenFile(pdfFiles[0])
      }} onChange={event => {
      if ((event.target as HTMLElement).closest('.export-dialog')) return
      inputEpochRef.current += 1
      setManualSave(current => current?.status === 'saved' ? null : current)
    }}>
      <header
        className="toolbar"
        inert={
          exportDialogOpen ||
          redactionBusy ||
          openingFile ||
          exportBusy ||
          !!loadingDraftId
        }
      >
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
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg"
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void onImportImage(file)
          }}
        />
        <div
          className="toolbar-primary"
          role="group"
          aria-label="Datei und Navigation"
        >
          <div className="toolbar-file-actions">
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
                <button
                  type="button"
                  aria-label="Speichern"
                  title="Aktuellen Entwurf auf diesem Gerät speichern"
                  disabled={visibleSave?.status === 'saving'}
                  onClick={() => void onManualSave()}
                >
                  <svg
                    className="tool-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    aria-hidden="true"
                  >
                    <path d="M4 3h13l3 3v15H4zM8 3v6h8V3M8 21v-8h8v8" />
                  </svg>
                  {visibleSave?.status === 'saving'
                    ? 'Speichert …'
                    : 'Speichern'}
                </button>
              </>
            )}
          </div>
          {pdf && (
            <>
              <span className="file-info">
                {pdf.fileName} · {documentPages?.length ?? pdf.pageCount}{' '}
                {(documentPages?.length ?? pdf.pageCount) === 1
                  ? 'Seite'
                  : 'Seiten'}
              </span>
              <div className="toolbar-navigation">
                <button
                  type="button"
                  aria-pressed={pageManagerOpen}
                  disabled={pageBusy || redactions.length > 0}
                  onClick={() => {
                    if (!pageManagerOpen && !sourceTextOpen) viewedPageRef.current = visiblePageIndex()
                    if (pageManagerOpen) returnPageRef.current = viewedPageRef.current
                    setSourceTextOpen(false)
                    setSearchOpen(false)
                    setSelectedId(null)
                    setCropActive(false)
                    setPageManagerOpen((open) => !open)
                  }}
                >
                  {pageManagerOpen
                    ? 'Zur Dokumentbearbeitung'
                    : 'Seiten verwalten'}
                </button>
                <button
                  ref={searchButtonRef}
                  type="button"
                  disabled={pageBusy || cropActive}
                  aria-pressed={searchOpen}
                  onClick={() => {
                    setSourceTextOpen(false)
                    setPageManagerOpen(false)
                    setSelectedId(null)
                    setSearchOpen((open) => !open)
                  }}
                  title="Im Dokument suchen (Strg/⌘+F)"
                >
                  Suchen
                </button>
                {!pageManagerOpen && (
                  <div className="toolbar-zoom">
                    <button
                      type="button"
                      onClick={() => setZoom((z) => zoomOut(z))}
                    >
                      −
                    </button>
                    <span className="zoom-label">
                      {Math.round(zoom * 100)} %
                    </span>
                    <button
                      type="button"
                      onClick={() => setZoom((z) => zoomIn(z))}
                    >
                      +
                    </button>
                  </div>
                )}
              </div>
              {!pageManagerOpen && <button aria-label={sourceTextOpen ? undefined : 'Originaltext korrigieren'} title={sourceTextOpen ? 'Textkorrektur schließen und zur normalen Ansicht zurückkehren' : 'Originaltext in derselben Schrift korrigieren'} disabled={pageBusy || cropActive || !!redactions.length} aria-pressed={sourceTextOpen} onClick={() => { if (sourceTextOpen) returnPageRef.current = viewedPageRef.current; else viewedPageRef.current = visiblePageIndex(); setPageManagerOpen(false); setSearchOpen(false); setSelectedId(null); setTool('select'); setSourceTextOpen(value => !value) }}>{sourceTextOpen ? 'Zur Dokumentbearbeitung' : 'Textkorrektur'}</button>}
              <div
                className="toolbar-history"
                role="group"
                aria-label="Verlauf"
              >
                <button
                  type="button"
                  aria-label="Rückgängig"
                  disabled={!(sourceHistory?.canUndo || (store.canUndo && !sourceHistory?.dirty)) || pageBusy || cropActive}
                  onClick={() => { if (sourceHistory?.canUndo) sourceHistory.undo(); else if (!sourceHistory?.dirty) store.undo() }}
                  title="Rückgängig (Strg+Z)"
                >
                  <svg
                    className="tool-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m9 5-5 5 5 5M4 10h9a6 6 0 0 1 0 12" />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label="Wiederholen"
                  disabled={!(sourceHistory?.canRedo || (store.canRedo && !sourceHistory?.dirty)) || pageBusy || cropActive}
                  onClick={() => { if (sourceHistory?.canRedo) sourceHistory.redo(); else if (!sourceHistory?.dirty) store.redo() }}
                  title="Wiederholen (Strg+Y)"
                >
                  <svg
                    className="tool-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m15 5 5 5-5 5M20 10h-9a6 6 0 0 0 0 12" />
                  </svg>
                </button>
              </div>
              <button
                type="button"
                className="export-button"
                disabled={
                  pageBusy ||
                  cropActive ||
                  redactions.length > 0 ||
                  !documentPages?.length
                }
                onClick={() => setExportDialogOpen(true)}
              >
                Exportieren
              </button>
            </>
          )}
        </div>
        {pdf && !pageManagerOpen && !sourceTextOpen && (
          <div
            className="toolbar-tools"
            role="group"
            aria-label="Bearbeitungswerkzeuge"
          >
            <div
              className="toolbar-tool-group"
              role="group"
              aria-label="Einfügen und Auswählen"
            >
              <span className="toolbar-group-label" aria-hidden="true">
                Einfügen und Auswählen
              </span>
              <div className="toolbar-group-actions">
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
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  title="PNG- oder JPG-Bild einfügen · auch per Drag & Drop"
                >
                  + Bild einfügen
                </button>
                <SymbolPicker
                  value={symbol}
                  active={tool === 'symbol'}
                  onPick={(nextSymbol) => {
                    setSymbol(nextSymbol)
                    setTool('symbol')
                  }}
                />
              </div>
            </div>
            <div
              className="toolbar-tool-group"
              role="group"
              aria-label="Zeichnen"
            >
              <span className="toolbar-group-label" aria-hidden="true">
                Zeichnen
              </span>
              <div className="toolbar-group-actions">
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
                  <svg
                    className="tool-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
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
                  <svg
                    className="tool-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m 4 14 10 -10 7 7 -10 10 H 7 l -3 -3 Z M 9 9 l 7 7 M 11 21 h 10" />
                  </svg>
                  Radierer
                </button>
                {SHAPE_TOOLS.filter((option) => option.tool === 'marker').map(
                  shapeToolButton,
                )}
              </div>
            </div>
            <div
              className="toolbar-tool-group toolbar-form-group"
              role="group"
              aria-label="Formen"
            >
              <span className="toolbar-group-label" aria-hidden="true">
                Formen
              </span>
              <div className="toolbar-group-actions">
                {SHAPE_TOOLS.filter((option) => option.tool !== 'marker').map(
                  shapeToolButton,
                )}
              </div>
            </div>
            <div
              className="toolbar-tool-group toolbar-confidential-group"
              role="group"
              aria-label="Vertraulich"
            >
              <span className="toolbar-group-label" aria-hidden="true">
                Vertraulich
              </span>
              <div className="toolbar-group-actions">
                <button
                  type="button"
                  className="tool"
                  aria-pressed={tool === 'redact'}
                  onClick={() => {
                    setSelectedId(null)
                    setTool('redact')
                  }}
                >
                  Schwärzen
                </button>
              </div>
            </div>
          </div>
        )}
      </header>
      {pdf && <p className="draft-save-status" role={visibleSave?.status === 'error' ? 'alert' : 'status'}>
        {saveMessage}
      </p>}
      {pdf&&!pageManagerOpen&&(tool==='redact'||redactions.length>0)&&<RedactionBar marks={redactions} fill={redactions.find(m=>m.id===selectedId)?.fill??redactionFill} onFill={fill=>{setRedactionFill(fill);const mark=redactions.find(m=>m.id===selectedId);if(mark)store.dispatch(replaceRedactions(store.state,redactions.map(m=>m.id===mark.id?{...m,fill}:m)))}} selected={selectedId} onRemove={()=>{store.dispatch(replaceRedactions(store.state,redactions.filter(m=>m.id!==selectedId)));setSelectedId(null)}} onClear={()=>{store.dispatch(replaceRedactions(store.state,[]));setSelectedId(null);setTool('select')}} onApply={()=>void onApplyRedactions()} busy={redactionBusy||pageBusy}/>}
      {redactionBusy&&<p role="status" className="redaction-notice">Seiten werden sicher gerastert und neu aufgebaut …</p>}
      {pdf&&(redactions.length>0||documentPages?.some(p=>p.redacted))&&<p className="redaction-notice">Originaldatei und lokale Entwürfe können vertrauliche Inhalte enthalten. Nur das geprüfte Export-PDF weitergeben. Gerasterte Seiten sind nicht mehr durchsuchbar; neue Textboxen bleiben echter Text.</p>}
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
          Wähle eine PDF-Datei oder ziehe sie in den Editor – oder öffne über <b>Entwürfe&nbsp;▾</b> einen früheren Stand.
        </p>
      )}
      {openingFile && <p role="status" className="hint">PDF wird geöffnet …</p>}
      <div className="workspace" ref={workspaceRef} inert={exportDialogOpen || redactionBusy || openingFile || exportBusy || !!loadingDraftId}>
        {pdf && searchOpen && !pageManagerOpen && !pageBusy && <SearchWindow pdf={pdf} overlays={overlays} onClose={closeSearch} onHits={onSearchHits} onJump={onSearchJump}/>}
        {pdf && pageManagerOpen && originalBytes && <PagesManager nativeWidgets={nativeWidgets} key={activeDraftId} pdf={pdf} store={store} original={originalBytes} busy={pageBusy} onCropActive={setCropActive} initialPage={viewedPageRef.current} onPage={onViewedPage} />}
        {pdf && sourceTextOpen && originalBytes && !pageBusy && <SourceTextPanel key={activeDraftId} store={store} original={originalBytes} initialPage={viewedPageRef.current} onPage={onViewedPage} onClose={() => { returnPageRef.current = viewedPageRef.current; setSourceTextOpen(false) }} onHistory={setSourceHistory} />}
        {!pageManagerOpen && !sourceTextOpen && <>
        {pageBusy && <p role="status" className="hint">Seitenansicht wird aktualisiert …</p>}
        {pdf && !pageBusy && (
          <DrawingToolbar workspaceRef={workspaceRef} tool={tool} color={strokeColor} width={strokeWidth}
            eraserRadius={eraserRadius} onColor={setStrokeColor} onWidth={setStrokeWidth} onEraserRadius={setEraserRadius} />
        )}
        {pdf && !pageBusy && (tool==='select' || isShapeTool(tool)) && selectedShape && isShape(selectedShape) && shapePageSize?.pdf===pdf && shapePageSize.pageIndex===shapePage && <ShapeToolbar
          key={activeDraftId} workspaceRef={workspaceRef} shape={selectedShape} pageSize={shapePageSize.size} store={store} onSelect={setSelectedId}
          onStyle={shape=>{const next={fill:shape.fill,strokeColor:shape.strokeColor,strokeWidth:shape.strokeWidth};if(shape.shape==='marker')setMarkerStyle(next);else setShapeStyle(next)}} />}
        {formInfo?.pages === documentPages && !!formInfo?.unsupported.length && <p className="hint" role="status">Nicht unterstützte Formularfelder bleiben unverändert: {formInfo.unsupported.join(', ')}. Signaturen, XFA und PDF-JavaScript werden nicht ausgeführt oder neu erstellt.</p>}
        <div className="pages">
        {pdf && !pageBusy &&
          (documentPages ?? Array.from({length:pdf.pageCount},(_,index)=>({id:String(index)}))).map((page,index) => (
            <VirtualPage
              key={`${activeDraftId}-${page.id}`}
              index={index}
              size={documentPages ? pageSize(documentPages[index]) : undefined}
              zoom={zoom}
              keepMounted={overlays.some(overlay => overlay.id === selectedId && overlay.pageIndex === index) || redactions.some(mark => mark.id === selectedId && mark.pageId === page.id)}
            >
            <PageView
              pdf={pdf}
              searchHits={searchOpen?searchResult.hits.filter(hit=>hit.pageIndex===index):[]}
              activeSearchHit={searchOpen?searchResult.hits[searchResult.active]:undefined}
              redactionFill={redactionFill}
              nativeWidgets={nativeWidgets}
              highlightFields={highlightFields}
              onFormError={setError}
              pageIndex={index}
              zoom={zoom}
              tool={tool}
              symbol={symbol}
              strokeColor={strokeColor}
              strokeWidth={strokeWidth}
              eraserRadius={eraserRadius}
              shapeStyle={shapeStyle}
              markerStyle={markerStyle}
              overlays={overlays}
              store={store}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onImageDrop={(file, pageIndex, point) => void onImportImage(file, pageIndex, point)}
            />
            </VirtualPage>
          ))}
        </div>
        </>}
      </div>
      {exportDialogOpen && <ExportDialog onCancel={()=>setExportDialogOpen(false)} onPrepare={prepareExport} onDownload={downloadExport}/> }
      {passwordRequest && <PasswordDialog key={passwordEpoch.current} request={passwordRequest}/>}
      {pdf && !pageManagerOpen && !sourceTextOpen && !pageBusy && (
        <footer
          className="drawing-footer"
          inert={
            exportDialogOpen ||
            redactionBusy ||
            openingFile ||
            exportBusy ||
            !!loadingDraftId
          }
        >
          {nativeWidgets.length > 0 && (
            <label className="native-highlight-toggle">
              <input
                type="checkbox"
                checked={highlightFields}
                onChange={(event) => setHighlightFields(event.target.checked)}
              />{' '}
              Felder hervorheben
            </label>
          )}
          <button
            type="button"
            disabled={!overlays.some((o) => isStroke(o) || isMarker(o))}
            title="Freihandstriche und Textmarker löschen · Formen, Texte, Bilder und PDF bleiben erhalten"
            onClick={() => {
              if (store.state.overlays.some((o) => isStroke(o) || isMarker(o)))
                store.dispatch(clearDrawing(store.state.overlays))
            }}
          >
            Zeichnung löschen
          </button>
        </footer>
      )}
    </div>
  )
}
