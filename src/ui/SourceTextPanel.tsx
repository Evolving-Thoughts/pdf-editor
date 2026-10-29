import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { EditorStore } from '../core/editorStore'
import { directSelection, selectedReplacement } from '../core/sourceText/directSelection'
import type { DirectSelection } from '../core/sourceText/directSelection'
import { cachedInspection, prefetchInspection, previewSource, previewSources, warmSourceWorkers } from '../core/sourceText/client'
import type { SourceAnalysis } from '../core/sourceText/client'
import { draftSpace, liveBlock, liveFont, modelSpace } from '../core/sourceText/editModel'
import type { EditModel, LiveFont } from '../core/sourceText/editModel'
import { caretStops, hitOffset, inlineLayout, paintedGlyphs } from '../core/sourceText/inlineLayout'
import type { InlineView } from '../core/sourceText/inlineLayout'
import type { Box } from '../core/sourceText/space'
import { emptyHistory, recordEdit, recordStep, redoDraft, undoDraft, withDraft } from '../core/sourceText/draftHistory'
import type { DraftHistory, DraftState } from '../core/sourceText/draftHistory'
import { fitMessage } from './sourceFit'
import { sourceRevision } from '../core/sourceText/revision'
import type { SourcePageGeometry } from '../core/pdf/loadPdf'
import type { SearchFragment } from '../core/search'
import { SourceTextSelection } from './SourceTextSelection'
import { InlineSourceEditor } from './InlineSourceEditor'
import type { TextRange } from './InlineSourceEditor'
import { pdfDocuments } from './sourcePdfCache'
import type { PdfDocuments } from './sourcePdfCache'

/** Undo/redo of unchecked drafts for the toolbar (see App). */
export interface SourceHistory { canUndo: boolean; canRedo: boolean; dirty: boolean; undo: () => void; redo: () => void }

type Stage = { bytes: ArrayBuffer; pageNumber: number; size: SourcePageGeometry; fragments: SearchFragment[]; width: number; height: number; canvas: HTMLCanvasElement }
/** Rendered pages of the panel (most recent last), so returning to a page or
 * opening a prerendered neighbour shows it at once. */
function stageCache(limit = 5) {
  const stages = new Map<string, { bytes: ArrayBuffer; promise: Promise<Stage> }>()
  const ids = new WeakMap<ArrayBuffer, number>()
  let next = 0
  const key = (bytes: ArrayBuffer, page: number, scale: number) => {
    let id = ids.get(bytes)
    if (id === undefined) ids.set(bytes, (id = next++))
    return `${id}:${page}:${scale.toFixed(4)}`
  }
  return {
    get(docs: PdfDocuments, bytes: ArrayBuffer, pageNumber: number, width: number, magnification: number): Promise<Stage> {
      return docs.get(bytes).then(async pdf => {
        const size = await pdf.getPageGeometry(pageNumber)
        const scale = Math.min(3, width / size.width * magnification), k = key(bytes, pageNumber, scale)
        const hit = stages.get(k)
        if (hit) { stages.delete(k); stages.set(k, hit); return hit.promise }
        const canvas = document.createElement('canvas')
        // Extraction only dims unproved regions. It never authorizes an edit.
        const promise = Promise.all([pdf.renderPage(pageNumber, canvas, scale), pdf.getSearchText(pageNumber).catch(() => [])])
          .then(([, fragments]) => ({ bytes, pageNumber, size, fragments, width: size.width * scale, height: size.height * scale, canvas }))
        stages.set(k, { bytes, promise })
        promise.catch(() => stages.delete(k))
        while (stages.size > limit) stages.delete(stages.keys().next().value!)
        return promise
      })
    },
    drop(bytes: ArrayBuffer) { for (const [k, v] of stages) if (v.bytes === bytes) stages.delete(k) },
  }
}
type StageCache = ReturnType<typeof stageCache>
/** Renders off-screen and swaps the finished canvas in, so the previous page
 * stays visible while the next one renders (no blank flash). */
