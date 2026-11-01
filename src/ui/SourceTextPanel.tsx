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
import { sourceRevisions, sourceTextBlocker } from '../core/sourceText/revision'
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
function PageStrip({ docs, pages, sourceOf, current, disabled, live, onPick, marks }: {
  docs: PdfDocuments; pages: { id: string; name: string; sourceIndex: number }[]; sourceOf: (id: string) => ArrayBuffer | undefined
  current: string; disabled: boolean; live: boolean; onPick: (id: string) => void
  /** Pages with drafts or checked results, with a short label. */
  marks: ReadonlyMap<string, string>
}) {
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' }) }, [current])
  return <nav className="source-pages" aria-label="Seiten"><h3>Seiten</h3><ol ref={list}>
    {pages.map((p, i) => <li key={p.id}><button type="button" aria-label={`Seite ${i + 1} anzeigen`} aria-description={marks.get(p.id)} aria-current={p.id === current ? 'page' : undefined} disabled={disabled} onClick={() => onPick(p.id)}>
      <Thumb docs={docs} bytes={live ? sourceOf(p.id) : undefined} pageNumber={p.sourceIndex + 1} root={list} /><span className="source-page-name">{i + 1} · {p.name}</span>{marks.has(p.id) && <span className="source-page-mark">{marks.get(p.id)}</span>}
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

/** Drafts of all pages share one history: key = page id + block id. */
const SEP = '\u0001'
const keyOf = (pageId: string, blockId: string) => pageId + SEP + blockId
const splitKey = (key: string) => { const i = key.indexOf(SEP); return { pageId: key.slice(0, i), blockId: key.slice(i + 1) } }
/** What a draft needs once its page is no longer shown: the block model for
 * the check and the last live fit for the list. */
type DraftMeta = { pageId: string; model: EditModel; digest: string; fit: { tone: string; text: string }; ok: boolean }
type Candidate = { pages: { pageId: string; bytes: ArrayBuffer; pageNumber: number }[]; version: number; paragraphs: number }
const fitOk = (v: InlineView | null | undefined) => !!v && !['same', 'invalid', 'missing'].includes(v.status.kind)

export function SourceTextPanel({ store, original, onClose, onHistory, initialPage = 0, onPage }: {
  store: EditorStore; original: ArrayBuffer; onClose: () => void; onHistory?: (history: SourceHistory | null) => void
  /** Page index shown first (the page viewed before opening). */
  initialPage?: number; onPage?: (index: number) => void
}) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion)
  const [docs] = useState(() => pdfDocuments()), [stages] = useState(() => stageCache())
  // Thumbnails wait for the first page view, which has priority.
  const [shown, setShown] = useState(false)
  useEffect(() => () => docs.destroy(), [docs])
  useEffect(() => { warmSourceWorkers(2) }, [])
  const [pageId, setPageId] = useState(() => (store.state.pages?.[initialPage] ?? store.state.pages?.[0])?.id ?? '')
  const pageRef = useRef(pageId)
  useLayoutEffect(() => { pageRef.current = pageId })
  const [analysis, setAnalysis] = useState<(SourceAnalysis & { pageId: string }) | null>(null)
  // Fragment flow (text without a proved paragraph): side-panel textarea.
  const [selection, setSelection] = useState<DirectSelection | null>(null), [pending, setPending] = useState<DirectSelection | null>(null)
  const [text, setText] = useState('')
  // Inline flow: proved paragraphs edited directly on the page, several at once, on several pages.
  const [draft, setDraft] = useState<DraftState>(NONE)
  const [metas, setMetas] = useState<Readonly<Record<string, DraftMeta>>>({})
  const history = useRef<DraftHistory>(emptyHistory()), draftRef = useRef(draft)
  const [counts, setCounts] = useState({ past: 0, future: 0 })
  useLayoutEffect(() => { draftRef.current = draft })
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [checking, setChecking] = useState(false), [error, setError] = useState('')
  const request = useRef<AbortController | null>(null), epoch = useRef(0), seenVersion = useRef(version)
  // The page analysis has its own request and counter: invalidating a preview must not drop it.
  const analysisRequest = useRef<AbortController | null>(null), analysisEpoch = useRef(0)
  const pages = store.state.pages ?? NO_PAGES
  const page = pages.find(value => value.id === pageId)
  const pageNumberOf = useCallback((id: string) => pages.findIndex(p => p.id === id) + 1, [pages])
  useEffect(() => { const i = pages.findIndex(p => p.id === pageId); if (i >= 0) onPage?.(i) }, [pages, pageId, onPage])
  const sourceOf = useCallback((id: string) => {
    const p = store.state.pages?.find(value => value.id === id)
    return p?.sourceId === 'original' ? original : store.state.pageSources?.find(value => value.id === p?.sourceId)?.bytes
  }, [store, original])
  const source = page ? sourceOf(page.id) : undefined
  const current = analysis?.pageId === pageId ? analysis : null
  const run = current?.runs.find(value => value.id === selection?.runId)
  const fonts = useMemo(() => (current?.fonts ?? []).map(liveFont), [current])
  const models = useMemo(() => new Map((current?.blocks ?? []).map(b => [b.id, b])), [current])
  const blockIds = useMemo(() => new Set(models.keys()), [models])
  const allKeys = useMemo(() => Object.keys(draft.drafts), [draft.drafts])
  const draftIds = useMemo(() => allKeys.map(splitKey).filter(k => k.pageId === pageId && models.has(k.blockId)).map(k => k.blockId), [allKeys, models, pageId])
  const lives = useMemo(() => new Map([...models.values()].map(m => [m.id, liveBlock(m, fonts)])), [models, fonts])
  const live = useCallback((m: EditModel) => lives.get(m.id) ?? liveBlock(m, fonts), [lives, fonts])
  const textOf = useCallback((id: string) => draft.drafts[keyOf(pageId, id)] ?? models.get(id)?.text ?? '', [draft.drafts, models, pageId])
  const activeKey = draft.active ? splitKey(draft.active.id) : null
  const active = draft.active && activeKey!.pageId === pageId && models.has(activeKey!.blockId) ? { id: activeKey!.blockId, range: draft.active.range } : null
  // Each changed paragraph against the page as it would be with the other drafts.
  const views = useMemo(() => {
    const out = new Map<string, InlineView | null>()
    if (!current) return out
    const shown = new Set(draftIds)
    if (active) shown.add(active.id)
    const base = new Map(draftIds.map(id => { const m = models.get(id)!; return [id, inlineLayout(live(m), textOf(id), limitsOf(m, current))] }))
    for (const id of shown) {
      const m = models.get(id)!, others = draftIds.filter(o => o !== id)
      if (!others.length) { out.set(id, base.get(id) ?? inlineLayout(live(m), textOf(id), limitsOf(m, current))); continue }
      const removed = new Set(others.flatMap(o => models.get(o)!.space.own))
      const extra = others.flatMap(o => { const v = base.get(o); return v ? lineBoxes(v) : [] })
      out.set(id, inlineLayout(live(m), textOf(id), { room: m.room, pinned: m.pinned, slots: m.slots, space: draftSpace(m, current.rects, removed, extra) }))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, models, draftIds, active?.id, live, textOf])
  /** Keep the live fit of the shown page's drafts before leaving the page: the
   * list and the check use it while another page is shown. */
  const snapshot = () => setMetas(prev => {
    let next: Record<string, DraftMeta> | null = null
    for (const id of draftIds) {
      const k = keyOf(pageId, id), m = prev[k], v = views.get(id), fit = fitMessage(v?.status), ok = fitOk(v)
      if (m && (m.fit.text !== fit.text || m.ok !== ok)) { next ??= { ...prev }; next[k] = { ...m, fit, ok } }
    }
    return next ?? prev
  })
  const snapshotRef = useRef(snapshot)
  useLayoutEffect(() => { snapshotRef.current = snapshot })
  const model = active ? models.get(active.id) : undefined
  const view = active ? views.get(active.id) ?? null : null
  const fit = model ? fitMessage(view?.status) : undefined
  const okOf = (k: string) => { const { pageId: p, blockId } = splitKey(k); return p === pageId && models.has(blockId) ? fitOk(views.get(blockId)) : !!metas[k]?.ok }
  const checkable = allKeys.length > 0 && allKeys.every(k => !!metas[k] && okOf(k))
  const draftPages = useMemo(() => new Set(allKeys.map(k => splitKey(k).pageId)), [allKeys])
  const fragmentDirty = !!selection && text !== selection.text
  const dirty = allKeys.length > 0 || fragmentDirty
  const invalid = () => { request.current?.abort(); epoch.current++; setCandidate(null); setShowOriginal(false); setReady(false); setBusy(false); setChecking(false) }
  const bump = () => setCounts({ past: history.current.past.length, future: history.current.future.length })
  useEffect(() => {
    // A changed document invalidates every draft; a page switch keeps them.
    const changed = seenVersion.current !== version
    seenVersion.current = version
    if (changed) request.current?.abort()
    analysisRequest.current?.abort(); const controller = new AbortController(); analysisRequest.current = controller
    const currentEpoch = ++analysisEpoch.current
    queueMicrotask(() => {
      if (controller.signal.aborted) return
      if (changed) { setCandidate(null); setShowOriginal(false); setReady(false); setDraft(NONE); setMetas({}); history.current = emptyHistory(); bump() }
      setAnalysis(null); setSelection(null); setPending(null); setText(''); setError(''); setBusy(true)
    })
    const blocker = sourceTextBlocker(store.state, pageId)
    if (!source || blocker) {
      queueMicrotask(() => { if (!controller.signal.aborted) { setAnalysis({ ...EMPTY_ANALYSIS, pageId }); setError(blocker ?? 'Diese Seite ist derzeit nicht unterstützt.'); setBusy(false) } }); return () => controller.abort()
    }
    void cachedInspection(source, page!.sourceIndex, controller.signal).then(result => {
      if (controller.signal.aborted || analysisEpoch.current !== currentEpoch) return
      const runs = result.runs.filter(value => value.pageIndex === page!.sourceIndex)
      setAnalysis({ ...result, runs, blocks: result.blocks ?? [], fonts: result.fonts ?? [], rects: result.rects ?? [], pageId })
      if (!runs.some(value => value.selection)) setError('Keine sicher markierbaren Originaltextstellen nachgewiesen. Bei Scans ist zunächst OCR nötig; Text-PDFs können nicht unterstützte Schriften oder Strukturen enthalten.')
      // The neighbours are the likely next pages: analyze them in the background.
      const all = store.state.pages ?? [], at = all.findIndex(value => value.id === page!.id)
      for (const next of [all[at + 1], all[at - 1]]) { const bytes = next && !sourceTextBlocker(store.state, next.id) ? sourceOf(next.id) : undefined; if (bytes) prefetchInspection(bytes, next.sourceIndex) }
    }).catch(problem => { if (!controller.signal.aborted) { setAnalysis({ ...EMPTY_ANALYSIS, pageId }); setError(problem instanceof Error ? problem.message : 'Textanalyse fehlgeschlagen.') } }).finally(() => { if (!controller.signal.aborted && analysisEpoch.current === currentEpoch) setBusy(false) })
    return () => { controller.abort() }
  }, [version, pageId, page, source, store, sourceOf])
  useEffect(() => () => { request.current?.abort(); analysisRequest.current?.abort() }, [])
  // Focus after React enables the textarea, including after a mouse selection.
  useEffect(() => { if (selection) { textarea.current?.focus({ preventScroll: true }); if (window.matchMedia('(max-width:760px)').matches) textarea.current?.scrollIntoView({ block: 'center' }) } }, [selection])

  /** Undo/redo may change a draft on another page: show that page. */
  const restore = useCallback((before: DraftState, after: DraftState) => {
    const keys = new Set([...Object.keys(before.drafts), ...Object.keys(after.drafts)])
    const changed = [...keys].find(k => before.drafts[k] !== after.drafts[k]) ?? after.active?.id
    const target = changed ? splitKey(changed).pageId : undefined
    if (target && target !== pageRef.current) { snapshotRef.current(); setPageId(target) }
  }, [])
  // Draft history: the toolbar and Ctrl+Z step through unchecked edits first.
  const undo = useCallback(() => { const r = undoDraft(history.current, draftRef.current); if (!r) return; history.current = r.history; invalid(); restore(draftRef.current, r.state); setDraft(r.state); setError(''); bump() }, [restore])
  const redo = useCallback(() => { const r = redoDraft(history.current, draftRef.current); if (!r) return; history.current = r.history; invalid(); restore(draftRef.current, r.state); setDraft(r.state); setError(''); bump() }, [restore])
  const canUndo = counts.past > 0 && !checking, canRedo = counts.future > 0 && !checking
  useEffect(() => { onHistory?.({ canUndo, canRedo, dirty: allKeys.length > 0, undo, redo }) }, [onHistory, canUndo, canRedo, allKeys.length, undo, redo])
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

  const discard = () => !dirty || window.confirm(allKeys.length > 1 ? `${allKeys.length} ungeprüfte Absatzänderungen verwerfen?` : 'Ungesicherte Korrektur verwerfen?')
  function accept(value: DirectSelection) { invalid(); setDraft(NONE); setMetas({}); history.current = emptyHistory(); bump(); setSelection(value); setText(value.text); setPending(null); setError('') }
  function select(value: DirectSelection) {
    if (allKeys.length) { if (!window.confirm('Ungeprüfte Absatzänderungen verwerfen und dieses Textfragment bearbeiten?')) return; accept(value); return }
    if (selection && text !== selection.text) { setPending(value); return }
    accept(value)
  }
  function openBlock(id: string, from?: { x: number; y: number }, to?: { x: number; y: number }) {
    const m = models.get(id)
    if (!m || !current) return
    if (active?.id === id && !from) return
    if (fragmentDirty && !window.confirm('Ungesicherte Korrektur verwerfen?')) return
    const value = textOf(id), v = views.get(id) ?? inlineLayout(live(m), value, limitsOf(m, current))
    let range: TextRange = { start: value.length, end: value.length }
    if (v && from) {
      const stops = caretStops(v), a = hitOffset(v, stops, from.x, from.y, m.size), b = to ? hitOffset(v, stops, to.x, to.y, m.size) : a
      range = b < a ? { start: b, end: a, backward: true } : { start: a, end: b }
    }
    invalid(); setSelection(null); setPending(null); setText(''); setError('')
    history.current = { ...history.current, group: undefined }
    setDraft({ ...draftRef.current, active: { id: keyOf(pageId, id), range } })
  }
  /** A draft from the list: on another page, switch there with the caret at its end. */
  function openDraft(key: string) {
    const { pageId: p, blockId } = splitKey(key)
    if (p === pageId) { openBlock(blockId); return }
    if (fragmentDirty && !window.confirm('Ungesicherte Korrektur verwerfen?')) return
    const end = draftRef.current.drafts[key]?.length ?? 0
    invalid(); snapshot(); history.current = { ...history.current, group: undefined }
    setDraft({ ...draftRef.current, active: { id: key, range: { start: end, end } } }); setPageId(p)
  }
  function edit(id: string, value: string, range: TextRange) {
    const m = models.get(id)
    if (!m || !current) return
    const before = draftRef.current, key = keyOf(pageId, id)
    history.current = recordEdit(history.current, before, key, before.drafts[key] ?? m.text, value, clock())
    const next = withDraft(before, key, value, m.text, range)
    draftRef.current = next
    if (!metas[key]) setMetas(prev => ({ ...prev, [key]: { pageId, model: m, digest: current.digest, fit: fitMessage(undefined), ok: false } }))
    invalid(); setError(''); setDraft(next); bump()
  }
  function discardBlock(key: string) {
    const before = draftRef.current
    if (!(key in before.drafts)) return
    history.current = recordStep(history.current, before)
    const drafts = { ...before.drafts }; delete drafts[key]
    invalid(); setError(''); setDraft({ drafts, active: null }); bump()
  }
  function discardAll() {
    const before = draftRef.current
    if (!Object.keys(before.drafts).length) return
    history.current = recordStep(history.current, before)
    invalid(); setError(''); setDraft(NONE); bump()
  }
  async function check() {
    if (busy) return
    invalid(); const controller = new AbortController(); request.current = controller; const currentEpoch = ++epoch.current
    setError(''); setBusy(true); setChecking(true)
    try {
      const out: Candidate['pages'] = []
      let paragraphs = 1
      if (allKeys.length) {
        paragraphs = allKeys.length
        // Page order, and top to bottom on each page, as a reader goes through the document.
        for (const p of pages.filter(value => draftPages.has(value.id))) {
          const bytes = sourceOf(p.id), keys = allKeys.filter(k => splitKey(k).pageId === p.id)
            .sort((a, b) => metas[b].model.lines[0].baseline - metas[a].model.lines[0].baseline)
          const label = draftPages.size > 1 ? `Seite ${pageNumberOf(p.id)}: ` : ''
          if (!bytes) throw new Error(`${label}Die Seite ist nicht mehr verfügbar.`)
          try {
            out.push({ pageId: p.id, pageNumber: p.sourceIndex + 1, bytes: await previewSources(bytes, keys.map(k => { const { model: m, digest } = metas[k]; return { selection: { digest, runId: m.runId, expectedText: m.expectedText, scope: 'paragraph' as const }, replacement: draftRef.current.drafts[k] } }), controller.signal) })
          } catch (problem) { if (controller.signal.aborted) throw problem; throw new Error(label + (problem instanceof Error ? problem.message : 'Korrektur fehlgeschlagen.'), { cause: problem }) }
        }
      } else {
        if (!source || !current || !page || !run || !selection || pending) return
        const replacement = selectedReplacement(run, selection, text)
        out.push({ pageId, pageNumber: page.sourceIndex + 1, bytes: await previewSource(source, { digest: current.digest, runId: run.id, expectedText: run.text }, replacement, controller.signal) })
      }
      // Every result page must render before it can be applied, not only the one on screen.
      for (const o of out) { if (controller.signal.aborted) return; const pdf = await docs.get(o.bytes); await pdf.renderPage(o.pageNumber, document.createElement('canvas'), .25) }
      if (!controller.signal.aborted && epoch.current === currentEpoch && version === store.getVersion()) {
        setCandidate({ pages: out, version, paragraphs })
        if (!out.some(o => o.pageId === pageRef.current)) setPageId(out[0].pageId)
      }
    } catch (problem) { if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : 'Korrektur fehlgeschlagen.') }
    finally { if (!controller.signal.aborted && epoch.current === currentEpoch) { setBusy(false); setChecking(false) } }
  }
  const result = candidate?.pages.find(o => o.pageId === pageId)
  const showingCandidate = !!result && !showOriginal
  const canApply = !!candidate && !showOriginal && (!result || ready) && !busy && !pending && candidate.version === version
  function apply() {
    if (!candidate || !canApply) { invalid(); return }
    try { store.dispatch(sourceRevisions(store.state, candidate.pages.map(({ pageId: p, bytes }) => ({ pageId: p, bytes })))); onClose() }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Die Korrektur konnte nicht übernommen werden.'); invalid() }
  }
  function keepEditing() { invalid(); setError('') }
  /** Leave the paragraph; its draft stays on the page. */
  function leave() { invalid(); setError(''); history.current = { ...history.current, group: undefined }; setDraft({ ...draftRef.current, active: null }) }
  function pickPage(id: string) {
    if (id === pageId) return
    // Paragraph drafts stay; only an unsaved fragment edit belongs to its page.
    if (fragmentDirty && !window.confirm('Ungesicherte Korrektur verwerfen?')) return
    if (!candidate) { invalid(); setError('') }
    if (draft.active) setDraft({ ...draftRef.current, active: null })
    snapshot(); setShowOriginal(false); setPageId(id)
  }
  const previewBytes = showingCandidate ? result.bytes : source
  useEffect(() => { const all = candidate?.pages.map(o => o.bytes) ?? []; return () => { for (const bytes of all) { stages.drop(bytes); docs.drop(bytes) } } }, [candidate, docs, stages])
  const onPreviewReady = useCallback((value: boolean) => { setReady(value && showingCandidate); if (value) setShown(true) }, [showingCandidate])
  const neighbours = useMemo(() => {
    const at = pages.findIndex(value => value.id === pageId)
    return [pages[at + 1], pages[at - 1]].filter(Boolean).map(p => ({ bytes: sourceOf(p.id)!, pageNumber: p.sourceIndex + 1 })).filter(p => p.bytes)
  }, [pages, pageId, sourceOf])
  const overlays = !candidate && current
  const passive = draftIds.filter(id => id !== active?.id)
  // The changed part of a paragraph, with a little context.
  const snippet = (key: string) => {
    const before = metas[key]?.model.text ?? '', after = draft.drafts[key] ?? before
    let i = 0
    while (i < before.length && i < after.length && before[i] === after[i]) i++
    let start = Math.max(0, i - 20)
    if (start) { const space = after.indexOf(' ', start); start = space >= 0 && space < i ? space + 1 : start }
    const end = Math.min(after.length, start + 56)
    return `${start ? '… ' : ''}${after.slice(start, end)}${end < after.length ? ' …' : ''}`
  }
  const fitOf = (key: string) => { const { pageId: p, blockId } = splitKey(key); return p === pageId && models.has(blockId) ? fitMessage(views.get(blockId)?.status) : metas[key]?.fit ?? fitMessage(undefined) }
  // List in document order: by page, then top to bottom.
  const listed = [...allKeys].sort((a, b) => pageNumberOf(splitKey(a).pageId) - pageNumberOf(splitKey(b).pageId) || (metas[b]?.model.lines[0].baseline ?? 0) - (metas[a]?.model.lines[0].baseline ?? 0))
  const scope = draftPages.size > 1 ? ` auf ${draftPages.size} Seiten` : ''
  const resultPages = candidate && candidate.pages.length > 1 ? ` auf ${candidate.pages.length} Seiten` : ''
  return <section className="source-correction" aria-label="Originaltext korrigieren">
    <aside className="source-editor">
      <h2>Originaltext korrigieren</h2><p>Einen umrahmten Absatz anklicken und direkt auf der Seite tippen. Mehrere Absätze – auch auf verschiedenen Seiten – lassen sich nacheinander ändern und gemeinsam prüfen. Andere Inhalte bleiben an ihrer Position.</p>
      {!selection && !active && !allKeys.length && <p className="source-instruction">Noch nichts ausgewählt. Absatz anklicken (Klickstelle = Cursor) oder mit Tab und Enter wählen. Gestrichelte Textfragmente erscheinen zum Bearbeiten hier im Seitenbereich.</p>}
      {active && model && !candidate && <>
        <p className="source-font">Absatz mit {model.lines.length} {model.lines.length === 1 ? 'Zeile' : 'Zeilen'} · {model.size.toFixed(1).replace('.0', '')} pt{model.justified ? ' · Blocksatz' : ''}{model.room ? ` · Platz für ${model.room} weitere ${model.room === 1 ? 'Zeile' : 'Zeilen'}` : ' · kein Platz für weitere Zeilen'}</p>
        <p id="source-fit" className={`source-fit source-fit-${fit!.tone}`} role="status">{fit!.text}</p>
        <p className="source-hint">Pfeiltasten, Pos1/Ende und Maus wie gewohnt. Strg+Z/Strg+Y nimmt Eingaben zurück, Strg+Enter prüft, Esc verlässt den Absatz.</p>
      </>}
      {allKeys.length > 0 && <div className="source-drafts"><h3>{allKeys.length === 1 ? '1 geänderter Absatz' : `${allKeys.length} geänderte Absätze`}{scope} · {candidate ? 'geprüft' : 'noch nicht geprüft'}</h3><ul>
        {listed.map(k => { const f = fitOf(k), p = splitKey(k).pageId, where = draftPages.size > 1 || p !== pageId ? `Seite ${pageNumberOf(p)} · ` : ''; return <li key={k} className={k === draft.active?.id ? 'source-draft-active' : undefined}>
          <button type="button" className="source-draft-open" disabled={checking || !!candidate} onClick={() => openDraft(k)}><span>{where}„{snippet(k)}“</span><small className={`source-fit-${f.tone}`}>{f.text}</small></button>
          <button type="button" className="source-draft-discard" disabled={checking || !!candidate} aria-label={`Änderung verwerfen: ${snippet(k)}`} title="Änderung an diesem Absatz verwerfen" onClick={() => discardBlock(k)}>×</button>
        </li> })}
      </ul></div>}
      {pending && <div className="source-pending" role="alert"><p>Die aktuelle Korrektur ist noch nicht übernommen. Verwerfen und die neue Auswahl bearbeiten?</p><button onClick={() => accept(pending)}>Auswahl wechseln</button><button onClick={() => { setPending(null); textarea.current?.focus() }}>Weiter bearbeiten</button></div>}
      {!active && run && <p className="source-font">{run.fontName} · {run.fontSize} pt · Nur dieses Textfragment – kein Absatzumbruch</p>}
      {!active && selection && <><label htmlFor="source-replacement">Ersatztext</label><textarea ref={textarea} id="source-replacement" maxLength={4096} value={text} disabled={!run || busy || !!pending || !!candidate} onChange={event => { invalid(); setText(event.target.value) }} /></>}
      {checking && <p role="status">{allKeys.length > 1 ? `${allKeys.length} Absätze${scope} werden isoliert in der PDF geprüft …` : 'Text wird isoliert in der PDF geprüft …'}</p>}{error && <p role="alert">{error}</p>}
      {candidate && <p role="status">{!result ? `Ergebnis${resultPages} bereit. Geprüfte Seiten sind in der Seitenliste markiert.` : ready ? (candidate.paragraphs > 1 ? `Ergebnis mit ${candidate.paragraphs} geänderten Absätzen${resultPages} in der echten PDF bereit. Absätze und Übergänge ansehen.` : 'Ergebnis in der echten PDF bereit. Absatz und Übergang zum Folgeinhalt ansehen.') : 'PDF-Ergebnis wird gerendert …'}</p>}
      <div className="source-actions">
        {!candidate && (allKeys.length > 0 || selection) && <button className="export-button" disabled={busy || !!pending || (allKeys.length ? !checkable : !run || !text.trim() || text === selection?.text)} onClick={() => void check()}>In PDF prüfen</button>}
        {candidate && <><button onClick={keepEditing}>Weiter bearbeiten</button><button className="export-button" disabled={!canApply} onClick={apply}>Übernehmen</button></>}
        {allKeys.length > 1 && !candidate && <button onClick={discardAll} disabled={checking}>Alle Änderungen verwerfen</button>}
        <button onClick={() => { if (discard()) onClose() }}>Schließen</button>
      </div>
      <p>Weniger Zeilen lassen freien Platz unter dem Absatz. Mehr Zeilen nur bei sicher freiem Raum. Kein Verkleinern oder Stauchen. Folgende Absätze, Bilder und Grafiken bleiben unverändert. Rückgängig und Entwurfsspeicherung bleiben verfügbar.</p>
      <PageStrip docs={docs} pages={pages} sourceOf={sourceOf} current={pageId} disabled={checking} live={shown} onPick={pickPage}
        marks={candidate ? new Map(candidate.pages.map(o => [o.pageId, 'geprüft'])) : new Map([...draftPages].map(p => [p, 'geändert']))} />
    </aside>
    <div className="source-context"><h2>{showingCandidate ? 'Ergebnis in der PDF – noch nicht übernommen' : result ? 'Original-PDF zum Vergleich' : candidate ? 'Original-PDF · auf dieser Seite keine Änderung' : 'Original-PDF · direkt im Absatz bearbeiten'}</h2>
      {overlays && <div className="source-legend" aria-label="Unterstützung der Textbereiche"><span className="legend-paragraph">Durchgezogen: Absatz direkt bearbeitbar</span><span className="legend-fragment">Gestrichelt: nur Textfragment</span><span>Ausgegraut: Unterstützung nicht nachgewiesen · für Grund anklicken</span><small>Die Passt-Anzeige rechnet mit den Originalschriften. Verbindlich ist die Prüfung in der echten PDF.</small></div>}
      {!current && !candidate && <p role="status">Analyse läuft – Unterstützung noch unbekannt.</p>}
      {result && <button onClick={() => { setShowOriginal(value => !value); setReady(false) }}>{showOriginal ? 'Ergebnis anzeigen' : 'Original anzeigen'}</button>}
      {previewBytes && page && <PdfPreview docs={docs} stages={stages} prefetch={candidate ? undefined : neighbours} bytes={previewBytes} pageNumber={page.sourceIndex + 1} onReady={onPreviewReady} label={showingCandidate ? 'Geprüfte PDF-Seite mit geändertem Absatz' : 'PDF-Seite mit bearbeitbaren Absätzen'}>
        {stage => overlays && <>
          <SourceTextSelection runs={overlays.runs} size={stage.size} fragments={stage.fragments} selection={selection} onSelect={select} onReject={setError} blocks={blockIds} editing={active?.id} drafted={new Set(passive)} onBlock={openBlock} />
          {passive.map(id => <InlineSourceEditor key={id} model={models.get(id)!} view={views.get(id) ?? null} text={draft.drafts[keyOf(pageId, id)]} range={{ start: 0, end: 0 }} size={stage.size} canvas={stage.canvas} disabled={busy} passive
            onChange={() => undefined} onRange={() => undefined} onSubmit={() => undefined} onCancel={() => undefined} onActivate={at => openBlock(id, at)} />)}
          {active && model && <InlineSourceEditor key={model.id} model={model} view={view} text={textOf(model.id)} range={active.range} size={stage.size} canvas={stage.canvas} disabled={busy}
            onChange={(value, range) => edit(model.id, value, range)}
            onRange={range => setDraft({ ...draftRef.current, active: { id: keyOf(pageId, model.id), range } })}
            onUndo={undo} onRedo={redo}
            onSubmit={() => { if (checkable) void check() }} onCancel={leave} />}
        </>}
      </PdfPreview>}
    </div>
  </section>
}
