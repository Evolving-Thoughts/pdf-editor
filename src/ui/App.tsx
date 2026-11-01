import { SourceTextPanel } from './SourceTextPanel'
import type { SourceHistory } from './SourceTextPanel'
import { ExportDialog } from './ExportDialog'
import { useDraftPersistence } from './useDraftPersistence'
import { useExportFlow } from './useExportFlow'
import { ToolbarTools } from './ToolbarTools'
import { inspectStructures, type TextIssue } from '../core/pdf/preflight'
import { setMetadataCommand } from '../core/pdf/metadata'
import { IncorrectPasswordError } from '../core/pdf/unlockPdf'
import { DocumentProblem } from '../core/pdf/documentBudget'
import { historyStep } from '../core/sourceText/draftHistory'
import { PasswordDialog, type PasswordRequest } from './PasswordDialog'
import { SearchWindow } from './SearchWindow'
import type { SearchHit } from '../core/search'
import { applyRedactionResult,replaceRedactions,type Redaction } from '../core/redactions'
import { prepareRedaction } from '../core/pdf/redactDocument'
import { RedactionBar } from './RedactionBar'
import type { NativeWidget } from '../core/forms'
import { inspectNativeForms, needsNativeFormInspection } from '../core/pdf/acroForm'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { addOverlay, clearDrawing, removeOverlay } from '../core/commands'
import { EditorStore } from '../core/editorStore'
import { DocumentSession } from '../core/documentSession'
import { createId, isImage, isMarker, isShape, isStroke, isTextbox } from '../core/model'
import { deleteDraft, DRAFT_SIZE_WARN_BYTES, loadDraft } from '../core/persistence/drafts'
import { loadPdf } from '../core/pdf/loadPdf'
import { importImage } from '../core/images/importImage'
import { initialImageGeometry } from '../core/images/geometry'
import type { ShapeStyle } from '../core/shapes'
import { ShapeToolbar } from './ShapeToolbar'
import { isShapeTool } from './tools'
import { zoomIn, zoomOut } from '../core/viewerState'
import { DraftsMenu } from './DraftsMenu'
import { DocumentMenu } from './DocumentMenu'
import { DocumentInfoDialog } from './DocumentInfoDialog'
import { PageLabelsDialog } from './PageLabelsDialog'
import { OcrDialog } from './OcrDialog'
import { TablePanel } from './TablePanel'
import { DrawingToolbar } from './DrawingToolbar'
import { PageView } from './PageView'
import { VirtualPage } from './VirtualPage'
import { EditorViews } from '../core/editorViews'
import { saveBeforeLeaving, UnsavedDraftError } from '../core/persistence/draftSaver'
import { largestVisiblePage, polygonCenter, scrollToPoint, visibleCenter } from '../core/pageViewport'
import { arrowStep, nudgeCommand } from '../core/overlayGesture'
import { PagesManager } from './PagesManager'
import { pageSize, type DocumentPage } from '../core/pages'
import type { ChosenStamp } from './StampPicker'
import { renderStampImage } from './stampImage'
import { stampOverlay } from '../core/stamps'
import type { Tool } from './tools'
import './app.css'