function PdfPreview({ docs, stages, bytes, pageNumber, prefetch, onReady, label, children }: {
  docs: PdfDocuments; stages: StageCache; bytes: ArrayBuffer; pageNumber: number; prefetch?: { bytes: ArrayBuffer; pageNumber: number }[]
  onReady: (ready: boolean) => void; label: string; children?: (stage: Stage) => ReactNode
}) {
  const host = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(''), [magnification, setMagnification] = useState(1)
  const [stage, setStage] = useState<Stage | null>(null)
  const current = !!stage && stage.bytes === bytes && stage.pageNumber === pageNumber
  useEffect(() => {
    let stopped = false
    queueMicrotask(() => { if (!stopped) setError('') })
    const width = Math.min(950, Math.max(200, (container.current?.clientWidth ?? 600) - 32))
    void stages.get(docs, bytes, pageNumber, width, magnification).then(value => {
      if (stopped) return
      setStage(value)
      // Prerender the likely next pages once this one is shown.
      for (const p of prefetch ?? []) void stages.get(docs, p.bytes, p.pageNumber, width, magnification).catch(() => undefined)
    }).catch(problem => { if (!stopped) { setError(problem instanceof Error ? problem.message : 'Vorschau nicht verfügbar.'); onReady(false) } })
    return () => { stopped = true }
  }, [docs, stages, bytes, pageNumber, onReady, magnification, prefetch])
  useLayoutEffect(() => {
    if (!stage || !host.current) return
    stage.canvas.setAttribute('aria-label', label)
    if (host.current.firstChild !== stage.canvas) host.current.replaceChildren(stage.canvas)
  }, [stage, label])
  useEffect(() => { onReady(current) }, [current, onReady])
  return <><div className="source-zoom"><button aria-label="Vorschau verkleinern" disabled={magnification <= 1} onClick={() => setMagnification(value => Math.max(1, value - .5))}>−</button><span>{Math.round(magnification * 100)} %</span><button aria-label="Vorschau vergrößern" disabled={magnification >= 3} onClick={() => setMagnification(value => Math.min(3, value + .5))}>+</button></div>
    <div ref={container} className="source-pdf-preview">{error && <p role="alert">{error}</p>}<div className={`source-page-stage${current ? '' : ' source-page-loading'}`} style={stage ? { width: stage.width, height: stage.height } : undefined}><div ref={host} className="source-canvas-host" />{current && children?.(stage)}</div></div></>
}

/** Page thumbnails, rendered lazily from the cached source documents. */
function PageStrip({ docs, pages, sourceOf, current, disabled, live, onPick }: {
  docs: PdfDocuments; pages: { id: string; name: string; sourceIndex: number }[]; sourceOf: (id: string) => ArrayBuffer | undefined
  current: string; disabled: boolean; live: boolean; onPick: (id: string) => void
}) {
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' }) }, [current])
  return <nav className="source-pages" aria-label="Seiten"><h3>Seiten</h3><ol ref={list}>
    {pages.map((p, i) => <li key={p.id}><button type="button" aria-label={`Seite ${i + 1} anzeigen`} aria-current={p.id === current ? 'page' : undefined} disabled={disabled} onClick={() => onPick(p.id)}>
      <Thumb docs={docs} bytes={live ? sourceOf(p.id) : undefined} pageNumber={p.sourceIndex + 1} root={list} /><span>{i + 1} · {p.name}</span>
    </button></li>)}
  </ol></nav>
}
function Thumb({ docs, bytes, pageNumber, root }: { docs: PdfDocuments; bytes?: ArrayBuffer; pageNumber: number; root: { current: HTMLElement | null } }) {
  const ref = useRef<HTMLSpanElement>(null), [visible, setVisible] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setVisible(true) }, { root: root.current, rootMargin: '200px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [root])
  useEffect(() => {
    const element = ref.current
    if (!visible || !bytes || !element) return
    let stopped = false
    void (async () => {
      const pdf = await docs.get(bytes), size = await pdf.getPageSize(pageNumber)
      if (stopped) return
      const canvas = document.createElement('canvas')
      await pdf.renderPage(pageNumber, canvas, Math.min(84 / size.width, 108 / size.height))
      if (!stopped) element.replaceChildren(canvas)
    })().catch(() => undefined)
    return () => { stopped = true }
  }, [visible, docs, bytes, pageNumber])
  return <span ref={ref} className="source-thumb" aria-hidden="true" />
}

