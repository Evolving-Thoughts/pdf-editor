import { downloadPdf } from '../core/pdf/downloadPdf'
import { useEffect, useRef, useState } from 'react'
import { EditorStore } from '../core/editorStore'
import {
  a4Size,
  commonPreviewScale,
  replacePageDocument,
  cropPage,
  deletePage,
  insertPages,
  insertionPageSize,
  movePage,
  pageSize,
  rotatePage,
  type CropMargins,
} from '../core/pages'
import { exportPageDocument, importPageFile, preparePages, textPageBytes } from '../core/pdf/pageOperations'
import { loadPdf, type PdfHandle } from '../core/pdf/loadPdf'
import { normalizeA4 } from '../core/pdf/normalizeA4'
import { PageView } from './PageView'

const MM = 72 / 25.4
const zero = (): CropMargins => ({ left: 0, top: 0, right: 0, bottom: 0 })
const labels = { left: 'Links', top: 'Oben', right: 'Rechts', bottom: 'Unten' }
const noSelect = () => {}
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
  pdf: PdfHandle
  store: EditorStore
  original: ArrayBuffer
  busy: boolean
  onCropActive: (active: boolean) => void
}
export function PagesManager({ pdf, store, original, busy, onCropActive }: Props) {
  const pages = store.state.pages ?? []
  const [selected, setSelected] = useState(pages[0]?.id ?? '')
  const page = pages.find((p) => p.id === selected) ?? pages[0]
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
  const dialogRef = useRef<HTMLDialogElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState({ width: 600, height: 700 })
  const request = useRef(0)
  const dragId = useRef<string | null>(null)
  const size = page ? pageSize(page) : { width: 595, height: 842 }
  // A common scale makes physical dimensions comparable between selections.
  const shownSize = a4Open ? a4Size(size) : size
  const scale = commonPreviewScale(pages.map(p => a4Open ? a4Size(pageSize(p)) : pageSize(p)), available)
  const marginsFit = (m: CropMargins) =>
    Object.values(m).every((v) => Number.isFinite(v) && v >= 0) &&
    size.width - m.left - m.right >= 20 * MM - 1e-6 &&
    size.height - m.top - m.bottom >= 20 * MM - 1e-6
  const frameMargins = activeCrop && marginsFit(activeCrop.margins) ? activeCrop.margins : zero()
  const locked = busy || working || !!activeCrop || a4Open
  useEffect(() => {
    onCropActive(!!activeCrop || a4Open)
    return () => onCropActive(false)
  }, [activeCrop, a4Open, onCropActive])
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
      setAvailable({ width: r.width, height: Math.max(420, r.height) })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!activeCrop && !a4Open) return
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCrop(null)
        request.current++
        setA4Open(false); setA4Preview(null); setWorking(false)
        setMessage(a4Open ? 'A4-Umstellung abgebrochen. Seiten unverändert.' : 'Zuschnitt abgebrochen. Seite unverändert.')
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [activeCrop, a4Open])
  function run(work: () => void, message: string) {
    try {
      work()
      setProblem(null)
      setMessage(message)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Die Seitenoperation ist fehlgeschlagen.')
    }
  }
  const pageProps = {
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
      const prepared = await normalizeA4(new Uint8Array(original), store.state.pageSources ?? [], pages, store.state.overlays)
      if (request.current !== token) return
      const previewPdf = await loadPdf('A4-Vorschau', new Uint8Array(prepared.source.bytes))
      if (request.current !== token) { await previewPdf.destroy(); return }
      if (store.getVersion() !== version) { await previewPdf.destroy(); throw new Error('Der Arbeitsstand hat sich geändert. Bitte erneut öffnen.') }
      const previewStore = new EditorStore()
      previewStore.restore(prepared.overlays, prepared.pages, [prepared.source])
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
      store.dispatch(insertPages(store.state, gap, imported.pages, imported.source, imported.overlays))
      setSelected(imported.pages[0].id)
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
    if (!page || locked) return
    const token = ++request.current
    setWorking(true)
    setProblem(null)
    try {
      const bytes = await exportPageDocument(
        new Uint8Array(original),
        store.state.pageSources ?? [],
        pages,
        store.state.overlays,
        page.id,
      )
      if (token !== request.current) return
      downloadPdf(bytes, `Seite-${index + 1}.pdf`)
      setMessage('Die ausgewählte Seite wurde als eigenes PDF gespeichert.')
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
    <section className="page-manager" aria-label="Seiten verwalten">
      <aside className="page-manager-panel">
        <h2>Seiten verwalten</h2>
        {pages.some((p) => p.hasForms) && (
          <p className="page-manager-message">
            Vorhandene PDF-Formularfelder bleiben im Export bearbeitbar. Das direkte Ausfüllen im Editor folgt
            mit dem AcroForm-Modus. Die Originaldatei bleibt unverändert.
          </p>
        )}
        {a4Open ? (
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
              Nur sichtbarer Ausschnitt — keine sichere Schwärzung. Ein Seitenwechsel verwirft den offenen
              Zuschnitt.
            </small>
          </div>
        ) : (
          <div className="page-manager-actions">
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
              disabled={!page || locked}
              aria-label="Seite gegen den Uhrzeigersinn drehen"
              onClick={() =>
                run(() => store.dispatch(rotatePage(store.state, page!.id, false)), 'Seite um 90° gedreht.')
              }
            >
              <RotateIcon clockwise={false} /> 90°
            </button>
            <button
              disabled={!page || locked}
              aria-label="Seite im Uhrzeigersinn drehen"
              onClick={() =>
                run(() => store.dispatch(rotatePage(store.state, page!.id, true)), 'Seite um 90° gedreht.')
              }
            >
              <RotateIcon clockwise /> 90°
            </button>
            <button
              disabled={!page || locked}
              onClick={() => {
                setProblem(null)
                setMessage('Zuschnitt bearbeiten. Erst Anwenden verändert die Seite.')
                setCrop({ id: page!.id, margins: zero() })
              }}
            >
              Zuschneiden
            </button>
            <button disabled={!page || locked} onClick={() => void extract()}>
              Extrahieren
            </button>
            <button
              disabled={!page || locked}
              onClick={() => {
                if (
                  window.confirm(
                    `Seite ${index + 1} mit ihren Elementen löschen? Rückgängig stellt sie wieder her.`,
                  )
                )
                  run(
                    () => store.dispatch(deletePage(store.state, page!.id)),
                    'Seite gelöscht. Rückgängig ist möglich.',
                  )
              }}
            >
              Seite löschen
            </button>
          </div>
        )}
        {!a4Open && !activeCrop && <div className="page-a4-global">
          <h3>Für alle Seiten</h3>
          <button disabled={locked || !pages.length} onClick={() => void openA4()}>Alle Seiten auf A4 …</button>
          <small>Optional — das Format wird nicht automatisch geändert.</small>
        </div>}
        {problem && (
          <p className="page-manager-error" role="alert">
            {problem}
          </p>
        )}
        <p className="page-manager-message" role="status">
          {busy ? 'Seitenansicht wird aktualisiert …' : working ? 'Datei wird verarbeitet …' : message}
        </p>
        <div className="page-manager-list" aria-label="Seitenliste">
          {pages.map((p, i) => (
            <div
              key={p.id}
              className={`page-manager-row${page?.id === p.id ? ' selected' : ''}`}
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
              <button
                className="page-manager-select"
                disabled={busy || working}
                aria-pressed={page?.id === p.id}
                onClick={() => {
                  setSelected(p.id)
                  setCrop(null)
                  setProblem(null)
                  setMessage(activeCrop ? 'Offenen Zuschnitt verworfen.' : a4Open ? 'A4-Vorschau: Erst Anwenden verändert die Seiten.' : 'Seite ausgewählt.')
                }}
              >
                <span className="page-miniature" aria-hidden="true">
                  {!busy && (
                    <PageView
                      {...pageProps}
                      pageIndex={i}
                      zoom={Math.min(42 / pageSize(p).width, 54 / pageSize(p).height)}
                    />
                  )}
                </span>
                <span>
                  {i + 1} · {p.name}
                  <small>
                    {a4Open ? 'Bisher: ' : ''}{(pageSize(p).width / MM).toFixed(0)} × {(pageSize(p).height / MM).toFixed(0)} mm ·{' '}
                    {p.rotation}°
                  </small>
                </span>
              </button>
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
            </div>
          ))}
        </div>
      </aside>
      <div className="page-manager-preview" ref={previewRef}>
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
              <PageView {...pageProps} pdf={a4Preview?.pdf ?? pdf} store={a4Preview?.store ?? store} overlays={a4Preview?.prepared.overlays ?? store.state.overlays} pageIndex={index} zoom={scale} />
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
