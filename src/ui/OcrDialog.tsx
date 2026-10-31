import { useEffect, useRef, useState } from 'react'
import { createOcrEngine, OCR_LANGUAGES, OCR_PAGE_TIMEOUT_MS, UNCERTAIN_CONFIDENCE, withTimeout, type OcrEngine, type OcrRecognition } from '../core/ocr/recognize'
import { parsePageRange } from '../core/pageLabels'
import { setPageOcr, type DocumentPage, type OcrSourceWord } from '../core/pages'
import { toSourceWords } from '../core/ocr/ocrLayer'
import type { EditorStore } from '../core/editorStore'
import type { PdfHandle } from '../core/pdf/loadPdf'

interface PageResult extends OcrRecognition {
  page: DocumentPage
  pageIndex: number
  imageUrl: string
  keep: boolean
}
type Phase = 'setup' | 'running' | 'review'

/** Recognition starts only from the button here, per chosen page, never on opening. */
export function OcrDialog({ pdf, store, initialPage, onClose }: { pdf: PdfHandle; store: EditorStore; initialPage: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const session = useRef<{ engine?: OcrEngine; stopped: boolean } | null>(null)
  const results = useRef<PageResult[]>([])
  const [phase, setPhase] = useState<Phase>('setup')
  const [range, setRange] = useState(String(initialPage + 1))
  const [language, setLanguage] = useState(0)
  const [progress, setProgress] = useState({ label: '', share: 0 })
  const [problem, setProblem] = useState('')
  const [skipped, setSkipped] = useState<number[]>([])
  const [reviewed, setReviewed] = useState<PageResult[]>([])
  const pages = store.state.pages ?? []

  const stop = () => {
    const current = session.current
    session.current = null
    if (current) {
      current.stopped = true
      void current.engine?.terminate().catch(() => undefined)
    }
  }
  const release = () => { for (const item of results.current) URL.revokeObjectURL(item.imageUrl); results.current = [] }

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => {
      stop()
      release()
      element?.close()
    }
  }, [])

  const start = async () => {
    setProblem('')
    setSkipped([])
    let chosen: number[]
    try { chosen = parsePageRange(range, pages.length) } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Der Seitenbereich ist ungültig.')
      return
    }
    const run: { engine?: OcrEngine; stopped: boolean } = { stopped: false }
    let timedOut = false
    session.current = run
    setPhase('running')
    setProgress({ label: 'Seiten werden geprüft …', share: 0 })
    try {
      const scans: number[] = [], withText: number[] = []
      for (const index of chosen) {
        const fragments = await pdf.getSearchText(index + 1)
        if (run.stopped) return
        ;(fragments.some(fragment => fragment.text.trim()) ? withText : scans).push(index)
      }
      setSkipped(withText)
      if (!scans.length) {
        stop()
        setPhase('setup')
        setProblem('Die gewählten Seiten sind bereits durchsuchbar. Es gibt nichts zu erkennen.')
        return
      }
      setProgress({ label: 'Texterkennung wird geladen …', share: 0 })
      let finished = 0
      run.engine = await createOcrEngine(OCR_LANGUAGES[language].value, `${import.meta.env.BASE_URL}ocr/`, share => {
        if (!run.stopped) setProgress(value => ({ ...value, share: (finished + share) / scans.length }))
      })
      if (run.stopped) { void run.engine.terminate(); return }
      for (const [position, index] of scans.entries()) {
        finished = position
        setProgress({ label: `Seite ${index + 1} wird erkannt (${position + 1} von ${scans.length}) …`, share: position / scans.length })
        const picture = await pdf.renderForOcr(index + 1)
        if (run.stopped) return
        const recognition = await withTimeout(run.engine.recognize(picture.image, picture.scale), OCR_PAGE_TIMEOUT_MS, () => { timedOut = true; stop() })
        if (run.stopped) return
        results.current.push({ ...recognition, page: pages[index], pageIndex: index, imageUrl: URL.createObjectURL(picture.image), keep: true })
      }
      stop()
      setReviewed([...results.current])
      setPhase('review')
    } catch (error) {
      // A cancelled run ends in a worker error nobody needs to read.
      if (run.stopped && !timedOut) return
      stop()
      release()
      setPhase('setup')
      setProblem(error instanceof Error ? error.message : 'Die Erkennung ist fehlgeschlagen. Das Dokument bleibt unverändert.')
    }
  }

  const cancel = () => {
    stop()
    release()
    setPhase('setup')
    setReviewed([])
  }
  const apply = () => {
    const chosen = new Map<string, OcrSourceWord[]>()
    for (const item of reviewed) if (item.keep && item.words.length) chosen.set(item.page.id, toSourceWords(item.page, item.words))
    if (chosen.size) store.dispatch(setPageOcr(store.state, chosen))
    onClose()
  }

  return (
    <dialog ref={dialog} className="password-dialog ocr-dialog" aria-labelledby="ocr-title" onCancel={event => { event.preventDefault(); onClose() }}>
      <h2 id="ocr-title">Text erkennen</h2>
      {phase === 'setup' && <>
        <p>Macht Scan-Seiten durchsuchbar und kopierbar. Das sichtbare Bild bleibt unverändert, der Text liegt unsichtbar darüber. Die Erkennung läuft nur auf diesem Gerät.</p>
        <label>Seiten
          <input type="text" value={range} autoFocus onChange={event => setRange(event.target.value)} />
        </label>
        <label>Sprache
          <select value={language} onChange={event => setLanguage(Number(event.target.value))}>
            {OCR_LANGUAGES.map((option, index) => <option key={option.label} value={index}>{option.label}</option>)}
          </select>
        </label>
        <p className="export-detail">Beim ersten Start lädt die App die Erkennung und das Sprachmodell von ihrer eigenen Adresse, das sind wenige MB. Die Erkennung kann Fehler enthalten.</p>
        {problem && <p role="alert" className="export-error">{problem}</p>}
        <div className="password-actions">
          <button type="button" onClick={onClose}>Abbrechen</button>
          <button type="button" className="export-primary" onClick={() => void start()}>Erkennung starten</button>
        </div>
      </>}
      {phase === 'running' && <div className="export-progress">
        <p role="status" aria-live="polite">{progress.label}</p>
        <progress aria-label="Fortschritt der Erkennung" value={progress.share} max={1} />
        <div className="password-actions"><button type="button" onClick={cancel}>Abbrechen</button></div>
      </div>}
      {phase === 'review' && <>
        {!!skipped.length && <p className="export-detail">Bereits durchsuchbar und übersprungen: Seite {skipped.map(index => index + 1).join(', ')}.</p>}
        <div className="ocr-review">
          {reviewed.map((item, position) => {
            const uncertain = item.words.filter(word => word.confidence < UNCERTAIN_CONFIDENCE)
            return (
              <section key={item.page.id} aria-label={`Ergebnis Seite ${item.pageIndex + 1}`}>
                <label className="export-confirm">
                  <input type="checkbox" checked={item.keep} disabled={!item.words.length} onChange={event => setReviewed(list => list.map((entry, index) => index === position ? { ...entry, keep: event.target.checked } : entry))} />
                  <span><strong>Seite {item.pageIndex + 1}</strong> · {item.words.length} Wörter{uncertain.length ? ` · ${uncertain.length} unsicher` : ''}</span>
                </label>
                {!item.words.length && <p className="password-warning">Auf dieser Seite wurde kein Text erkannt.</p>}
                <div className="ocr-compare">
                  <img src={item.imageUrl} alt={`Scan von Seite ${item.pageIndex + 1}`} />
                  <textarea readOnly aria-label={`Erkannter Text von Seite ${item.pageIndex + 1}`} value={item.text} />
                </div>
                {!!uncertain.length && <p className="export-detail">Unsicher: {uncertain.slice(0, 12).map(word => word.text).join(', ')}{uncertain.length > 12 ? ' …' : ''}</p>}
              </section>
            )
          })}
        </div>
        <p className="export-detail">Bitte den Text prüfen. Der Export enthält ihn unsichtbar, das Bild der Seite ändert sich nicht.</p>
        <div className="password-actions">
          <button type="button" onClick={onClose}>Verwerfen</button>
          <button type="button" className="export-primary" disabled={!reviewed.some(item => item.keep && item.words.length)} onClick={apply}>Übernehmen</button>
        </div>
      </>}
    </dialog>
  )
}