const limitsOf = (m: EditModel, a: SourceAnalysis) => ({ room: m.room, pinned: m.pinned, slots: m.slots, space: modelSpace(m, a.rects) })
/** Ink of a laid-out paragraph per line (glyph boxes, as the worker sees runs). */
function lineBoxes(view: InlineView): Box[] {
  const out = new Map<number, Box>()
  for (const p of paintedGlyphs(view)) {
    const g = p.glyph, f = g.font as LiveFont, b = f.boxes?.get(g.code) ?? f.bbox
    const box = { left: p.x + (b[0] * g.size) / 1000, right: p.x + (b[2] * g.size) / 1000, bottom: p.baseline + (b[1] * g.size) / 1000, top: p.baseline + (b[3] * g.size) / 1000 }
    const o = out.get(p.line)
    out.set(p.line, o ? { left: Math.min(o.left, box.left), right: Math.max(o.right, box.right), bottom: Math.min(o.bottom, box.bottom), top: Math.max(o.top, box.top) } : box)
  }
  return [...out.values()]
}
const clock = () => Date.now()
const NO_PAGES: NonNullable<EditorStore['state']['pages']> = []
const NONE: DraftState = { drafts: {}, active: null }
const EMPTY_ANALYSIS: SourceAnalysis = { digest: '', runs: [], blocks: [], fonts: [], rects: [] }

