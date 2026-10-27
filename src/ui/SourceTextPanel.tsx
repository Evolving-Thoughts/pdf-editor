import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { EditorStore } from '../core/editorStore'
import type { SimpleSourceRun } from '../core/sourceText/simplePdf'
import { directSelection, selectedReplacement } from '../core/sourceText/directSelection'
import type { DirectSelection } from '../core/sourceText/directSelection'
import { inspectSource, previewSource } from '../core/sourceText/client'
import { sourceRevision } from '../core/sourceText/revision'
import { loadPdf } from '../core/pdf/loadPdf'
import type { SourcePageGeometry, PdfHandle } from '../core/pdf/loadPdf'
import type { SearchFragment } from '../core/search'
import { SourceTextSelection } from './SourceTextSelection'

function PdfPreview({ bytes, pageNumber, onReady, runs, selection, onSelect, onReject }: {
  bytes: ArrayBuffer; pageNumber: number; onReady: (ready: boolean) => void;
  runs: SimpleSourceRun[] | null; selection: DirectSelection | null;
  onSelect: (selection: DirectSelection) => void; onReject: (message: string) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null), container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(''), [magnification, setMagnification] = useState(1)
  const [geometry, setGeometry] = useState<{size: SourcePageGeometry; fragments: SearchFragment[]; width: number; height: number} | null>(null)
  useEffect(() => {
    let stopped = false, handle: PdfHandle | undefined
    queueMicrotask(() => { if (!stopped) { onReady(false); setError(''); setGeometry(null) } })
    void loadPdf('Korrekturvorschau', new Uint8Array(bytes)).then(async pdf => {
      if (stopped) { await pdf.destroy(); return }
      handle = pdf
      const size = await pdf.getPageGeometry(pageNumber)
      if (stopped || !canvas.current) return
      const width = Math.min(950, Math.max(200, (container.current?.clientWidth ?? 600) - 32))
      const scale = Math.min(3, width / size.width * magnification)
      await pdf.renderPage(pageNumber, canvas.current, scale)
      // Extraction only dims unproved regions. It never authorizes an edit.
      const fragments = await pdf.getSearchText(pageNumber).catch(() => [])
      if (!stopped) { setGeometry({size, fragments, width: size.width * scale, height: size.height * scale}); onReady(true) }
    }).catch(problem => { if (!stopped) { setError(problem instanceof Error ? problem.message : 'Vorschau nicht verfügbar.'); onReady(false) } })
    return () => { stopped = true; void handle?.destroy() }
  }, [bytes, pageNumber, onReady, magnification])
  return <><div className="source-zoom"><button aria-label="Vorschau verkleinern" disabled={magnification <= 1} onClick={() => { onReady(false); setMagnification(value => Math.max(1, value - .5)) }}>−</button><span>{Math.round(magnification * 100)} %</span><button aria-label="Vorschau vergrößern" disabled={magnification >= 3} onClick={() => { onReady(false); setMagnification(value => Math.min(3, value + .5)) }}>+</button></div><div ref={container} className="source-pdf-preview">{error && <p role="alert">{error}</p>}<div className="source-page-stage" style={geometry ? {width:geometry.width,height:geometry.height} : undefined}><canvas ref={canvas} aria-label="PDF-Seite mit Absatz und Folgeinhalt" />{geometry && runs && <SourceTextSelection runs={runs} size={geometry.size} fragments={geometry.fragments} selection={selection} onSelect={onSelect} onReject={onReject} />}</div></div></>
}

