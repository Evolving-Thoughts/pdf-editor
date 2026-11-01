import type { NativeWidget } from '../core/forms'
import { selectPages, type PageSelectionGesture } from '../core/pageSelection'
import { downloadPdf } from '../core/pdf/downloadPdf'
import { useEffect, useRef, useState } from 'react'
import { EditorStore } from '../core/editorStore'
import {
  a4Size,
  commonPreviewScale,
  replacePageDocument,
  cropPage,
  deletePages,
  insertPages,
  insertionPageSize,
  movePage,
  pageSize,
  pagePreviewSize,
  rotatePages,
  type CropMargins,
} from '../core/pages'
import { importPageFile, preparePages, textPageBytes } from '../core/pdf/pageOperations'
import { extractInWorker, preflightInWorker } from '../core/pdf/exportJob'
import { selectDocument, type DocumentSnapshot } from '../core/pdf/documentOutput'
import { reviewExtraction } from '../core/pdf/preflight'
import { loadPdf, type PdfHandle } from '../core/pdf/loadPdf'
import { normalizeA4 } from '../core/pdf/normalizeA4'
import { PageView } from './PageView'
import { PageThumbnail } from './PageThumbnail'

const MM = 72 / 25.4
const zero = (): CropMargins => ({ left: 0, top: 0, right: 0, bottom: 0 })
const labels = { left: 'Links', top: 'Oben', right: 'Rechts', bottom: 'Unten' }
const noSelect = () => {}
const pageCount = (count: number) => `${count} ${count === 1 ? 'Seite' : 'Seiten'}`
function RotateIcon({ clockwise }: { clockwise: boolean }) {
  return (
    <svg
      className="tool-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
      style={clockwise ? undefined : { transform: 'scaleX(-1)' }}
    >
      <path d="M20 10a8 8 0 1 0-1 8M20 3v7h-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
const defaultStyle = { fill: null, strokeColor: '#2455c7', strokeWidth: 3 }

interface Props {
  nativeWidgets?: NativeWidget[]
  pdf: PdfHandle
  store: EditorStore
  original: ArrayBuffer
  busy: boolean
  onCropActive: (active: boolean) => void
  /** Page index shown first (the page viewed before opening). */
  initialPage?: number
  onPage?: (index: number) => void
  snapshot: () => DocumentSnapshot
}
export function PagesManager({ nativeWidgets = [], pdf, store, original, snapshot, busy, onCropActive, initialPage = 0, onPage }: Props) {
  const pages = store.state.pages ?? []
  const first = pages[initialPage] ?? pages[0]
  const [selected, setSelected] = useState(first?.id ?? '')
  const [checkedIds, setCheckedIds] = useState<string[]>(first ? [first.id] : [])
  const anchor = useRef<string | null>(first?.id ?? null)
  const checked = new Set(checkedIds)
  const selection = pages.filter(page => checked.has(page.id)).map(page => page.id)
  const [deletePending, setDeletePending] = useState<{ ids: string[]; version: number } | null>(null)
  const page = pages.find((p) => p.id === selected) ?? pages[0]
  const listRef = useRef<HTMLDivElement>(null)
  const pageIndex = pages.findIndex((p) => p.id === page?.id)
  useEffect(() => { if (pageIndex >= 0) onPage?.(pageIndex) }, [pageIndex, onPage])
  // Open at the page viewed before: show its row in the list.
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('.page-manager-row.previewed')?.scrollIntoView({ block: 'nearest' }) }, [])
  const index = page ? pages.indexOf(page) : -1
  const [crop, setCrop] = useState<{ id: string; margins: CropMargins } | null>(null)
  const [a4Open, setA4Open] = useState(false)
  const [a4Preview, setA4Preview] = useState<{ pdf: PdfHandle; prepared: Awaited<ReturnType<typeof normalizeA4>>; store: EditorStore; version: number } | null>(null)
  const activeCrop = crop?.id === page?.id ? crop : null
  const [message, setMessage] = useState('Wähle eine Seite oder füge neue Seiten ein.')
  const [problem, setProblem] = useState<string | null>(null)
  const [inserting, setInserting] = useState(false)
  const [source, setSource] = useState('file')
  const [position, setPosition] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState('')
  const [working, setWorking] = useState(false)
  const [extractCheck, setExtractCheck] = useState<{ ids: string[]; version: number; messages: string[] } | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState({ width: 600, height: 700 })
  const request = useRef(0)
  const dragId = useRef<string | null>(null)
  const size = page ? pageSize(page) : { width: 595, height: 842 }
  // A common scale makes physical dimensions comparable between selections.
  const shownSize = a4Open ? a4Size(size) : size
  const scale = commonPreviewScale(pages.map(p => a4Open ? a4Size(pageSize(p)) : pagePreviewSize(p)), available)
  const marginsFit = (m: CropMargins) =>
    Object.values(m).every((v) => Number.isFinite(v) && v >= 0) &&
    size.width - m.left - m.right >= 20 * MM - 1e-6 &&
    size.height - m.top - m.bottom >= 20 * MM - 1e-6
  const frameMargins = activeCrop && marginsFit(activeCrop.margins) ? activeCrop.margins : zero()
  const locked = busy || working || !!activeCrop || a4Open || !!deletePending || !!extractCheck
  useEffect(() => {
    onCropActive(!!activeCrop || a4Open || !!deletePending)
    return () => onCropActive(false)
  }, [activeCrop, a4Open, deletePending, onCropActive])
  useEffect(() => () => { void a4Preview?.pdf.destroy().catch(() => {}) }, [a4Preview])
  useEffect(
    () => () => {
      request.current++
    },
    [],
  )
  useEffect(() => {
    if (inserting) dialogRef.current?.showModal()
  }, [inserting])
  useEffect(() => {
    const el = previewRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setAvailable({ width: r.width, height: Math.max(1, r.height) })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!activeCrop && !a4Open && !deletePending) return
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCrop(null)
        setDeletePending(null)
        request.current++
        setA4Open(false); setA4Preview(null); setWorking(false)
        setMessage(deletePending ? 'Löschen abgebrochen. Seiten unverändert.' : a4Open ? 'A4-Umstellung abgebrochen. Seiten unverändert.' : 'Zuschnitt abgebrochen. Seite unverändert.')
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [activeCrop, a4Open, deletePending])
  function run(work: () => void, message: string) {
    try {
      work()
      setProblem(null)
      setMessage(message)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Die Seitenoperation ist fehlgeschlagen.')
    }
  }
  function choosePage(id: string, gesture: PageSelectionGesture = {}) {
    if (busy || working || deletePending) return
    setSelected(id)
    setCrop(null)
    setProblem(null)
    if (!locked) {
      const next = selectPages(pages.map(p => p.id), selection, anchor.current, id, gesture)
      setCheckedIds(next.ids)
      anchor.current = next.anchor
    }
    setMessage(activeCrop ? 'Offenen Zuschnitt verworfen.' : a4Open ? 'A4-Vorschau: Erst Anwenden verändert die Seiten.' : gesture.range || gesture.toggle || gesture.checked !== undefined ? 'Gemeinsame Seitenauswahl aktualisiert.' : 'Seite für Vorschau und Aktionen ausgewählt.')
  }
  const pageProps = {
    nativeWidgets,
    pdf,
    store,
    overlays: store.state.overlays,
    tool: 'select' as const,
    symbol: '✓',
    selectedId: null,
    onSelect: noSelect,
    onImageDrop: noSelect,
    shapeStyle: defaultStyle,
    markerStyle: defaultStyle,
    readOnly: true,
  }
  async function openA4() {
    if (locked || !pages.length) return
    const token = ++request.current, version = store.getVersion()
    setA4Open(true); setWorking(true); setProblem(null)
    try {
      const prepared = await normalizeA4(snapshot())
      if (request.current !== token) return
      const previewPdf = await loadPdf('A4-Vorschau', new Uint8Array(prepared.source.bytes))
      if (request.current !== token) { await previewPdf.destroy(); return }
      if (store.getVersion() !== version) { await previewPdf.destroy(); throw new Error('Der Arbeitsstand hat sich geändert. Bitte erneut öffnen.') }
      const previewStore = new EditorStore()
      previewStore.restore({ overlays: prepared.overlays, pages: prepared.pages, pageSources: [prepared.source] })
      setA4Preview({ pdf: previewPdf, prepared, store: previewStore, version })
      setMessage('A4-Vorschau: Erst Anwenden verändert die Seiten.')
    } catch (error) {
      if (request.current === token) {
        setProblem(error instanceof Error ? error.message : 'Die A4-Vorschau konnte nicht erstellt werden.')
        setA4Open(false)
      }
    } finally { if (request.current === token) setWorking(false) }
  }
  function cancelA4() {
    request.current++; setA4Open(false); setA4Preview(null); setWorking(false); setProblem(null)
    setMessage('A4-Umstellung abgebrochen. Seiten unverändert.')
  }
  async function insert() {
    if (working) return
    const token = ++request.current,
      before = store.state.pages,
      gap = position
    setWorking(true)
    setProblem(null)
    try {
      if (source === 'file' && !file) throw new Error('Bitte eine PDF-, PNG- oder JPG-Datei auswählen.')
      // Match the preceding displayed page; before the first page use that page.
      // Empty documents start at A4. Native attached PDFs retain their own size.
      const sheetSize = insertionPageSize(before ?? [], gap)
      const imported =
        source === 'text'
          ? await preparePages(await textPageBytes(text, sheetSize), 'Textseite')
          : await importPageFile(file!, sheetSize)
      if (request.current !== token) return
      if (store.state.pages !== before)
        throw new Error('Die Seiten haben sich inzwischen geändert. Bitte erneut einfügen.')
      store.dispatch(insertPages(store.state, gap, imported.pages, imported.source, imported.overlays, original.byteLength))
      setSelected(imported.pages[0].id)
      setCheckedIds([imported.pages[0].id]); anchor.current = imported.pages[0].id
      setInserting(false)
      setFile(null)
      setText('')
      setMessage(`${imported.pages.length} Seite(n) eingefügt.`)
    } catch (e) {
      if (request.current === token)
        setProblem(e instanceof Error ? e.message : 'Die Datei konnte nicht eingefügt werden.')
    } finally {
      if (request.current === token) setWorking(false)
    }
  }
  async function extract() {
    if (!selection.length || locked) return
    const ids = [...selection], version = store.getVersion()
    const token = ++request.current
    setWorking(true)
    setProblem(null)
    let messages: string[]
    try {
      const report = await preflightInWorker(selectDocument(snapshot(), ids))
      if (token !== request.current) return
      const review = reviewExtraction(report)
      if (review.rejected) {
        setProblem(review.rejected)
        setWorking(false)
        return
      }
      messages = review.confirm
    } catch {
      if (token !== request.current) return
      messages = reviewExtraction(null).confirm
    }
    if (messages.length) {
      setExtractCheck({ ids, version, messages })
      setWorking(false)
    } else await saveExtract(ids, version)
  }
  async function saveExtract(ids: string[], version: number) {
    setExtractCheck(null)
    const token = ++request.current
    setWorking(true)
    setProblem(null)
    try {
      if (store.getVersion() !== version) throw new Error('Der Arbeitsstand hat sich geändert. Bitte erneut auswählen.')
      const bytes = await extractInWorker(snapshot(), ids)
      if (token !== request.current) return
      downloadPdf(bytes, ids.length === 1 ? `Seite-${pages.findIndex(p => p.id === ids[0]) + 1}.pdf` : `Auswahl-${ids.length}-Seiten.pdf`)
      setMessage(ids.length === 1 ? 'Die ausgewählte Seite wurde als eigenes PDF gespeichert.' : `${ids.length} ausgewählte Seiten wurden als eigenes PDF gespeichert.`)
    } catch (e) {
      if (token === request.current)
        setProblem(e instanceof Error ? e.message : 'Die Seite konnte nicht extrahiert werden.')
    } finally {
      if (token === request.current) setWorking(false)
    }
  }
  function cropDrag(event: React.PointerEvent<HTMLButtonElement>, corner: string) {
    if (!activeCrop || !event.isPrimary || event.button !== 0) return
    event.preventDefault()
    const el = event.currentTarget,
      rect = el.closest('.page-preview-paper')!.getBoundingClientRect(),
      initial = { ...frameMargins }
    el.setPointerCapture(event.pointerId)
    const move = (ev: PointerEvent) => {
      const x = Math.max(0, Math.min(size.width, ((ev.clientX - rect.left) / rect.width) * size.width))
      const y = Math.max(0, Math.min(size.height, ((ev.clientY - rect.top) / rect.height) * size.height))
      const next = { ...initial }
      if (corner.endsWith('l')) next.left = Math.max(0, Math.min(x, size.width - next.right - 20 * MM))
      else next.right = Math.max(0, Math.min(size.width - x, size.width - next.left - 20 * MM))
      if (corner.startsWith('t')) next.top = Math.max(0, Math.min(y, size.height - next.bottom - 20 * MM))
      else next.bottom = Math.max(0, Math.min(size.height - y, size.height - next.top - 20 * MM))
      setCrop({ id: page!.id, margins: next })
    }
    const end = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      el.removeEventListener('lostpointercapture', end)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('lostpointercapture', end)
  }
  return (
    <section className={`page-manager${activeCrop ? ' cropping' : ''}`} aria-label="Seiten verwalten">
      <aside className="page-manager-panel">
        <div className="page-manager-controls">
        <h2>Seiten verwalten</h2>
        {!activeCrop && !a4Open && <div className="page-selection-tools">
          <p className="page-selection-count" role="status">{selection.length} von {pages.length} Seiten ausgewählt · Aktionen gelten für die Auswahl</p>
          <button disabled={locked || !pages.length} onClick={() => setCheckedIds(pages.map(page => page.id))}>Alle auswählen</button>
          <button disabled={locked || !selection.length} onClick={() => setCheckedIds([])}>Auswahl aufheben</button>
        </div>}
        {pages.some((p) => p.hasForms) && (
          <details className="page-form-info">
            <summary>PDF-Formularfelder bleiben im Export bearbeitbar</summary>
            <p>Vorhandene Felder können in der Dokumentbearbeitung direkt ausgefüllt werden. Die Originaldatei bleibt unverändert.</p>
          </details>
        )}
        {extractCheck ? (
          <div className="page-delete-confirm" role="group" aria-label="Extrahieren bestätigen">
            {extractCheck.messages.map(message => <p key={message}>{message}</p>)}
            <div className="page-manager-actions">
              <button onClick={() => { setExtractCheck(null); setMessage('Extrahieren abgebrochen.') }}>Abbrechen</button>
              <button onClick={() => void saveExtract(extractCheck.ids, extractCheck.version)}>Trotzdem speichern</button>
            </div>
          </div>
        ) : deletePending ? (
          <div className="page-delete-confirm">
            <p>{deletePending.ids.length} ausgewählte {deletePending.ids.length === 1 ? 'Seite' : 'Seiten'} mit allen Inhalten löschen?</p>
            <div className="page-manager-actions">
              <button onClick={() => { setDeletePending(null); setMessage('Löschen abgebrochen. Seiten unverändert.') }}>Abbrechen</button>
              <button onClick={() => run(() => {
                if (store.getVersion() !== deletePending.version) throw new Error('Der Arbeitsstand hat sich geändert. Bitte erneut auswählen.')
                store.dispatch(deletePages(store.state, deletePending.ids))
                setDeletePending(null)
              }, `${pageCount(deletePending.ids.length)} gelöscht. Rückgängig ist möglich.`)}>{pageCount(deletePending.ids.length)} löschen</button>
            </div>
          </div>
        ) : a4Open ? (
          <div className="page-crop-controls">
            <h3>Alle Seiten auf A4</h3>
            <p>Hoch-/Querformat wird beibehalten.</p>
            <p>Hochformat: 210 × 297 mm<br />Querformat: 297 × 210 mm</p>
            <p>Inhalte werden proportional eingepasst und zentriert — ohne Abschneiden oder Verzerren. Formularfelder und Overlays bleiben erhalten.</p>
            <div className="page-manager-actions">
              <button onClick={cancelA4}>Abbrechen</button>
              <button disabled={working || !a4Preview} onClick={() => run(() => {
                if (!a4Preview || store.getVersion() !== a4Preview.version) throw new Error('Der Arbeitsstand hat sich geändert. Bitte erneut öffnen.')
                store.dispatch(replacePageDocument(store.state, a4Preview.prepared.pages, a4Preview.prepared.source, a4Preview.prepared.overlays))
                setA4Open(false); setA4Preview(null)
              }, 'Alle Seiten auf A4 gesetzt. Rückgängig ist möglich.')}>{pages.length} Seiten auf A4 setzen</button>
            </div>
            <small>Erst Anwenden ändert die Seiten. Rückgängig stellt das bisherige Format wieder her.</small>
          </div>
        ) : activeCrop ? (
          <div className="page-crop-controls">
            <h3>Seite zuschneiden</h3>
            <p>Ecken ziehen oder Ränder in mm eingeben. Mindestens 20 × 20 mm bleiben sichtbar.</p>
            <div className="page-crop-fields">
              {Object.entries(labels).map(([key, label]) => (
                <label key={key}>
                  {label} · mm
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={
                      Number.isFinite(activeCrop.margins[key as keyof CropMargins])
                        ? +(activeCrop.margins[key as keyof CropMargins] / MM).toFixed(1)
                        : ''
                    }
                    onChange={(e) =>
                      setCrop({
                        id: page!.id,
                        margins: {
                          ...activeCrop.margins,
                          [key]: e.target.value === '' ? NaN : Number(e.target.value) * MM,
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <div className="page-manager-actions">
              <button
                onClick={() => {
                  setCrop(null)
                  setProblem(null)
                  setMessage('Zuschnitt abgebrochen.')
                }}
              >
                Abbrechen
              </button>
              <button
                onClick={() =>
                  run(() => {
                    const m = activeCrop.margins
                    if (!marginsFit(m)) throw new Error('Mindestens 20 × 20 mm müssen sichtbar bleiben.')
                    store.dispatch(cropPage(store.state, page!.id, m))
                    setCrop(null)
                  }, 'Zuschnitt angewendet. Rückgängig ist möglich.')
                }
              >
                Zuschnitt anwenden
              </button>
            </div>
            <small>
              Nur sichtbarer Ausschnitt — keine sichere Schwärzung. Abbrechen oder Esc verwirft den offenen
              Zuschnitt.
            </small>
          </div>
        ) : (
          <div className="page-manager-actions page-manager-action-grid">
            <button
              disabled={busy || working}
              onClick={() => {
                setPosition(pages.length)
                setFile(null)
                setProblem(null)
                setInserting(true)
              }}
            >
              ＋ Seiten einfügen
            </button>
            <button
              disabled={!selection.length || locked}
              aria-label={`${pageCount(selection.length)} gegen den Uhrzeigersinn drehen`}
              onClick={() =>
                run(() => store.dispatch(rotatePages(store.state, selection, false)), `${pageCount(selection.length)} um 90° gedreht.`)
              }
            >
              <RotateIcon clockwise={false} /> 90° drehen
            </button>
            <button
              disabled={!selection.length || locked}
              aria-label={`${pageCount(selection.length)} im Uhrzeigersinn drehen`}
              onClick={() =>
                run(() => store.dispatch(rotatePages(store.state, selection, true)), `${pageCount(selection.length)} um 90° gedreht.`)
              }
            >
              <RotateIcon clockwise /> 90° drehen
            </button>
            <button
              disabled={selection.length !== 1 || locked}
              onClick={() => {
                setSelected(selection[0])
                setProblem(null)
                setMessage('Zuschnitt bearbeiten. Erst Anwenden verändert die Seite.')
                setCrop({ id: selection[0], margins: zero() })
              }}
            >
              Zuschneiden
            </button>
            <button disabled={!selection.length || locked} onClick={() => void extract()}>
              Extrahieren
            </button>
            <button
              disabled={!selection.length || locked}
              onClick={() => {
                setProblem(null)
                setDeletePending({ ids: [...selection], version: store.getVersion() })
              }}
            >
              {selection.length === 1 ? 'Seite löschen' : selection.length ? `${pageCount(selection.length)} löschen` : 'Seiten löschen'}
            </button>
          </div>
        )}
        {!a4Open && !activeCrop && !deletePending && <div className="page-a4-global">
          <h3>Für alle Seiten</h3>
          <button disabled={locked || !pages.length} onClick={() => void openA4()}>Alle Seiten auf A4 …</button>
          <small>Optional · gilt für alle Seiten, nicht nur die Auswahl.</small>
        </div>}
        {problem && (
          <p className="page-manager-error" role="alert">
            {problem}
          </p>
        )}
        <p className="page-manager-message" role="status">
          {busy ? 'Seitenansicht wird aktualisiert …' : working ? 'Datei wird verarbeitet …' : message}
        </p>
        <small className="page-selection-help">Klick: Vorschau und Auswahl · Checkbox: dazu/weg.<br />Shift+Klick: Bereich · Strg/⌘+Klick: einzeln dazu/weg.</small>
        </div>
        <div ref={listRef} className="page-manager-list" aria-label="Seitenliste" role="region" tabIndex={0}>
          {pages.map((p, i) => (
            <div
              key={p.id}
              className={`page-manager-row${checked.has(p.id) ? ' selected' : ''}${page?.id === p.id ? ' previewed' : ''}`}
              draggable={!locked}
              onDragStart={(e) => {
                dragId.current = p.id
                e.dataTransfer.setData('text/plain', p.id)
              }}
              onDragEnd={() => {
                dragId.current = null
              }}
              onDragOver={(e) => {
                if (!locked && dragId.current) e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                const id = dragId.current
                dragId.current = null
                if (id && id !== p.id && !locked)
                  run(() => store.dispatch(movePage(store.state, id, i)), 'Seite verschoben.')
              }}
            >
              <label className="page-manager-check">
                <input type="checkbox" aria-label={`Seite ${i + 1} auswählen`} checked={checked.has(p.id)} disabled={locked}
                  onChange={event => {
                    const native = event.nativeEvent as MouseEvent
                    choosePage(p.id, { checked: event.target.checked, range: native.shiftKey, toggle: native.ctrlKey || native.metaKey })
                  }} />
              </label>
              <button
                className="page-manager-select"
                disabled={busy || working || !!deletePending}
                aria-pressed={page?.id === p.id}
                onClick={event => choosePage(p.id, { range: event.shiftKey, toggle: event.ctrlKey || event.metaKey })}
              >
                <PageThumbnail>
                  {!busy && (
                    <PageView
                      {...pageProps}
                      pageIndex={i}
                      pageId={p.id}
                      zoom={Math.min(42 / pageSize(p).width, 54 / pageSize(p).height)}
                    />
                  )}
                </PageThumbnail>
                <span>
                  {i + 1} · {p.name}
                  <small>
                    {a4Open ? 'Bisher: ' : ''}{(pageSize(p).width / MM).toFixed(0)} × {(pageSize(p).height / MM).toFixed(0)} mm ·{' '}
                    {p.rotation}°
                  </small>
                </span>
              </button>
              <span className="page-manager-moves">
              <button
                disabled={locked || i === 0}
                aria-label={`Seite ${i + 1} nach oben`}
                onClick={() =>
                  run(() => store.dispatch(movePage(store.state, p.id, i - 1)), 'Seite verschoben.')
                }
              >
                ↑
              </button>
              <button
                disabled={locked || i === pages.length - 1}
                aria-label={`Seite ${i + 1} nach unten`}
                onClick={() =>
                  run(() => store.dispatch(movePage(store.state, p.id, i + 1)), 'Seite verschoben.')
                }
              >
                ↓
              </button>
              </span>
            </div>
          ))}
        </div>
      </aside>
      <div className="page-manager-preview" ref={previewRef} data-fit-width={available.width} data-fit-height={available.height}>
        {!page ? (
          <div className="page-manager-empty">
            <h2>Keine Seiten</h2>
            <p>Füge Seiten ein oder mache das Löschen rückgängig.</p>
          </div>
        ) : busy || (a4Open && !a4Preview) ? (
          <p role="status">Seitenansicht wird aktualisiert …</p>
        ) : (
          <>
            <div
              className="page-preview-paper"
              style={{ width: shownSize.width * scale, height: shownSize.height * scale }}
            >
              <PageView {...pageProps} nativeWidgets={a4Preview ? [] : nativeWidgets} pdf={a4Preview?.pdf ?? pdf} store={a4Preview?.store ?? store} overlays={a4Preview?.prepared.overlays ?? store.state.overlays} pageIndex={index} pageId={pages[index].id} zoom={scale} />
              {activeCrop && (
                <div className="page-crop-layer">
                  <div
                    className="page-crop-frame"
                    style={{
                      left: (frameMargins.left / size.width) * 100 + '%',
                      top: (frameMargins.top / size.height) * 100 + '%',
                      width: ((size.width - frameMargins.left - frameMargins.right) / size.width) * 100 + '%',
                      height:
                        ((size.height - frameMargins.top - frameMargins.bottom) / size.height) * 100 + '%',
                    }}
                  >
                    {['tl', 'tr', 'bl', 'br'].map((corner) => (
                      <button
                        key={corner}
                        className={`page-crop-grip ${corner}`}
                        aria-label={`Zuschnitt-Ecke ${corner}`}
                        onPointerDown={(e) => cropDrag(e, corner)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
            <p>
              {a4Open ? `A4-Vorschau · ${(shownSize.width / MM).toFixed(0)} × ${(shownSize.height / MM).toFixed(0)} mm · noch nicht angewendet · ` : ''}Seite {index + 1} · {page.name}
              {!a4Open && <><br />{checked.has(page.id) ? 'Diese Seite ist Teil der Auswahl.' : 'Nur Vorschau; Aktionen betreffen die markierten Seiten.'}</>}
            </p>
          </>
        )}
      </div>
      {inserting && (
        <dialog
          ref={dialogRef}
          className="page-insert-dialog"
          onCancel={(e) => {
            e.preventDefault()
            request.current++
            setWorking(false)
            setInserting(false)
          }}
        >
          <h2>Seiten einfügen</h2>
          <label htmlFor="page-insert-source">Quelle</label>
          <select
            id="page-insert-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            disabled={working}
          >
            <option value="file">PDF oder Bild (PNG/JPG)</option>
            <option value="text">Text als neue Seite</option>
          </select>
          {source === 'file' ? (
            <label>
              Datei
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                disabled={working}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          ) : (
            <label>
              Text
              <textarea
                value={text}
                disabled={working}
                onChange={(e) => setText(e.target.value)}
                placeholder="Deine Notizen …"
              />
            </label>
          )}
          <label htmlFor="page-insert-position">Einfügeposition</label>
          <select
            id="page-insert-position"
            value={position}
            disabled={working}
            onChange={(e) => setPosition(Number(e.target.value))}
          >
            <option value={pages.length}>Am Ende anhängen</option>
            {pages.length > 0 && <option value={0}>Am Anfang einfügen</option>}
            {Array.from({ length: Math.max(0, pages.length - 1) }, (_, offset) => {
              const i = offset + 1
              return (
                <option key={i} value={i}>
                  Zwischen Seite {i} und {i + 1}
                </option>
              )
            })}
          </select>
          <p>
            Text- und Bildseiten übernehmen das Format der vorherigen Seite (am Anfang: der ersten Seite).
            Bilder bleiben auf einer weißen Seite verschiebbar, skalierbar und drehbar. PDFs behalten ihr
            Originalformat. Nicht unterstützte Textzeichen erscheinen als „?“.
          </p>
          {problem && (
            <p role="alert" className="page-manager-error">
              {problem}
            </p>
          )}
          <div className="page-manager-actions">
            <button
              onClick={() => {
                request.current++
                setWorking(false)
                setInserting(false)
                setProblem(null)
              }}
            >
              Abbrechen
            </button>
            <button disabled={working} onClick={() => void insert()}>
              {working ? 'Wird eingefügt …' : 'Einfügen'}
            </button>
          </div>
        </dialog>
      )}
    </section>
  )
}
