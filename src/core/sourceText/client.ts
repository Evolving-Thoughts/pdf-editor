import type { SourceRun, SourceSelection } from './sourceTypes'
import type { EditFont, EditModel } from './editModel'
import type { Box } from './space'
export interface SourceAnalysis { digest: string; runs: SourceRun[]; blocks: EditModel[]; fonts: EditFont[]; rects: Box[] }
export interface SourceEdit { selection: SourceSelection; replacement: string }
interface Request { action: 'inspect' | 'preview'; bytes: ArrayBuffer; selection?: SourceSelection; replacement?: string; edits?: SourceEdit[]; pageIndex?: number }
const spawn = () => new Worker(new URL('./sourceText.worker.ts', import.meta.url), { type: 'module' })
/** Idle workers of the default factory. Workers keep no state between
 * requests; reusing one only saves module start-up. Aborted or timed-out
 * workers are always terminated, never reused. */
const idle: Worker[] = []
const IDLE_LIMIT = 2
/** Start a worker ahead of the first request (e.g. when the panel opens). */
export function warmSourceWorkers(count = 1) {
  if (typeof Worker === 'undefined') return
  while (idle.length < Math.min(count, IDLE_LIMIT)) idle.push(spawn())
}
/** One worker per request at a time. Termination covers parser/font code too,
 * not just cooperative cancellation after an expensive operation completes. */
export function sourceTextRequest<T>(request: Request, signal: AbortSignal, create?: () => Worker, timeoutMs = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Abgebrochen', 'AbortError')); return }
    const pooled = !create, worker = pooled ? (idle.pop() ?? spawn()) : create()
    const finish = (error?: Error, value?: T, reusable = false) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      worker.onmessage = worker.onerror = worker.onmessageerror = null
      if (pooled && reusable && idle.length < IDLE_LIMIT) idle.push(worker); else worker.terminate()
      if (error) reject(error); else resolve(value!)
    }
    const abort = () => finish(new DOMException('Abgebrochen', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('Die Textanalyse hat zu lange gedauert und wurde beendet. Es wurde nichts verändert.')), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = event => event.data.error ? finish(new Error(event.data.error), undefined, true) : finish(undefined, event.data.value, true)
    worker.onerror = () => finish(new Error('Die isolierte Textanalyse ist fehlgeschlagen. Es wurde nichts verändert.'))
    worker.onmessageerror = () => finish(new Error('Die Antwort der Textanalyse konnte nicht gelesen werden.'))
    try { const bytes = request.bytes.slice(0); worker.postMessage({ ...request, bytes }, [bytes]) } catch (error) { finish(error instanceof Error ? error : new Error('Textanalyse konnte nicht gestartet werden.')) }
  })
}
export const inspectSource = (bytes: ArrayBuffer, signal: AbortSignal, pageIndex?: number) => sourceTextRequest<SourceAnalysis>({ action: 'inspect', bytes, pageIndex }, signal)
export const previewSource = (bytes: ArrayBuffer, selection: SourceSelection, replacement: string, signal: AbortSignal) => sourceTextRequest<ArrayBuffer>({ action: 'preview', bytes, selection, replacement }, signal)
/** Several proved paragraphs of one page, checked together in one candidate. */
export const previewSources = (bytes: ArrayBuffer, edits: SourceEdit[], signal: AbortSignal) =>
  sourceTextRequest<ArrayBuffer>({ action: 'preview', bytes, edits }, signal)

/** Analyses per source buffer and page. A source buffer is immutable (a page
 * revision creates a new buffer), so a cached analysis stays valid; only
 * successful analyses are kept. */
const analyses = new WeakMap<ArrayBuffer, Map<number, Promise<SourceAnalysis>>>()
export function cachedInspection(bytes: ArrayBuffer, pageIndex: number, signal: AbortSignal): Promise<SourceAnalysis> {
  let pages = analyses.get(bytes)
  if (!pages) analyses.set(bytes, (pages = new Map()))
  const hit = pages.get(pageIndex)
  if (hit) return abortable(hit, signal)
  // The shared request runs to completion even if this caller leaves; others may wait for it.
  const shared = inspectSource(bytes, new AbortController().signal, pageIndex)
  pages.set(pageIndex, shared)
  shared.catch(() => { if (pages.get(pageIndex) === shared) pages.delete(pageIndex) })
  return abortable(shared, signal)
}
/** Background analysis of a page the user is likely to open next. */
export function prefetchInspection(bytes: ArrayBuffer, pageIndex: number) {
  if (analyses.get(bytes)?.has(pageIndex)) return
  void cachedInspection(bytes, pageIndex, new AbortController().signal).catch(() => undefined)
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Abgebrochen', 'AbortError'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Abgebrochen', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