export function SourceTextPanel({ store, original, onClose }: { store: EditorStore; original: ArrayBuffer; onClose: () => void }) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const [pageId, setPageId] = useState(store.state.pages?.[0]?.id ?? '')
  const [analysis, setAnalysis] = useState<{ digest: string; runs: SimpleSourceRun[] } | null>(null)
  const [selection, setSelection] = useState<DirectSelection | null>(null), [pending, setPending] = useState<DirectSelection | null>(null)
  const [text, setText] = useState(''), [paragraph, setParagraph] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [candidate, setCandidate] = useState<{ bytes: ArrayBuffer; version: number } | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [ready, setReady] = useState(false), [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const request = useRef<AbortController | null>(null), epoch = useRef(0)
  const page = store.state.pages?.find(value => value.id === pageId)
  const source = page?.sourceId === 'original' ? original : store.state.pageSources?.find(value => value.id === page?.sourceId)?.bytes
  const run = analysis?.runs.find(value => value.id === selection?.runId)
  const invalid = () => { request.current?.abort(); epoch.current++; setCandidate(null); setShowOriginal(false); setReady(false); setReviewed(false); setBusy(false) }
  useEffect(() => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    const current = ++epoch.current
    queueMicrotask(() => { if (!controller.signal.aborted) { setAnalysis(null); setCandidate(null); setShowOriginal(false); setReady(false); setReviewed(false); setSelection(null); setPending(null); setText(''); setParagraph(false); setError(''); setBusy(true) } })
    const index = store.state.pages?.findIndex(value => value.id === pageId) ?? -1
    if (!page || !source || page.cropped || page.rotation !== 0 || page.unit !== 1 || page.redacted || store.state.redactions?.length || store.state.overlays.some(overlay => overlay.pageIndex === index)) {
      queueMicrotask(() => { if (!controller.signal.aborted) { setAnalysis({digest:'',runs:[]}); setError('Diese Seite ist derzeit nicht unterstützt: Drehung, Zuschnitt, Schwärzungen oder Overlays verhindern eine sichere Originaltext-Korrektur.'); setBusy(false) } }); return () => controller.abort()
    }
    void inspectSource(source, controller.signal, page.sourceIndex).then(result => {
      if (controller.signal.aborted || epoch.current !== current) return
      const runs = result.runs.filter(value => value.pageIndex === page.sourceIndex)
      setAnalysis({ ...result, runs })
      if (!runs.some(value => value.selection)) setError('Keine sicher markierbaren Originaltextstellen nachgewiesen. Bei Scans ist zunächst OCR nötig; Text-PDFs können nicht unterstützte Schriften oder Strukturen enthalten.')
    }).catch(problem => { if (!controller.signal.aborted) { setAnalysis({digest:'',runs:[]}); setError(problem instanceof Error ? problem.message : 'Textanalyse fehlgeschlagen.') } }).finally(() => { if (!controller.signal.aborted && epoch.current === current) setBusy(false) })
    return () => { controller.abort() }
  }, [version, pageId, page, source, store])
  useEffect(() => () => request.current?.abort(), [])
  // Focus after React enables the textarea, including after a mouse selection.
  useEffect(() => { if (selection) { textarea.current?.focus({preventScroll:true}); if (window.matchMedia('(max-width:760px)').matches) textarea.current?.scrollIntoView({block:'center'}) } }, [selection])
  function accept(value: DirectSelection) { invalid(); setSelection(value); setText(value.text); setParagraph(false); setPending(null); setError('') }
  function select(value: DirectSelection) {
    if (selection && text !== selection.text) { setPending(value); return }
    accept(value)
  }
  async function preview() {
    if (!run || !selection || !source || !analysis || pending) return
    invalid(); const controller = new AbortController(); request.current = controller; const current = ++epoch.current
    setError(''); setBusy(true)
    try {
      const replacement = selectedReplacement(run, selection, text, paragraph)
      const bytes = await previewSource(source, { digest: analysis.digest, runId: run.id, expectedText: run.text, scope: paragraph ? 'paragraph' : 'line', confirmReflow: paragraph }, replacement, controller.signal)
      if (!controller.signal.aborted && epoch.current === current && version === store.getVersion()) setCandidate({ bytes, version })
    } catch (problem) { if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : 'Korrektur fehlgeschlagen.') }
    finally { if (!controller.signal.aborted && epoch.current === current) setBusy(false) }
  }
  function apply() {
    if (!candidate || !ready || !reviewed || pending || candidate.version !== store.getVersion()) { invalid(); return }
    try { store.dispatch(sourceRevision(store.state, pageId, candidate.bytes)); onClose() }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Die Korrektur konnte nicht übernommen werden.'); invalid() }
  }
  const showingCandidate = !!candidate && !showOriginal
  const previewBytes = showingCandidate ? candidate.bytes : source
  const onPreviewReady = useCallback((value: boolean) => { setReady(value && showingCandidate); if (!value) setReviewed(false) }, [showingCandidate])
  return <section className="source-correction" aria-label="Originaltext korrigieren">
    <aside className="source-editor">
      <h2>Originaltext korrigieren</h2><p>Text auf der PDF markieren oder eine umrahmte Stelle anklicken. Die Auswahl erscheint hier zum Bearbeiten. Andere Inhalte bleiben an ihrer Position.</p>
      <label htmlFor="source-page">Seite</label><select id="source-page" value={pageId} onChange={event => { if (text !== selection?.text && selection && !window.confirm('Ungesicherte Korrektur verwerfen und Seite wechseln?')) return; invalid(); setPageId(event.target.value) }}>{store.state.pages?.map((value, index) => <option key={value.id} value={value.id}>Seite {index + 1} · {value.name}</option>)}</select>
      {!selection && <p className="source-instruction">Noch keine Textstelle ausgewählt. Auf der Original-PDF markieren; mit Tab und Enter ist auch eine ganze Textstelle auswählbar.</p>}
      {pending && <div className="source-pending" role="alert"><p>Die aktuelle Korrektur ist noch nicht übernommen. Verwerfen und die neue Auswahl bearbeiten?</p><button onClick={() => accept(pending)}>Auswahl wechseln</button><button onClick={() => {setPending(null);textarea.current?.focus()}}>Weiter bearbeiten</button></div>}
      {run && <p className="source-font">{run.fontName} · {run.fontSize} pt · {run.paragraph ? 'Absatzumbruch nach Bestätigung möglich' : 'Nur dieses Textfragment – kein Absatzumbruch'}</p>}
      {run?.paragraph && <><button onClick={() => { const members=analysis!.runs.filter(value=>value.selection?.groupId===run.selection?.groupId); const value=directSelection(analysis!.runs,members[0].id,0,members.at(-1)!.id); if(value)select(value) }}>Ganzen Absatz auswählen</button><label className="source-check"><input type="checkbox" checked={paragraph} onChange={event => { invalid(); setParagraph(event.target.checked) }} />Diese {run.paragraph.lineCount} Zeilen sind ein Fließtextabsatz mit automatischen, nicht absichtlichen Umbrüchen. Absatz neu umbrechen.</label></>}
      {selection?.requiresReflow && !paragraph && <p>Die Auswahl umfasst mehrere Zeilen. Zum Ändern zuerst den automatischen Absatzumbruch bestätigen.</p>}
      <label htmlFor="source-replacement">Ersatztext</label><textarea ref={textarea} id="source-replacement" maxLength={4096} value={text} disabled={!run || busy || !!pending} onChange={event => { invalid(); setText(event.target.value) }} />
      <button disabled={busy || !run || !!pending || !text.trim() || text === selection?.text || (!!selection?.requiresReflow && !paragraph)} onClick={() => void preview()}>PDF-Vorschau erzeugen</button>
      {busy && <p role="status">Text wird isoliert geprüft …</p>}{error && <p role="alert">{error}</p>}
      {candidate && <p role="status">{ready ? 'PDF-Vorschau bereit. Absatz und Übergang zum Folgeabsatz prüfen.' : 'PDF-Vorschau wird gerendert …'}</p>}
      <label className="source-check"><input type="checkbox" disabled={!candidate || !ready || busy || !!pending} checked={reviewed} onChange={event => setReviewed(event.target.checked)} />Absatz, Abstände und Übergang zum Folgeabsatz in der PDF-Vorschau geprüft</label>
      <div className="source-actions"><button onClick={() => {if (!selection || text === selection.text || window.confirm('Ungesicherte Korrektur verwerfen?')) onClose()}}>Verwerfen / Schließen</button><button className="export-button" disabled={!candidate || showOriginal || !ready || !reviewed || busy || !!pending || candidate.version !== version} onClick={apply}>Korrektur übernehmen</button></div>
      <p>Bei weniger Zeilen bleibt freier Platz unter dem Absatz. Mehr Zeilen nur bei sicher freiem Raum. Kein Verkleinern oder Stauchen. Rückgängig und Entwurfsspeicherung bleiben verfügbar.</p>
    </aside>
    <div className="source-context"><h2>{showingCandidate ? 'Neue PDF – noch nicht übernommen' : 'Original-PDF · Text direkt markieren'}</h2><p>Ganze Seite mit betroffenem Absatz und Folgeinhalt. Zum Prüfen vergrößern und bei Bedarf mit dem Original vergleichen.</p>{!showingCandidate && <div className="source-legend" aria-label="Unterstützung der Textbereiche">{analysis ? <><span className="legend-paragraph">Durchgezogen: Absatz</span><span className="legend-fragment">Gestrichelt: nur Textfragment</span><span>Ausgegraut: Unterstützung nicht nachgewiesen · für Grund anklicken</span><small>Markierbare Bereiche sind strukturell unterstützt. Ob der Ersatz passt, prüft erst die PDF-Vorschau. Markierung: höchstens 40.000 Zeichen pro Seite.</small></> : <span role="status">Analyse läuft – Unterstützung noch unbekannt.</span>}</div>}{candidate && <button onClick={() => { setShowOriginal(value => !value); setReady(false); setReviewed(false) }}>{showOriginal ? 'Neue PDF anzeigen' : 'Original anzeigen'}</button>}{previewBytes && page && <PdfPreview key={String(showingCandidate) + version + pageId} bytes={previewBytes} pageNumber={page.sourceIndex + 1} onReady={onPreviewReady} runs={showingCandidate ? null : analysis?.runs ?? null} selection={selection} onSelect={select} onReject={setError} />}</div>
  </section>
}