export default function App() {
  const [views] = useState(() => new EditorViews())
  useSyncExternalStore(views.subscribe, views.getVersion)
  const { dialog: documentDialog, searchOpen } = views
  const pageManagerOpen = views.main === 'pages', sourceTextOpen = views.main === 'sourceText', tableOpen = views.main === 'table'
  // Unchecked inline drafts of the correction panel come before document history.
  const [sourceHistory, setSourceHistory] = useState<SourceHistory | null>(null)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [signedDocument, setSignedDocument] = useState<ArrayBuffer | null>(null)
  const [searchResult, setSearchResult] = useState<{
    hits: SearchHit[]
    active: number
  }>({ hits: [], active: 0 })
  const [passwordRequest, setPasswordRequest] = useState<PasswordRequest | null>(
    null,
  )
  const passwordPending = useRef<((password: string | null) => void) | null>(null)
  const [passwordEpoch, setPasswordEpoch] = useState(0)
  const searchButtonRef = useRef<HTMLButtonElement>(null)
  const onSearchHits = useCallback(
    (hits: SearchHit[], active: number) => setSearchResult({ hits, active }),
    [],
  )
  const closeSearch = useCallback(() => {
    views.closeSearch()
    requestAnimationFrame(() => searchButtonRef.current?.focus())
  }, [views])

  const [redactionFill,setRedactionFill]=useState<Redaction['fill']>('black')
  const [highlightFields, setHighlightFields] = useState(true)
  const [formInfo, setFormInfo] = useState<{ pages: DocumentPage[]; widgets: NativeWidget[]; unsupported: string[] } | null>(null)
  const [cropActive, setCropActive] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [tool, setTool] = useState<Tool>('select')
  const [symbol, setSymbol] = useState('✓')
  const [stamp, setStamp] = useState<ChosenStamp | null>(null)
  const [strokeColor, setStrokeColor] = useState('#111111')
  const [strokeWidth, setStrokeWidth] = useState(3)
  const [shapeStyle,setShapeStyle] = useState<ShapeStyle>({fill:null,strokeColor:'#2455c7',strokeWidth:3})
  const [markerStyle,setMarkerStyle] = useState<ShapeStyle>({fill:null,strokeColor:'#ffe34d',strokeWidth:24})
  const [eraserRadius, setEraserRadius] = useState(8)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const imageImportRef = useRef(0)
  const workspaceRef = useRef<HTMLDivElement>(null)
  // Editor state lives in the framework-free store (ADR-002/ADR-004);
  // React re-renders on store notifications.
  const [store] = useState(() => new EditorStore())
  useSyncExternalStore(store.subscribe, store.getVersion)
  const undoStep = historyStep(!!sourceHistory?.canUndo, !!sourceHistory?.dirty, store.canUndo)
  const redoStep = historyStep(!!sourceHistory?.canRedo, !!sourceHistory?.dirty, store.canRedo)
  const [session] = useState(() => new DocumentSession(store, loadPdf))
  useSyncExternalStore(session.subscribe, session.getVersion)
  const scrollerBox = useCallback(() => workspaceRef.current?.querySelector<HTMLElement>('.pages') ?? null, [])
  const pageElement = useCallback((index: number) => scrollerBox()?.querySelector<HTMLElement>(`.page[data-page-index="${index}"]`) ?? null, [scrollerBox])
  const visiblePageIndex = useCallback(() => {
    const scroller = scrollerBox()
    if (!scroller) return views.viewedPage
    const pages = Array.from(scroller.querySelectorAll<HTMLElement>('.page[data-page-index]'), page =>
      ({ index: Number(page.dataset.pageIndex), box: page.getBoundingClientRect() }))
    return largestVisiblePage(pages, scroller.getBoundingClientRect(), views.viewedPage)
  }, [scrollerBox, views])
  const takeSnapshot = useCallback(() => session.snapshot(), [session])
  const onViewedPage = useCallback((index: number) => { views.rememberPage(index) }, [views])

  const { pdf, activeDraftId, loadingDraftId, busy, pagesStale: pageBusy, original: originalBytes } = session
  const redactionBusy = session.running('redacting'), openingFile = session.running('opening')
  const sizeWarning = (originalBytes?.byteLength ?? 0) > DRAFT_SIZE_WARN_BYTES
  const {
    drafts, draftsError, manualSave, saver, forgetDraft, noteInput,
    pauseSaving, reportDraftProblem, persistActiveDraft, onManualSave, onDraftsMenuOpen,
  } = useDraftPersistence(store, session)
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
  useEffect(() => {
    if (!originalBytes) return
    let cancelled = false
    void inspectStructures(new Uint8Array(originalBytes)).then(findings => {
      if (!cancelled) setSignedDocument(findings.some(item => item.kind === 'signature' && item.state === 'present') ? originalBytes : null)
    })
    return () => { cancelled = true }
  }, [originalBytes])
  const { checkExport, prepareExport, downloadExport } = useExportFlow(store, session, pageBusy)
  useEffect(() => session.refreshPages(problem => {
    setError(problem instanceof Error ? problem.message : 'Die Seiten konnten nicht aktualisiert werden.')
  }), [documentPages, session])
  const selectedShape = overlays.find(o=>o.id===selectedId && isShape(o))
  const shapePage = selectedShape ? documentPages?.find(page => page.id === selectedShape.pageId) : undefined

  const resetView = useCallback(() => {
    views.reset()
    setSelectedId(null)
    setTool('select')
    setRedactionFill('black')
    setCropActive(false)
  }, [views])

  const askPassword = useCallback((fileName: string, problem: string | null) => new Promise<string | null>((resolve) => {
    const finish = (value: string | null) => {
      passwordPending.current = null
      setPasswordRequest(null)
      resolve(value)
    }
    passwordPending.current = finish
    setPasswordEpoch(epoch => epoch + 1)
    setPasswordRequest({ fileName, error: problem, resolve: finish })
  }), [])

  const saveCurrentDraft = useCallback(() => saveBeforeLeaving(persistActiveDraft, (problem) => {
    reportDraftProblem(problem, 'Der bisherige Entwurf konnte nicht gespeichert werden.')
    return window.confirm('Der bisherige Entwurf konnte nicht gespeichert werden, zum Beispiel weil der Speicher voll ist. Ungespeicherte Änderungen verwerfen und trotzdem öffnen?')
  }), [persistActiveDraft, reportDraftProblem])

  const onOpenFile = useCallback(
    async (file: File) => {
      passwordPending.current?.(null)
      setError(null)
      try {
        if (!await session.openFile(file, { save: saveCurrentDraft, beforeReplace: pauseSaving, askPassword })) return
        resetView()
        void persistActiveDraft().catch((problem) =>
          reportDraftProblem(
            problem,
            'Der neue Entwurf konnte nicht gespeichert werden.',
          ),
        )
      } catch (problem) {
        if (problem instanceof UnsavedDraftError) return
        setError(
          problem instanceof IncorrectPasswordError
            ? problem.message
            : `„${file.name}“ konnte nicht geöffnet werden. ${problem instanceof DocumentProblem ? problem.message : 'Datei beschädigt, kein gültiges PDF oder bisheriger Entwurf nicht speicherbar. Der bisherige Stand bleibt geöffnet.'}`,
        )
      }
    },
    [askPassword, pauseSaving, persistActiveDraft, reportDraftProblem, resetView, saveCurrentDraft, session],
  )

  const onOpenDraft = useCallback(
    async (id: string) => {
      if (session.loadingDraftId) return
      setError(null)
      try {
        const outcome = await session.openDraft(id, {
          save: saveCurrentDraft,
          read: () => saver.queue(db => loadDraft(db, id)),
          beforeReplace: pauseSaving,
        })
        if (outcome === 'opened') resetView()
        if (outcome === 'missing') {
          forgetDraft(id)
          setError('Dieser Entwurf ist nicht mehr vorhanden.')
        }
      } catch (problem) {
        if (!(problem instanceof UnsavedDraftError)) setError('Der Entwurf konnte nicht geöffnet werden.')
      }
    },
    [forgetDraft, pauseSaving, resetView, saveCurrentDraft, saver, session],
  )

  const onDeleteDraft = useCallback(
    async (id: string) => {
      const draft = drafts.find((item) => item.id === id)
      if (draft && !window.confirm(`Entwurf „${draft.name}“ löschen? Das kann nicht rückgängig gemacht werden.`)) {
        return
      }
      const isActive = id === session.activeDraftId
      const remove = () => saver.queue(db => deleteDraft(db, id))
      try {
        if (isActive) {
          await session.deleteDraft({
            pauseSaving,
            remove,
            // Keeps edits made during the confirmation/DB round trip.
            save: () => void persistActiveDraft().catch((saveProblem) =>
              reportDraftProblem(saveProblem, 'Der Entwurf konnte nicht gespeichert werden.'),
            ),
          })
          setSelectedId(null)
        } else await remove()
        forgetDraft(id)
      } catch (problem) {
        reportDraftProblem(problem, 'Der Entwurf konnte nicht gelöscht werden.')
      }
    },
    [drafts, forgetDraft, pauseSaving, persistActiveDraft, reportDraftProblem, saver, session],
  )

  // Release the worker document when the app unmounts.
  useEffect(() => () => { passwordPending.current?.(null); session.dispose() }, [session])

  const onImportImage = useCallback(async (file: File, targetPage?: number, dropPoint?: { x: number; y: number }) => {
    const handle = session.pdf
    if (!handle) return
    const watch = session.watch()
    const request = ++imageImportRef.current
    const stillCurrent = () => session.pdf === handle && watch.sameDocument() && imageImportRef.current === request
    setError(null)
    try {
      // Pick the page with the largest visible area, not always page one.
      const pageIndex = targetPage ?? visiblePageIndex()
      const pageId = store.state.pages![pageIndex].id
      const rect = pageElement(pageIndex)?.getBoundingClientRect()
      const view = scrollerBox()?.getBoundingClientRect()
      const source = await importImage(file)
      if (!stillCurrent()) return
      const pageSize = await handle.getPageSize(pageIndex + 1)
      if (!stillCurrent()) return
      const center = dropPoint ?? (rect && view ? visibleCenter(rect, view, zoom, pageSize.height) : { x: pageSize.width / 2, y: pageSize.height / 2 })
      const image = { ...source, ...initialImageGeometry(source.pixelWidth, source.pixelHeight, pageSize, center),
        kind: 'image' as const, id: createId(), pageId }
      store.dispatch(addOverlay(image))
      setTool('select')
      setSelectedId(image.id)
    } catch (problem) {
      if (stillCurrent()) setError(problem instanceof Error ? problem.message : 'Das Bild konnte nicht geladen werden.')
    }
  }, [pageElement, scrollerBox, session, store, visiblePageIndex, zoom])

  // Global shortcuts. While a textarea is focused, it keeps its own editing
  // keys (Escape blurs there, see TextboxView).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('dialog')) return
      if (sourceTextOpen || busy || pageBusy || (pageManagerOpen && cropActive)) return
      if (pdf && (event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='f') {
        event.preventDefault();views.openSearch(visiblePageIndex());setSelectedId(null);return
      }
      if (target.closest('textarea, input, select, [contenteditable]')) return
      if (event.key === 'Escape') {
        setSelectedId(null)
        setTool('select')
        window.getSelection()?.removeAllRanges()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        const mark=store.state.redactions?.find(m=>m.id===selectedId)
        if(mark){event.preventDefault();store.dispatch(replaceRedactions(store.state,store.state.redactions!.filter(m=>m.id!==mark.id)));setSelectedId(null);return}
        const box = store.state.overlays.find((o) => o.id === selectedId)
        if (box && (isTextbox(box) || isImage(box) || isShape(box))) {
          event.preventDefault()
          store.dispatch(removeOverlay(box))
          setSelectedId(null)
        }
        return
      }
      const step = selectedId ? arrowStep(event) : null
      if (step) {
        const box = store.state.overlays.find((o) => o.id === selectedId)
        if (!box || isStroke(box)) return
        event.preventDefault()
        const page = store.state.pages?.find((candidate) => candidate.id === box.pageId)
        const command = page && nudgeCommand(box, step, pageSize(page))
        if (command) store.dispatch(command)
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
  }, [sourceTextOpen, store, selectedId, pageBusy, pageManagerOpen, cropActive, busy, pdf, views, visiblePageIndex])

  const placeStamp = useCallback((pageId: string, point: { x: number; y: number }, page: { width: number; height: number }) => {
    if (!stamp) return
    try {
      store.dispatch(addOverlay(stampOverlay(renderStampImage(stamp.lines, stamp.design.color), stamp.design.text, pageId, point, page)))
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Der Stempel konnte nicht platziert werden.')
    }
  }, [stamp, store])

  const onSearchJump = useCallback(
    (hit: SearchHit) => {
      const scroller = scrollerBox()
      const page = pageElement(hit.pageIndex)
      if (!scroller || !page || !hit.polygons[0]?.length) return
      const panel = workspaceRef.current?.querySelector<HTMLElement>('.search-window')?.getBoundingClientRect()
      const distance = scrollToPoint(polygonCenter(hit.polygons[0]), page.getBoundingClientRect(), scroller.getBoundingClientRect(), zoom,
        { width: scroller.clientWidth, height: scroller.clientHeight }, panel)
      scroller.scrollTo({ left: scroller.scrollLeft + distance.left, top: scroller.scrollTop + distance.top })
    },
    [pageElement, scrollerBox, zoom],
  )

  useEffect(() => {
    const index = views.returnPage
    if (index === null || pageManagerOpen || sourceTextOpen || tableOpen || pageBusy || !pdf) return
    let frame = 0, tries = 0
    // Page boxes get their size once the page geometry is known: retry briefly.
    const scroll = () => {
      const scroller = scrollerBox()
      const page = pageElement(index)
      if (scroller && page && page.offsetHeight > 0) {
        scroller.scrollTop += page.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12
        views.returned()
        if (tries++ < 3) frame = requestAnimationFrame(scroll)
        else return
      } else if (tries++ < 30) frame = requestAnimationFrame(scroll)
    }
    frame = requestAnimationFrame(scroll)
    return () => cancelAnimationFrame(frame)
  }, [pageElement, pageManagerOpen, scrollerBox, sourceTextOpen, tableOpen, pageBusy, pdf, views])

  const jumpToIssue = useCallback((issue: TextIssue) => {
    setExportDialogOpen(false)
    views.showDocument()
    setTool('select')
    setSelectedId(issue.overlayId)
    requestAnimationFrame(() => pageElement(issue.pageIndex)?.scrollIntoView({ block: 'center' }))
  }, [pageElement, views])
  const onApplyRedactions = async () => {
    const draft=session.draft
    if(!draft||redactionBusy||pageBusy||!store.state.redactions?.length)return
    setError(null)
    const task=session.begin('redacting')
    try {
      const prepared=await prepareRedaction(new Uint8Array(draft.bytes),store.state)
      if(!task.sameState())throw new Error('Der Stand hat sich geändert. Schwärzung bitte erneut prüfen und anwenden.')
      store.dispatch(applyRedactionResult(store.state,prepared.source,prepared.replacements,prepared.newText))
      setSelectedId(prepared.newText[0]?.id??null);setTool(prepared.newText.length?'text':'select')
    } catch(problem) {if(session.draft===draft)setError(problem instanceof Error?problem.message:'Die Schwärzung konnte nicht angewendet werden. Der Stand bleibt unverändert.')}
    finally {task.finish()}
  }

  const visibleSave = manualSave?.draftId === activeDraftId &&
    (manualSave.status !== 'saved' || manualSave.version === store.getVersion()) ? manualSave : null
  const saveMessage = visibleSave?.status === 'saving' ? 'Entwurf wird gespeichert …'
    : visibleSave?.status === 'saved' ? '✓ Entwurf gespeichert · Nur auf diesem Gerät.'
    : visibleSave?.status === 'error' ? 'Der Entwurf konnte nicht gespeichert werden. Bitte erneut versuchen.'
    : 'Automatisches Speichern ist aktiv · Entwürfe bleiben unverschlüsselt auf diesem Gerät.'

  return (
    <div className="app" onDragOverCapture={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy'}}}
      onDropCapture={event=>{
        const files=Array.from(event.dataTransfer.files)
        if(!files.length)return
        if(exportDialogOpen){event.preventDefault();event.stopPropagation();return}
        const pdfFiles=files.filter(file=>file.type==='application/pdf'||/\.pdf$/i.test(file.name))
        if(!pdfFiles.length && (event.target as HTMLElement).closest('.page') && files.every(file=>/^image\/(png|jpeg)$/.test(file.type)))return
        event.preventDefault();event.stopPropagation()
        if(busy||pageBusy||cropActive)return
        if(files.length!==1||pdfFiles.length!==1){setError('Bitte genau eine PDF-Datei zum Öffnen ziehen. Bilder auf einer Dokumentseite ablegen.');return}
        void onOpenFile(pdfFiles[0])
      }} onChange={event => {
      if ((event.target as HTMLElement).closest('.export-dialog')) return
      noteInput()
    }}>
      <header
        className="toolbar"
        inert={
          exportDialogOpen ||
          busy
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
                  <span className="compact-hide">
                    {visibleSave?.status === 'saving'
                      ? 'Speichert …'
                      : 'Speichern'}
                  </span>
                </button>
                {!pageManagerOpen && <DocumentMenu
                  disabled={pageBusy || cropActive || redactions.length > 0}
                  items={[
                    { label: 'Dokumentinfo …', onSelect: () => views.openDialog('info', visiblePageIndex()) },
                    { label: 'Seitenzahlen, Kopf- und Fußzeile …', onSelect: () => views.openDialog('labels', visiblePageIndex()) },
                    { label: 'Text erkennen (OCR) …', onSelect: () => views.openDialog('ocr', visiblePageIndex()) },
                    { label: 'Tabelle exportieren …', onSelect: () => { views.openTable(visiblePageIndex()); setSelectedId(null); setTool('select') } },
                  ]}
                />}
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
                    views.togglePages(visiblePageIndex())
                    setSelectedId(null)
                    setCropActive(false)
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
                    views.toggleSearch(visiblePageIndex())
                    setSelectedId(null)
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
              {!pageManagerOpen && <button aria-label={sourceTextOpen ? undefined : 'Originaltext korrigieren'} title={sourceTextOpen ? 'Textkorrektur schließen und zur normalen Ansicht zurückkehren' : 'Originaltext in derselben Schrift korrigieren'} disabled={pageBusy || cropActive || !!redactions.length} aria-pressed={sourceTextOpen} onClick={() => { views.toggleSourceText(visiblePageIndex()); setSelectedId(null); setTool('select') }}>{sourceTextOpen ? 'Zur Dokumentbearbeitung' : 'Textkorrektur'}</button>}
              <div
                className="toolbar-history"
                role="group"
                aria-label="Verlauf"
              >
                <button
                  type="button"
                  aria-label="Rückgängig"
                  disabled={!undoStep || pageBusy || cropActive}
                  onClick={() => { if (undoStep === 'draft') sourceHistory?.undo(); else if (undoStep === 'document') store.undo() }}
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
                  disabled={!redoStep || pageBusy || cropActive}
                  onClick={() => { if (redoStep === 'draft') sourceHistory?.redo(); else if (redoStep === 'document') store.redo() }}
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
        {pdf && !pageManagerOpen && !sourceTextOpen && !tableOpen && (
          <ToolbarTools
            tool={tool}
            symbol={symbol}
            imageInputRef={imageInputRef}
            onTool={setTool}
            onClearSelection={() => setSelectedId(null)}
            onSymbol={setSymbol}
            onStamp={setStamp}
          />
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
      {signedDocument === originalBytes && originalBytes && <p role="status" className="hint">Dieses PDF ist digital signiert. Jede Änderung macht die Signatur ungültig.</p>}
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
      <div className="workspace" ref={workspaceRef} inert={exportDialogOpen || busy}>
        {pdf && searchOpen && !pageManagerOpen && !pageBusy && <SearchWindow pdf={pdf} overlays={overlays} pages={documentPages ?? []} onClose={closeSearch} onHits={onSearchHits} onJump={onSearchJump}/>}
        {pdf && pageManagerOpen && originalBytes && <PagesManager nativeWidgets={nativeWidgets} key={activeDraftId} pdf={pdf} store={store} original={originalBytes} snapshot={takeSnapshot} busy={pageBusy} onCropActive={setCropActive} initialPage={views.viewedPage} onPage={onViewedPage} />}
        {pdf && sourceTextOpen && originalBytes && !pageBusy && <SourceTextPanel key={activeDraftId} store={store} original={originalBytes} initialPage={views.viewedPage} onPage={onViewedPage} onClose={() => views.closeMain()} onHistory={setSourceHistory} />}
        {pdf && tableOpen && documentPages && <TablePanel key={activeDraftId} pdf={pdf} pages={documentPages} fileName={pdf.fileName} initialPage={views.viewedPage} onClose={() => views.closeMain()} />}
        {!pageManagerOpen && !sourceTextOpen && !tableOpen && <>
        {pageBusy && <p role="status" className="hint">Seitenansicht wird aktualisiert …</p>}
        {pdf && !pageBusy && (
          <DrawingToolbar workspaceRef={workspaceRef} tool={tool} color={strokeColor} width={strokeWidth}
            eraserRadius={eraserRadius} onColor={setStrokeColor} onWidth={setStrokeWidth} onEraserRadius={setEraserRadius} />
        )}
        {pdf && !pageBusy && (tool==='select' || isShapeTool(tool)) && selectedShape && isShape(selectedShape) && shapePage && <ShapeToolbar
          key={activeDraftId} workspaceRef={workspaceRef} shape={selectedShape} pageSize={pageSize(shapePage)} store={store} onSelect={setSelectedId}
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
              keepMounted={overlays.some(overlay => overlay.id === selectedId && overlay.pageId === page.id) || redactions.some(mark => mark.id === selectedId && mark.pageId === page.id)}
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
              pageId={page.id}
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
              onPlaceStamp={placeStamp}
            />
            </VirtualPage>
          ))}
        </div>
        </>}
      </div>
      {exportDialogOpen && <ExportDialog onCancel={()=>setExportDialogOpen(false)} onCheck={checkExport} onJump={jumpToIssue} onPrepare={prepareExport} onDownload={downloadExport}/> }
      {documentDialog === 'info' && originalBytes && <DocumentInfoDialog original={originalBytes} edit={store.state.metadata} onApply={edit => store.dispatch(setMetadataCommand(store.state.metadata, edit))} onClose={() => views.closeDialog()} />}
      {documentDialog === 'labels' && pdf && <PageLabelsDialog pdf={pdf} store={store} onClose={() => views.closeDialog()} />}
      {documentDialog === 'ocr' && pdf && <OcrDialog pdf={pdf} store={store} initialPage={views.viewedPage} onClose={() => views.closeDialog()} />}
      {passwordRequest && <PasswordDialog key={passwordEpoch} request={passwordRequest}/>}
      {pdf && !pageManagerOpen && !sourceTextOpen && !tableOpen && !pageBusy && (
        <footer
          className="drawing-footer"
          inert={
            exportDialogOpen ||
            busy
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