export function SourceTextPanel({ store, original, onClose, onHistory }: { store: EditorStore; original: ArrayBuffer; onClose: () => void; onHistory?: (history: SourceHistory | null) => void }) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const [docs] = useState(() => pdfDocuments()), [stages] = useState(() => stageCache())
  // Thumbnails wait for the first page view, which has priority.
  const [shown, setShown] = useState(false)
  useEffect(() => () => docs.destroy(), [docs])
  useEffect(() => { warmSourceWorkers(2) }, [])
  const [pageId, setPageId] = useState(store.state.pages?.[0]?.id ?? '')
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null)
  // Fragment flow (text without a proved paragraph): side-panel textarea.
  const [selection, setSelection] = useState<DirectSelection | null>(null), [pending, setPending] = useState<DirectSelection | null>(null)
  const [text, setText] = useState(''), [paragraph, setParagraph] = useState(false)
  // Inline flow: proved paragraphs edited directly on the page, several at once.
  const [draft, setDraft] = useState<DraftState>(NONE)
  const history = useRef<DraftHistory>(emptyHistory()), draftRef = useRef(draft)
  const [counts, setCounts] = useState({ past: 0, future: 0 })
  useLayoutEffect(() => { draftRef.current = draft })
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [candidate, setCandidate] = useState<{ bytes: ArrayBuffer; version: number } | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const request = useRef<AbortController | null>(null), epoch = useRef(0)
  // The page analysis has its own request and counter: invalidating a preview must not drop it.
  const analysisRequest = useRef<AbortController | null>(null), analysisEpoch = useRef(0)
  const pages = store.state.pages ?? NO_PAGES
  const page = pages.find(value => value.id === pageId)
  const sourceOf = useCallback((id: string) => {
    const p = store.state.pages?.find(value => value.id === id)
    return p?.sourceId === 'original' ? original : store.state.pageSources?.find(value => value.id === p?.sourceId)?.bytes
  }, [store, original])
  const source = page ? sourceOf(page.id) : undefined
  const run = analysis?.runs.find(value => value.id === selection?.runId)
  const fonts = useMemo(() => (analysis?.fonts ?? []).map(liveFont), [analysis])
  const models = useMemo(() => new Map((analysis?.blocks ?? []).map(b => [b.id, b])), [analysis])
  const blockIds = useMemo(() => new Set(models.keys()), [models])
  const draftIds = useMemo(() => Object.keys(draft.drafts).filter(id => models.has(id)), [draft.drafts, models])
  const lives = useMemo(() => new Map([...models.values()].map(m => [m.id, liveBlock(m, fonts)])), [models, fonts])
  const live = useCallback((m: EditModel) => lives.get(m.id) ?? liveBlock(m, fonts), [lives, fonts])
  const textOf = useCallback((id: string) => draft.drafts[id] ?? models.get(id)?.text ?? '', [draft.drafts, models])
  // Each changed paragraph against the page as it would be with the other drafts.
  const views = useMemo(() => {
    const out = new Map<string, InlineView | null>()
    if (!analysis) return out
    const shown = new Set(draftIds)
    if (draft.active && models.has(draft.active.id)) shown.add(draft.active.id)
    const base = new Map(draftIds.map(id => { const m = models.get(id)!; return [id, inlineLayout(live(m), textOf(id), limitsOf(m, analysis))] }))
    for (const id of shown) {
      const m = models.get(id)!, others = draftIds.filter(o => o !== id)
      if (!others.length) { out.set(id, base.get(id) ?? inlineLayout(live(m), textOf(id), limitsOf(m, analysis))); continue }
      const removed = new Set(others.flatMap(o => models.get(o)!.space.own))
      const extra = others.flatMap(o => { const v = base.get(o); return v ? lineBoxes(v) : [] })
      out.set(id, inlineLayout(live(m), textOf(id), { room: m.room, pinned: m.pinned, slots: m.slots, space: draftSpace(m, analysis.rects, removed, extra) }))
    }
    return out
  }, [analysis, models, draftIds, draft.active, live, textOf])
  const active = draft.active && models.has(draft.active.id) ? draft.active : null
  const model = active ? models.get(active.id) : undefined
  const view = active ? views.get(active.id) ?? null : null
  const fit = model ? fitMessage(view?.status) : undefined
  const checkable = draftIds.length > 0 && draftIds.every(id => { const v = views.get(id); return !!v && !['same', 'invalid', 'missing'].includes(v.status.kind) })
  // Simple single-stream PDFs keep the confirmed reflow of the older adapter.
  const automatic = !!run?.paragraph?.automatic, reflow = paragraph || automatic
  const fragmentDirty = !!selection && text !== selection.text
  const dirty = draftIds.length > 0 || fragmentDirty
  const invalid = () => { request.current?.abort(); epoch.current++; setCandidate(null); setShowOriginal(false); setReady(false); setBusy(false) }
  const bump = () => setCounts({ past: history.current.past.length, future: history.current.future.length })
  useEffect(() => {
    request.current?.abort(); analysisRequest.current?.abort(); const controller = new AbortController(); analysisRequest.current = controller
    const current = ++analysisEpoch.current
    queueMicrotask(() => { if (!controller.signal.aborted) { setAnalysis(null); setCandidate(null); setShowOriginal(false); setReady(false); setSelection(null); setPending(null); setDraft(NONE); history.current = emptyHistory(); bump(); setText(''); setParagraph(false); setError(''); setBusy(true) } })
    const supported = (p: typeof page) => {
      const index = store.state.pages?.findIndex(value => value.id === p?.id) ?? -1
      return !!p && !p.cropped && p.rotation === 0 && p.unit === 1 && !p.redacted && !store.state.redactions?.length && !store.state.overlays.some(overlay => overlay.pageIndex === index)
    }
    if (!source || !supported(page)) {
      queueMicrotask(() => { if (!controller.signal.aborted) { setAnalysis(EMPTY_ANALYSIS); setError('Diese Seite ist derzeit nicht unterstützt: Drehung, Zuschnitt, Schwärzungen oder Overlays verhindern eine sichere Originaltext-Korrektur.'); setBusy(false) } }); return () => controller.abort()
    }
    void cachedInspection(source, page!.sourceIndex, controller.signal).then(result => {
      if (controller.signal.aborted || analysisEpoch.current !== current) return
      const runs = result.runs.filter(value => value.pageIndex === page!.sourceIndex)
      setAnalysis({ ...result, runs, blocks: result.blocks ?? [], fonts: result.fonts ?? [], rects: result.rects ?? [] })
      if (!runs.some(value => value.selection)) setError('Keine sicher markierbaren Originaltextstellen nachgewiesen. Bei Scans ist zunächst OCR nötig; Text-PDFs können nicht unterstützte Schriften oder Strukturen enthalten.')
      // The neighbours are the likely next pages: analyze them in the background.
      const all = store.state.pages ?? [], at = all.findIndex(value => value.id === page!.id)
      for (const next of [all[at + 1], all[at - 1]]) { const bytes = next && supported(next) ? sourceOf(next.id) : undefined; if (bytes) prefetchInspection(bytes, next.sourceIndex) }
    }).catch(problem => { if (!controller.signal.aborted) { setAnalysis(EMPTY_ANALYSIS); setError(problem instanceof Error ? problem.message : 'Textanalyse fehlgeschlagen.') } }).finally(() => { if (!controller.signal.aborted && analysisEpoch.current === current) setBusy(false) })
    return () => { controller.abort() }
  }, [version, pageId, page, source, store, sourceOf])
  useEffect(() => () => { request.current?.abort(); analysisRequest.current?.abort() }, [])
  // Focus after React enables the textarea, including after a mouse selection.
  useEffect(() => { if (selection) { textarea.current?.focus({ preventScroll: true }); if (window.matchMedia('(max-width:760px)').matches) textarea.current?.scrollIntoView({ block: 'center' }) } }, [selection])

  // Draft history: the toolbar and Ctrl+Z step through unchecked edits first.
  const undo = useCallback(() => { const r = undoDraft(history.current, draftRef.current); if (!r) return; history.current = r.history; invalid(); setDraft(r.state); setError(''); bump() }, [])
  const redo = useCallback(() => { const r = redoDraft(history.current, draftRef.current); if (!r) return; history.current = r.history; invalid(); setDraft(r.state); setError(''); bump() }, [])
  const canUndo = counts.past > 0 && !busy, canRedo = counts.future > 0 && !busy
  useEffect(() => { onHistory?.({ canUndo, canRedo, dirty: draftIds.length > 0, undo, redo }) }, [onHistory, canUndo, canRedo, draftIds.length, undo, redo])
  useEffect(() => () => onHistory?.(null), [onHistory])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      // The fragment textarea keeps the browser's own undo.
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      const redoing = key === 'y' || event.shiftKey
      if (redoing) { if (history.current.future.length) redo(); else if (!Object.keys(draftRef.current.drafts).length && store.canRedo) store.redo() }
      else if (history.current.past.length) undo()
      else if (!Object.keys(draftRef.current.drafts).length && store.canUndo) store.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, store])

  const discard = () => !dirty || window.confirm(draftIds.length > 1 ? `${draftIds.length} ungeprüfte Absatzänderungen verwerfen?` : 'Ungesicherte Korrektur verwerfen?')
  function accept(value: DirectSelection) { invalid(); setDraft(NONE); history.current = emptyHistory(); bump(); setSelection(value); setText(value.text); setParagraph(false); setPending(null); setError('') }
  function select(value: DirectSelection) {
    if (draftIds.length) { if (!window.confirm('Ungeprüfte Absatzänderungen verwerfen und dieses Textfragment bearbeiten?')) return; accept(value); return }
    if (selection && text !== selection.text) { setPending(value); return }
    accept(value)
  }
  function openBlock(id: string, from?: { x: number; y: number }, to?: { x: number; y: number }) {
    const m = models.get(id)
    if (!m || !analysis) return
    if (active?.id === id && !from) return
    if (fragmentDirty && !window.confirm('Ungesicherte Korrektur verwerfen?')) return
    const value = textOf(id), v = views.get(id) ?? inlineLayout(live(m), value, limitsOf(m, analysis))
    let range: TextRange = { start: value.length, end: value.length }
    if (v && from) {
      const stops = caretStops(v), a = hitOffset(v, stops, from.x, from.y, m.size), b = to ? hitOffset(v, stops, to.x, to.y, m.size) : a
      range = b < a ? { start: b, end: a, backward: true } : { start: a, end: b }
    }
    invalid(); setSelection(null); setPending(null); setText(''); setError('')
    history.current = { ...history.current, group: undefined }
    setDraft({ ...draftRef.current, active: { id, range } })
  }
  function edit(id: string, value: string, range: TextRange) {
    const m = models.get(id)
    if (!m) return
    const before = draftRef.current
    history.current = recordEdit(history.current, before, id, before.drafts[id] ?? m.text, value, clock())
    const next = withDraft(before, id, value, m.text, range)
    draftRef.current = next
    invalid(); setError(''); setDraft(next); bump()
  }
  function discardBlock(id: string) {
    const before = draftRef.current
    if (!(id in before.drafts)) return
    history.current = recordStep(history.current, before)
    const drafts = { ...before.drafts }; delete drafts[id]
    invalid(); setError(''); setDraft({ drafts, active: null }); bump()
  }
  function discardAll() {
    const before = draftRef.current
    if (!Object.keys(before.drafts).length) return
    history.current = recordStep(history.current, before)
    invalid(); setError(''); setDraft(NONE); bump()
  }
  async function check() {
    if (!source || !analysis || busy) return
    invalid(); const controller = new AbortController(); request.current = controller; const current = ++epoch.current
    setError(''); setBusy(true)
    try {
      let bytes: ArrayBuffer
      if (draftIds.length) {
        // Top to bottom, as a reader goes through the page.
        const order = [...draftIds].sort((a, b) => models.get(b)!.lines[0].baseline - models.get(a)!.lines[0].baseline)
        bytes = await previewSources(source, order.map(id => { const m = models.get(id)!; return { selection: { digest: analysis.digest, runId: m.runId, expectedText: m.expectedText, scope: 'paragraph' as const }, replacement: draft.drafts[id] } }), controller.signal)
      } else {
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
  /** Leave the paragraph; its draft stays on the page. */
  function leave() { invalid(); setError(''); history.current = { ...history.current, group: undefined }; setDraft({ ...draftRef.current, active: null }) }
  function pickPage(id: string) { if (id === pageId || !discard()) return; invalid(); setPageId(id) }
  const showingCandidate = !!candidate && !showOriginal
  const previewBytes = showingCandidate ? candidate.bytes : source
  useEffect(() => { const bytes = candidate?.bytes; return () => { if (bytes) { stages.drop(bytes); docs.drop(bytes) } } }, [candidate, docs, stages])
  const onPreviewReady = useCallback((value: boolean) => { setReady(value && showingCandidate); if (value) setShown(true) }, [showingCandidate])
  const neighbours = useMemo(() => {
    const at = pages.findIndex(value => value.id === pageId)
    return [pages[at + 1], pages[at - 1]].filter(Boolean).map(p => ({ bytes: sourceOf(p.id)!, pageNumber: p.sourceIndex + 1 })).filter(p => p.bytes)
  }, [pages, pageId, sourceOf])
  const overlays = !candidate && analysis
  const passive = draftIds.filter(id => id !== active?.id)
  // The changed part of a paragraph, with a little context.
  const snippet = (id: string) => {
    const before = models.get(id)?.text ?? '', after = draft.drafts[id] ?? before
    let i = 0
    while (i < before.length && i < after.length && before[i] === after[i]) i++
    let start = Math.max(0, i - 20)
    if (start) { const space = after.indexOf(' ', start); start = space >= 0 && space < i ? space + 1 : start }
    const end = Math.min(after.length, start + 56)
    return `${start ? '… ' : ''}${after.slice(start, end)}${end < after.length ? ' …' : ''}`
  }
  return <section className="source-correction" aria-label="Originaltext korrigieren">
    <aside className="source-editor">
      <h2>Originaltext korrigieren</h2><p>Einen umrahmten Absatz anklicken und direkt auf der Seite tippen. Mehrere Absätze lassen sich nacheinander ändern und gemeinsam prüfen. Andere Inhalte bleiben an ihrer Position.</p>
      {!selection && !active && !draftIds.length && <p className="source-instruction">Noch nichts ausgewählt. Absatz anklicken (Klickstelle = Cursor) oder mit Tab und Enter wählen. Gestrichelte Textfragmente erscheinen zum Bearbeiten hier im Seitenbereich.</p>}
      {active && model && <>
        <p className="source-font">Absatz mit {model.lines.length} {model.lines.length === 1 ? 'Zeile' : 'Zeilen'} · {model.size.toFixed(1).replace('.0', '')} pt{model.justified ? ' · Blocksatz' : ''}{model.room ? ` · Platz für ${model.room} weitere ${model.room === 1 ? 'Zeile' : 'Zeilen'}` : ' · kein Platz für weitere Zeilen'}</p>
        <p id="source-fit" className={`source-fit source-fit-${fit!.tone}`} role="status">{fit!.text}</p>
        <p className="source-hint">Pfeiltasten, Pos1/Ende und Maus wie gewohnt. Strg+Z/Strg+Y nimmt Eingaben zurück, Strg+Enter prüft, Esc verlässt den Absatz.</p>
      </>}
      {draftIds.length > 0 && <div className="source-drafts"><h3>{draftIds.length === 1 ? '1 geänderter Absatz' : `${draftIds.length} geänderte Absätze`} · noch nicht geprüft</h3><ul>
        {draftIds.map(id => { const f = fitMessage(views.get(id)?.status); return <li key={id} className={id === active?.id ? 'source-draft-active' : undefined}>
          <button type="button" className="source-draft-open" disabled={busy} onClick={() => openBlock(id)}><span>„{snippet(id)}“</span><small className={`source-fit-${f.tone}`}>{f.text}</small></button>
          <button type="button" className="source-draft-discard" disabled={busy} aria-label={`Änderung verwerfen: ${snippet(id)}`} title="Änderung an diesem Absatz verwerfen" onClick={() => discardBlock(id)}>×</button>
        </li> })}
      </ul></div>}
      {pending && <div className="source-pending" role="alert"><p>Die aktuelle Korrektur ist noch nicht übernommen. Verwerfen und die neue Auswahl bearbeiten?</p><button onClick={() => accept(pending)}>Auswahl wechseln</button><button onClick={() => { setPending(null); textarea.current?.focus() }}>Weiter bearbeiten</button></div>}
      {!active && run && <p className="source-font">{run.fontName} · {run.fontSize} pt · {automatic ? (run.paragraph!.lineCount > 1 ? `Absatz mit ${run.paragraph!.lineCount} Zeilen – wird bei Bedarf automatisch neu umbrochen` : 'Zeile wird als Ganzes bearbeitet – Folgetext rückt nach') : run.paragraph ? 'Absatzumbruch nach Bestätigung möglich' : 'Nur dieses Textfragment – kein Absatzumbruch'}</p>}
      {!active && run?.paragraph && <>{run.paragraph.lineCount > 1 && <button onClick={() => { const members = analysis!.runs.filter(value => value.selection?.groupId === run.selection?.groupId); const value = directSelection(analysis!.runs, members[0].id, 0, members.at(-1)!.id); if (value) select(value) }}>Ganzen Absatz auswählen</button>}{!automatic && <label className="source-check"><input type="checkbox" checked={paragraph} onChange={event => { invalid(); setParagraph(event.target.checked) }} />Diese {run.paragraph.lineCount} Zeilen sind ein Fließtextabsatz mit automatischen, nicht absichtlichen Umbrüchen. Absatz neu umbrechen.</label>}</>}
      {!active && selection?.requiresReflow && !reflow && <p>Die Auswahl umfasst mehrere Zeilen. Zum Ändern zuerst den automatischen Absatzumbruch bestätigen.</p>}
      {!active && selection && <><label htmlFor="source-replacement">Ersatztext</label><textarea ref={textarea} id="source-replacement" maxLength={4096} value={text} disabled={!run || busy || !!pending || !!candidate} onChange={event => { invalid(); setText(event.target.value) }} /></>}
      {busy && <p role="status">{draftIds.length > 1 ? `${draftIds.length} Absätze werden isoliert in der PDF geprüft …` : 'Text wird isoliert in der PDF geprüft …'}</p>}{error && <p role="alert">{error}</p>}
      {candidate && <p role="status">{ready ? (draftIds.length > 1 ? `Ergebnis mit ${draftIds.length} geänderten Absätzen in der echten PDF bereit. Absätze und Übergänge ansehen.` : 'Ergebnis in der echten PDF bereit. Absatz und Übergang zum Folgeinhalt ansehen.') : 'PDF-Ergebnis wird gerendert …'}</p>}
      <div className="source-actions">
        {!candidate && (draftIds.length > 0 || selection) && <button className="export-button" disabled={busy || !!pending || (draftIds.length ? !checkable : !run || !text.trim() || text === selection?.text || (!!selection?.requiresReflow && !reflow))} onClick={() => void check()}>In PDF prüfen</button>}
        {candidate && <><button onClick={keepEditing}>Weiter bearbeiten</button><button className="export-button" disabled={showOriginal || !ready || busy || !!pending || candidate.version !== version} onClick={apply}>Übernehmen</button></>}
        {draftIds.length > 1 && !candidate && <button onClick={discardAll} disabled={busy}>Alle Änderungen verwerfen</button>}
        <button onClick={() => { if (discard()) onClose() }}>Schließen</button>
      </div>
      <p>Weniger Zeilen lassen freien Platz unter dem Absatz. Mehr Zeilen nur bei sicher freiem Raum. Kein Verkleinern oder Stauchen. Folgende Absätze, Bilder und Grafiken bleiben unverändert. Rückgängig und Entwurfsspeicherung bleiben verfügbar.</p>
      <PageStrip docs={docs} pages={pages} sourceOf={sourceOf} current={pageId} disabled={busy && !!candidate} live={shown} onPick={pickPage} />
    </aside>
    <div className="source-context"><h2>{showingCandidate ? 'Ergebnis in der PDF – noch nicht übernommen' : candidate ? 'Original-PDF zum Vergleich' : 'Original-PDF · direkt im Absatz bearbeiten'}</h2>
      {overlays && <div className="source-legend" aria-label="Unterstützung der Textbereiche"><span className="legend-paragraph">Durchgezogen: Absatz direkt bearbeitbar</span><span className="legend-fragment">Gestrichelt: nur Textfragment</span><span>Ausgegraut: Unterstützung nicht nachgewiesen · für Grund anklicken</span><small>Die Passt-Anzeige rechnet mit den Originalschriften. Verbindlich ist die Prüfung in der echten PDF.</small></div>}
      {!analysis && <p role="status">Analyse läuft – Unterstützung noch unbekannt.</p>}
      {candidate && <button onClick={() => { setShowOriginal(value => !value); setReady(false) }}>{showOriginal ? 'Ergebnis anzeigen' : 'Original anzeigen'}</button>}
      {previewBytes && page && <PdfPreview docs={docs} stages={stages} prefetch={candidate ? undefined : neighbours} bytes={previewBytes} pageNumber={page.sourceIndex + 1} onReady={onPreviewReady} label={showingCandidate ? 'Geprüfte PDF-Seite mit geändertem Absatz' : 'PDF-Seite mit bearbeitbaren Absätzen'}>
        {stage => overlays && <>
          <SourceTextSelection runs={analysis.runs} size={stage.size} fragments={stage.fragments} selection={selection} onSelect={select} onReject={setError} blocks={blockIds} editing={active?.id} drafted={new Set(passive)} onBlock={openBlock} />
          {passive.map(id => <InlineSourceEditor key={id} model={models.get(id)!} view={views.get(id) ?? null} text={draft.drafts[id]} range={{ start: 0, end: 0 }} size={stage.size} canvas={stage.canvas} disabled={busy} passive
            onChange={() => undefined} onRange={() => undefined} onSubmit={() => undefined} onCancel={() => undefined} onActivate={at => openBlock(id, at)} />)}
          {active && model && <InlineSourceEditor key={model.id} model={model} view={view} text={textOf(model.id)} range={active.range} size={stage.size} canvas={stage.canvas} disabled={busy}
            onChange={(value, range) => edit(model.id, value, range)}
            onRange={range => setDraft({ ...draftRef.current, active: { id: model.id, range } })}
            onUndo={undo} onRedo={redo}
            onSubmit={() => { if (checkable) void check() }} onCancel={leave} />}
        </>}
      </PdfPreview>}
    </div>
  </section>
}
