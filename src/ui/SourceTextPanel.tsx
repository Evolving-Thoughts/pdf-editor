import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { EditorStore } from '../core/editorStore'
import { directSelection, selectedReplacement } from '../core/sourceText/directSelection'
import type { DirectSelection } from '../core/sourceText/directSelection'
import { inspectSource, previewSource } from '../core/sourceText/client'
import type { SourceAnalysis } from '../core/sourceText/client'
import { liveBlock, liveFont, modelSpace } from '../core/sourceText/editModel'
import type { EditModel } from '../core/sourceText/editModel'
import { caretStops, hitOffset, inlineLayout } from '../core/sourceText/inlineLayout'
import { fitMessage } from './sourceFit'
import { sourceRevision } from '../core/sourceText/revision'
import { loadPdf } from '../core/pdf/loadPdf'
import type { SourcePageGeometry, PdfHandle } from '../core/pdf/loadPdf'
import type { SearchFragment } from '../core/search'
import { SourceTextSelection } from './SourceTextSelection'
import { InlineSourceEditor } from './InlineSourceEditor'
import type { TextRange } from './InlineSourceEditor'

type Stage = { size: SourcePageGeometry; fragments: SearchFragment[]; width: number; height: number; canvas: HTMLCanvasElement }
function PdfPreview({ bytes, pageNumber, onReady, label, children }: {
  bytes: ArrayBuffer; pageNumber: number; onReady: (ready: boolean) => void; label: string
  children?: (stage: Stage) => ReactNode
}) {
  const canvas = useRef<HTMLCanvasElement>(null), container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(''), [magnification, setMagnification] = useState(1)
  const [geometry, setGeometry] = useState<Stage | null>(null)
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
      if (!stopped && canvas.current) { setGeometry({ size, fragments, width: size.width * scale, height: size.height * scale, canvas: canvas.current }); onReady(true) }
    }).catch(problem => { if (!stopped) { setError(problem instanceof Error ? problem.message : 'Vorschau nicht verfügbar.'); onReady(false) } })
    return () => { stopped = true; void handle?.destroy() }
  }, [bytes, pageNumber, onReady, magnification])
  return <><div className="source-zoom"><button aria-label="Vorschau verkleinern" disabled={magnification <= 1} onClick={() => { onReady(false); setMagnification(value => Math.max(1, value - .5)) }}>−</button><span>{Math.round(magnification * 100)} %</span><button aria-label="Vorschau vergrößern" disabled={magnification >= 3} onClick={() => { onReady(false); setMagnification(value => Math.min(3, value + .5)) }}>+</button></div>
    <div ref={container} className="source-pdf-preview">{error && <p role="alert">{error}</p>}<div className="source-page-stage" style={geometry ? { width: geometry.width, height: geometry.height } : undefined}><canvas ref={canvas} aria-label={label} />{geometry && children?.(geometry)}</div></div></>
}

const limitsOf = (m: EditModel, a: SourceAnalysis) => ({ room: m.room, pinned: m.pinned, slots: m.slots, space: modelSpace(m, a.rects) })

