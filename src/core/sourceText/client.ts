import type { SimpleSourceRun, SourceSelection } from './simplePdf'
interface Request { action: 'inspect' | 'preview'; bytes: ArrayBuffer; selection?: SourceSelection; replacement?: string }
/** One disposable worker per request. Termination covers parser/font code too,
 * not just cooperative cancellation after an expensive operation completes. */
export function sourceTextRequest<T>(request: Request, signal: AbortSignal, create = () => new Worker(new URL('./sourceText.worker.ts', import.meta.url), { type: 'module' }), timeoutMs = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Abgebrochen', 'AbortError')); return }
    const worker = create()
    const finish = (error?: Error, value?: T) => { clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate(); if (error) reject(error); else resolve(value!) }
    const abort = () => finish(new DOMException('Abgebrochen', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('Die Textanalyse hat zu lange gedauert und wurde beendet. Es wurde nichts verändert.')), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = event => event.data.error ? finish(new Error(event.data.error)) : finish(undefined, event.data.value)
    worker.onerror = () => finish(new Error('Die isolierte Textanalyse ist fehlgeschlagen. Es wurde nichts verändert.'))
    worker.onmessageerror = () => finish(new Error('Die Antwort der Textanalyse konnte nicht gelesen werden.'))
    try { const bytes = request.bytes.slice(0); worker.postMessage({ ...request, bytes }, [bytes]) } catch (error) { finish(error instanceof Error ? error : new Error('Textanalyse konnte nicht gestartet werden.')) }
  })
}
export const inspectSource = (bytes: ArrayBuffer, signal: AbortSignal) => sourceTextRequest<{ digest: string; runs: SimpleSourceRun[] }>({ action: 'inspect', bytes }, signal)
export const previewSource = (bytes: ArrayBuffer, selection: SourceSelection, replacement: string, signal: AbortSignal) => sourceTextRequest<ArrayBuffer>({ action: 'preview', bytes, selection, replacement }, signal)
