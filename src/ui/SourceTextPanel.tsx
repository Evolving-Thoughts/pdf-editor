import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { EditorStore } from '../core/editorStore'
import type { SimpleSourceRun } from '../core/sourceText/simplePdf'
import { inspectSource, previewSource } from '../core/sourceText/client'
import { sourceRevision } from '../core/sourceText/revision'
import { loadPdf } from '../core/pdf/loadPdf'
import type { PdfHandle } from '../core/pdf/loadPdf'

function PdfPreview({ bytes, pageNumber, onReady }: { bytes: ArrayBuffer; pageNumber: number; onReady: (ready: boolean) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(''), [magnification, setMagnification] = useState(1)
  useEffect(() => {
    let stopped = false, handle: PdfHandle | undefined
    const abort = () => { stopped = true; void handle?.destroy() }
    queueMicrotask(() => { if (!stopped) { onReady(false); setError('') } })
    void loadPdf('Korrekturvorschau', new Uint8Array(bytes)).then(async pdf => {
      if (stopped) { await pdf.destroy(); return }
      handle = pdf
      const size = await pdf.getPageSize(pageNumber)
      if (stopped || !canvas.current) return
      const width = Math.min(950, Math.max(200, (container.current?.clientWidth ?? 600) - 32))
      await pdf.renderPage(pageNumber, canvas.current, Math.min(3, width / size.width * magnification))
      if (!stopped) onReady(true)
    }).catch(problem => { if (!stopped) { setError(problem instanceof Error ? problem.message : 'Vorschau nicht verfügbar.'); onReady(false) } })
    return abort
  }, [bytes, pageNumber, onReady, magnification])
  return <><div className="source-zoom"><button aria-label="Vorschau verkleinern" disabled={magnification <= 1} onClick={() => setMagnification(value => Math.max(1, value - .5))}>−</button><span>{Math.round(magnification * 100)} %</span><button aria-label="Vorschau vergrößern" disabled={magnification >= 3} onClick={() => setMagnification(value => Math.min(3, value + .5))}>+</button></div><div ref={container} className="source-pdf-preview">{error && <p role="alert">{error}</p>}<canvas ref={canvas} style={{ maxWidth: magnification > 1 ? 'none' : '100%' }} aria-label="Tatsächlich erzeugte PDF mit Absatz und Folgeinhalt" /></div></>
}

export function SourceTextPanel({ store, original, onClose }: { store: EditorStore; original: ArrayBuffer; onClose: () => void }) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const [pageId, setPageId] = useState(store.state.pages?.[0]?.id ?? '')
  const [analysis, setAnalysis] = useState<{ digest: string; runs: SimpleSourceRun[] } | null>(null)
  const [selected, setSelected] = useState(''), [text, setText] = useState(''), [paragraph, setParagraph] = useState(false)
  const [candidate, setCandidate] = useState<{ bytes: ArrayBuffer; version: number } | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [ready, setReady] = useState(false), [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const request = useRef<AbortController | null>(null), epoch = useRef(0)
  const page = store.state.pages?.find(value => value.id === pageId)
  const source = page?.sourceId === 'original' ? original : store.state.pageSources?.find(value => value.id === page?.sourceId)?.bytes
  const run = analysis?.runs.find(value => value.id === selected)
  const invalid = () => { request.current?.abort(); epoch.current++; setCandidate(null); setShowOriginal(false); setReady(false); setReviewed(false); setBusy(false) }
  useEffect(() => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    const current = ++epoch.current
    // Begin on the worker synchronization boundary; stale candidates are also
    // gated synchronously by store version and page identity.
    queueMicrotask(() => { if (!controller.signal.aborted) { setAnalysis(null); setCandidate(null); setShowOriginal(false); setReady(false); setReviewed(false); setSelected(''); setText(''); setParagraph(false); setError(''); setBusy(true) } })
    const index = store.state.pages?.findIndex(value => value.id === pageId) ?? -1
    if (!page || !source || page.cropped || page.rotation !== 0 || page.unit !== 1 || page.redacted || store.state.redactions?.length || store.state.overlays.some(overlay => overlay.pageIndex === index)) {
      queueMicrotask(() => { if (!controller.signal.aborted) { setError('Diese Seite ist derzeit nicht unterstützt: Drehung, Zuschnitt, Schwärzungen oder Overlays verhindern eine sichere Originaltext-Korrektur.'); setBusy(false) } }); return () => controller.abort()
    }
    void inspectSource(source, controller.signal, page.sourceIndex).then(result => {
      if (controller.signal.aborted || epoch.current !== current) return
      const runs = result.runs.filter(value => value.pageIndex === page.sourceIndex)
      setAnalysis({ ...result, runs }); setSelected(runs[0]?.id ?? ''); setText(runs[0]?.text ?? '')
      if (!runs.length) setError('Keine unterstützten Originaltextstellen gefunden. Bei Scans ist zunächst OCR nötig.')
    }).catch(problem => { if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : 'Textanalyse fehlgeschlagen.') }).finally(() => { if (!controller.signal.aborted && epoch.current === current) setBusy(false) })
    return () => { controller.abort() }
  }, [version, pageId, page, source, store])
  useEffect(() => () => request.current?.abort(), [])
  async function preview() {
    if (!run || !source || !analysis) return
    invalid(); const controller = new AbortController(); request.current = controller; const current = ++epoch.current
    setError(''); setBusy(true)
    try {
      const bytes = await previewSource(source, { digest: analysis.digest, runId: run.id, expectedText: run.text, scope: paragraph ? 'paragraph' : 'line', confirmReflow: paragraph }, text, controller.signal)
      if (!controller.signal.aborted && epoch.current === current && version === store.getVersion()) setCandidate({ bytes, version })
    } catch (problem) { if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : 'Korrektur fehlgeschlagen.') }
    finally { if (!controller.signal.aborted && epoch.current === current) setBusy(false) }
  }
  function apply() {
    if (!candidate || !ready || !reviewed || candidate.version !== store.getVersion()) { invalid(); return }
    try { store.dispatch(sourceRevision(store.state, pageId, candidate.bytes)); onClose() }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Die Korrektur konnte nicht übernommen werden.'); invalid() }
  }
  const showingCandidate = !!candidate && !showOriginal
  const previewBytes = showingCandidate ? candidate.bytes : source
  const onPreviewReady = useCallback((value: boolean) => setReady(value && showingCandidate), [showingCandidate])
  return <section className="source-correction" aria-label="Originaltext korrigieren">
    <aside className="source-editor">
      <h2>Originaltext korrigieren</h2><p>Kurze Korrekturen mit der Originalschrift. Nicht jede PDF ist unterstützt. Andere Inhalte werden nicht verschoben.</p>
      <label htmlFor="source-page">Seite</label><select id="source-page" value={pageId} onChange={event => { invalid(); setPageId(event.target.value) }}>{store.state.pages?.map((value, index) => <option key={value.id} value={value.id}>Seite {index + 1} · {value.name}</option>)}</select>
      <label htmlFor="source-run">Textstelle</label><select id="source-run" disabled={busy || !analysis?.runs.length} value={selected} onChange={event => { invalid(); const next = analysis?.runs.find(value => value.id === event.target.value); setSelected(event.target.value); setText(next?.text ?? ''); setParagraph(false) }}>{analysis?.runs.map(value => <option key={value.id} value={value.id}>{value.text.slice(0, 85)}</option>)}</select>
      {run && <p className="source-font">{run.fontName} · {run.fontSize} pt · Originalschrift</p>}
      {run?.paragraph && <label className="source-check"><input type="checkbox" checked={paragraph} onChange={event => { invalid(); setParagraph(event.target.checked); setText(event.target.checked ? run.paragraph!.text : run.text) }} />Diese {run.paragraph.lineCount} Zeilen sind ein Fließtextabsatz mit automatischen, nicht absichtlichen Umbrüchen. Absatz neu umbrechen.</label>}
      <label htmlFor="source-replacement">Ersatztext</label><textarea id="source-replacement" maxLength={4096} value={text} disabled={!run || busy} onChange={event => { invalid(); setText(event.target.value) }} />
      <button disabled={busy || !run || !text.trim() || (paragraph ? text === run.paragraph?.text : text === run.text)} onClick={() => void preview()}>PDF-Vorschau erzeugen</button>
      {busy && <p role="status">Text wird isoliert geprüft …</p>}{error && <p role="alert">{error}</p>}
      {candidate && <p role="status">{ready ? 'PDF-Vorschau bereit. Absatz und Übergang zum Folgeabsatz prüfen.' : 'PDF-Vorschau wird gerendert …'}</p>}
      <label className="source-check"><input type="checkbox" disabled={!candidate || !ready || busy} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />Absatz, Abstände und Übergang zum Folgeabsatz in der PDF-Vorschau geprüft</label>
      <div className="source-actions"><button onClick={onClose}>Verwerfen / Schließen</button><button className="export-button" disabled={!candidate || showOriginal || !ready || !reviewed || busy || candidate.version !== version} onClick={apply}>Korrektur übernehmen</button></div>
      <p>Bei weniger Zeilen bleibt freier Platz unter dem Absatz. Mehr Zeilen nur bei sicher freiem Raum. Kein Verkleinern oder Stauchen. Rückgängig und Entwurfsspeicherung bleiben verfügbar.</p>
    </aside>
    <div className="source-context"><h2>{showingCandidate ? 'Neue PDF – noch nicht übernommen' : 'Original-PDF'}</h2><p>Ganze Seite mit betroffenem Absatz und Folgeinhalt. Zum Prüfen vergrößern und bei Bedarf mit dem Original vergleichen.</p>{candidate && <button onClick={() => { setShowOriginal(value => !value); setReady(false); setReviewed(false) }}>{showOriginal ? 'Neue PDF anzeigen' : 'Original anzeigen'}</button>}{previewBytes && page && <PdfPreview key={String(showingCandidate) + version + pageId} bytes={previewBytes} pageNumber={page.sourceIndex + 1} onReady={onPreviewReady} />}</div>
  </section>
}