export function SourceTextPanel({ store, original, onClose }: { store: EditorStore; original: ArrayBuffer; onClose: () => void }) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const [pageId, setPageId] = useState(store.state.pages?.[0]?.id ?? '')
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null)
  // Fragment flow (text without a proved paragraph): side-panel textarea.
  const [selection, setSelection] = useState<DirectSelection | null>(null), [pending, setPending] = useState<DirectSelection | null>(null)
  const [text, setText] = useState(''), [paragraph, setParagraph] = useState(false)
  // Inline flow: a proved paragraph edited directly on the page.
  const [inline, setInline] = useState<{ id: string; text: string; range: TextRange } | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [candidate, setCandidate] = useState<{ bytes: ArrayBuffer; version: number } | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const request = useRef<AbortController | null>(null), epoch = useRef(0)
  // The page analysis has its own request and counter: invalidating a preview must not drop it.
  const analysisRequest = useRef<AbortController | null>(null), analysisEpoch = useRef(0)
  const page = store.state.pages?.find(value => value.id === pageId)
  const source = page?.sourceId === 'original' ? original : store.state.pageSources?.find(value => value.id === page?.sourceId)?.bytes
  const run = analysis?.runs.find(value => value.id === selection?.runId)
  const fonts = useMemo(() => (analysis?.fonts ?? []).map(liveFont), [analysis])
  const blockIds = useMemo(() => new Set((analysis?.blocks ?? []).map(b => b.id)), [analysis])
  const model = inline ? analysis?.blocks.find(b => b.id === inline.id) : undefined
  const live = useMemo(() => (model ? liveBlock(model, fonts) : undefined), [model, fonts])
  const space = useMemo(() => (model && analysis ? limitsOf(model, analysis) : undefined), [model, analysis])
  const view = useMemo(() => (live && space && inline ? inlineLayout(live, inline.text, space) : null), [live, space, inline])
  const fit = inline ? fitMessage(view?.status) : undefined
  const checkable = !!view && !['same', 'invalid', 'missing'].includes(view.status.kind)
  // Simple single-stream PDFs keep the confirmed reflow of the older adapter.
  const automatic = !!run?.paragraph?.automatic, reflow = paragraph || automatic
  const dirty = inline ? !!model && inline.text !== model.text : !!selection && text !== selection.text
  const invalid = () => { request.current?.abort(); epoch.current++; setCandidate(null); setShowOriginal(false); setReady(false); setBusy(false) }
  useEffect(() => {
    request.current?.abort(); analysisRequest.current?.abort(); const controller = new AbortController(); analysisRequest.current = controller
    const current = ++analysisEpoch.current
    queueMicrotask(() => { if (!controller.signal.aborted) { setAnalysis(null); setCandidate(null); setShowOriginal(false); setReady(false); setSelection(null); setPending(null); setInline(null); setText(''); setParagraph(false); setError(''); setBusy(true) } })
    const index = store.state.pages?.findIndex(value => value.id === pageId) ?? -1
    if (!page || !source || page.cropped || page.rotation !== 0 || page.unit !== 1 || page.redacted || store.state.redactions?.length || store.state.overlays.some(overlay => overlay.pageIndex === index)) {
      queueMicrotask(() => { if (!controller.signal.aborted) { setAnalysis({ digest: '', runs: [], blocks: [], fonts: [], rects: [] }); setError('Diese Seite ist derzeit nicht unterstützt: Drehung, Zuschnitt, Schwärzungen oder Overlays verhindern eine sichere Originaltext-Korrektur.'); setBusy(false) } }); return () => controller.abort()
    }
    void inspectSource(source, controller.signal, page.sourceIndex).then(result => {
      if (controller.signal.aborted || analysisEpoch.current !== current) return
      const runs = result.runs.filter(value => value.pageIndex === page.sourceIndex)
      setAnalysis({ ...result, runs, blocks: result.blocks ?? [], fonts: result.fonts ?? [], rects: result.rects ?? [] })
      if (!runs.some(value => value.selection)) setError('Keine sicher markierbaren Originaltextstellen nachgewiesen. Bei Scans ist zunächst OCR nötig; Text-PDFs können nicht unterstützte Schriften oder Strukturen enthalten.')
    }).catch(problem => { if (!controller.signal.aborted) { setAnalysis({ digest: '', runs: [], blocks: [], fonts: [], rects: [] }); setError(problem instanceof Error ? problem.message : 'Textanalyse fehlgeschlagen.') } }).finally(() => { if (!controller.signal.aborted && analysisEpoch.current === current) setBusy(false) })
    return () => { controller.abort() }
  }, [version, pageId, page, source, store])
  useEffect(() => () => { request.current?.abort(); analysisRequest.current?.abort() }, [])
  // Focus after React enables the textarea, including after a mouse selection.
  useEffect(() => { if (selection) { textarea.current?.focus({ preventScroll: true }); if (window.matchMedia('(max-width:760px)').matches) textarea.current?.scrollIntoView({ block: 'center' }) } }, [selection])
  const discard = () => !dirty || window.confirm('Ungesicherte Korrektur verwerfen?')
  function accept(value: DirectSelection) { invalid(); setInline(null); setSelection(value); setText(value.text); setParagraph(false); setPending(null); setError('') }
  function select(value: DirectSelection) {
    if (inline) { if (!discard()) return; accept(value); return }
    if (selection && text !== selection.text) { setPending(value); return }
    accept(value)
  }
  function openBlock(id: string, from?: { x: number; y: number }, to?: { x: number; y: number }) {
    if (inline?.id === id) return
    const m = analysis?.blocks.find(b => b.id === id)
    if (!m || !discard()) return
    const v = inlineLayout(liveBlock(m, fonts), m.text, limitsOf(m, analysis!))
    let range: TextRange = { start: m.text.length, end: m.text.length }
    if (v && from) {
      const stops = caretStops(v), a = hitOffset(v, stops, from.x, from.y, m.size), b = to ? hitOffset(v, stops, to.x, to.y, m.size) : a
      range = b < a ? { start: b, end: a, backward: true } : { start: a, end: b }
    }
    invalid(); setSelection(null); setPending(null); setText(''); setError('')
    setInline({ id, text: m.text, range })
  }
  async function check() {
    if (!source || !analysis || busy) return
    invalid(); const controller = new AbortController(); request.current = controller; const current = ++epoch.current
    setError(''); setBusy(true)
    try {
      let bytes: ArrayBuffer
      if (inline && model) bytes = await previewSource(source, { digest: analysis.digest, runId: model.runId, expectedText: model.expectedText, scope: 'paragraph' }, inline.text, controller.signal)
      else {
        if (!run || !selection || pending) return
        const replacement = selectedReplacement(run, selection, text, reflow)
        bytes = await previewSource(source, { digest: analysis.digest, runId: run.id, expectedText: run.text, scope: reflow ? 'paragraph' : 'line', confirmReflow: paragraph }, replacement, controller.signal)
      }
      if (!controller.signal.aborted && epoch.current === current && version === store.getVersion()) setCandidate({ bytes, version })
    } catch (problem) { if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : 'Korrektur fehlgeschlagen.') }
    finally { if (!controller.signal.aborted && epoch.current === current) setBusy(false) }
  }
  function apply() {
    if (!candidate || !ready || pending || candidate.version !== store.getVersion()) { invalid(); return }
    try { store.dispatch(sourceRevision(store.state, pageId, candidate.bytes)); onClose() }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Die Korrektur konnte nicht übernommen werden.'); invalid() }
  }
  function keepEditing() { invalid(); setError('') }
  function closeInline() { if (!discard()) return; invalid(); setInline(null); setError('') }
  const showingCandidate = !!candidate && !showOriginal
  const previewBytes = showingCandidate ? candidate.bytes : source
  const onPreviewReady = useCallback((value: boolean) => { setReady(value && showingCandidate) }, [showingCandidate])
  const overlays = !candidate && analysis
  return <section className="source-correction" aria-label="Originaltext korrigieren">
    <aside className="source-editor">
      <h2>Originaltext korrigieren</h2><p>Einen umrahmten Absatz anklicken und direkt auf der Seite tippen. Die Anzeige zeigt sofort, ob der neue Text passt. Andere Inhalte bleiben an ihrer Position.</p>
      <label htmlFor="source-page">Seite</label><select id="source-page" value={pageId} onChange={event => { if (event.target.value === pageId || !discard()) return; invalid(); setPageId(event.target.value) }}>{store.state.pages?.map((value, index) => <option key={value.id} value={value.id}>Seite {index + 1} · {value.name}</option>)}</select>
      {!selection && !inline && <p className="source-instruction">Noch nichts ausgewählt. Absatz anklicken (Klickstelle = Cursor) oder mit Tab und Enter wählen. Gestrichelte Textfragmente erscheinen zum Bearbeiten hier im Seitenbereich.</p>}
      {inline && model && <>
        <p className="source-font">Absatz mit {model.lines.length} {model.lines.length === 1 ? 'Zeile' : 'Zeilen'} · {model.size.toFixed(1).replace('.0', '')} pt{model.justified ? ' · Blocksatz' : ''}{model.room ? ` · Platz für ${model.room} weitere ${model.room === 1 ? 'Zeile' : 'Zeilen'}` : ' · kein Platz für weitere Zeilen'}</p>
        <p id="source-fit" className={`source-fit source-fit-${fit!.tone}`} role="status">{fit!.text}</p>
        <p className="source-hint">Pfeiltasten, Pos1/Ende und Maus wie gewohnt. Strg+Enter prüft, Esc beendet.</p>
      </>}
      {pending && <div className="source-pending" role="alert"><p>Die aktuelle Korrektur ist noch nicht übernommen. Verwerfen und die neue Auswahl bearbeiten?</p><button onClick={() => accept(pending)}>Auswahl wechseln</button><button onClick={() => { setPending(null); textarea.current?.focus() }}>Weiter bearbeiten</button></div>}
      {!inline && run && <p className="source-font">{run.fontName} · {run.fontSize} pt · {automatic ? (run.paragraph!.lineCount > 1 ? `Absatz mit ${run.paragraph!.lineCount} Zeilen – wird bei Bedarf automatisch neu umbrochen` : 'Zeile wird als Ganzes bearbeitet – Folgetext rückt nach') : run.paragraph ? 'Absatzumbruch nach Bestätigung möglich' : 'Nur dieses Textfragment – kein Absatzumbruch'}</p>}
      {!inline && run?.paragraph && <>{run.paragraph.lineCount > 1 && <button onClick={() => { const members = analysis!.runs.filter(value => value.selection?.groupId === run.selection?.groupId); const value = directSelection(analysis!.runs, members[0].id, 0, members.at(-1)!.id); if (value) select(value) }}>Ganzen Absatz auswählen</button>}{!automatic && <label className="source-check"><input type="checkbox" checked={paragraph} onChange={event => { invalid(); setParagraph(event.target.checked) }} />Diese {run.paragraph.lineCount} Zeilen sind ein Fließtextabsatz mit automatischen, nicht absichtlichen Umbrüchen. Absatz neu umbrechen.</label>}</>}
      {!inline && selection?.requiresReflow && !reflow && <p>Die Auswahl umfasst mehrere Zeilen. Zum Ändern zuerst den automatischen Absatzumbruch bestätigen.</p>}
      {!inline && selection && <><label htmlFor="source-replacement">Ersatztext</label><textarea ref={textarea} id="source-replacement" maxLength={4096} value={text} disabled={!run || busy || !!pending || !!candidate} onChange={event => { invalid(); setText(event.target.value) }} /></>}
      {busy && <p role="status">Text wird isoliert in der PDF geprüft …</p>}{error && <p role="alert">{error}</p>}
      {candidate && <p role="status">{ready ? 'Ergebnis in der echten PDF bereit. Absatz und Übergang zum Folgeinhalt ansehen.' : 'PDF-Ergebnis wird gerendert …'}</p>}
      <div className="source-actions">
        {!candidate && (inline || selection) && <button className="export-button" disabled={busy || !!pending || (inline ? !checkable : !run || !text.trim() || text === selection?.text || (!!selection?.requiresReflow && !reflow))} onClick={() => void check()}>In PDF prüfen</button>}
        {candidate && <><button onClick={keepEditing}>Weiter bearbeiten</button><button className="export-button" disabled={showOriginal || !ready || busy || !!pending || candidate.version !== version} onClick={apply}>Übernehmen</button></>}
        {inline && !candidate && <button onClick={closeInline}>Absatz verlassen</button>}
        <button onClick={() => { if (discard()) onClose() }}>Schließen</button>
      </div>
      <p>Weniger Zeilen lassen freien Platz unter dem Absatz. Mehr Zeilen nur bei sicher freiem Raum. Kein Verkleinern oder Stauchen. Folgende Absätze, Bilder und Grafiken bleiben unverändert. Rückgängig und Entwurfsspeicherung bleiben verfügbar.</p>
    </aside>
    <div className="source-context"><h2>{showingCandidate ? 'Ergebnis in der PDF – noch nicht übernommen' : candidate ? 'Original-PDF zum Vergleich' : 'Original-PDF · direkt im Absatz bearbeiten'}</h2>
      {overlays && <div className="source-legend" aria-label="Unterstützung der Textbereiche"><span className="legend-paragraph">Durchgezogen: Absatz direkt bearbeitbar</span><span className="legend-fragment">Gestrichelt: nur Textfragment</span><span>Ausgegraut: Unterstützung nicht nachgewiesen · für Grund anklicken</span><small>Die Passt-Anzeige rechnet mit den Originalschriften. Verbindlich ist die Prüfung in der echten PDF.</small></div>}
      {!analysis && <p role="status">Analyse läuft – Unterstützung noch unbekannt.</p>}
      {candidate && <button onClick={() => { setShowOriginal(value => !value); setReady(false) }}>{showOriginal ? 'Ergebnis anzeigen' : 'Original anzeigen'}</button>}
      {previewBytes && page && <PdfPreview key={String(showingCandidate) + version + pageId} bytes={previewBytes} pageNumber={page.sourceIndex + 1} onReady={onPreviewReady} label={showingCandidate ? 'Geprüfte PDF-Seite mit geändertem Absatz' : 'PDF-Seite mit bearbeitbaren Absätzen'}>
        {stage => overlays && <>
          <SourceTextSelection runs={analysis.runs} size={stage.size} fragments={stage.fragments} selection={selection} onSelect={select} onReject={setError} blocks={blockIds} editing={inline?.id} onBlock={openBlock} />
          {inline && model && <InlineSourceEditor model={model} view={view} text={inline.text} range={inline.range} size={stage.size} canvas={stage.canvas} disabled={busy}
            onChange={(value, range) => { setError(''); setInline({ ...inline, text: value, range }) }}
            onRange={range => setInline({ ...inline, range })}
            onSubmit={() => { if (checkable) void check() }} onCancel={closeInline} />}
        </>}
      </PdfPreview>}
    </div>
  </section>
}
