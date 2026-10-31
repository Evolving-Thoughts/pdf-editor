// Core module: runs one export step in its own worker and owns that worker's life.
// PDF.js keeps its separate worker for viewing. Each job gets a fresh worker, so
// terminating it releases everything, including work pdf-lib cannot interrupt.
import type { ExportProgress, ExportRequest, ExportResult } from './exportPipeline'
import type { PreflightReport } from './preflight'
import type { DocumentSnapshot } from './documentOutput'

export const EXPORT_TIMEOUT_MS = 10 * 60 * 1000

export type ExportJob =
  | { jobId: string; kind: 'export'; request: ExportRequest }
  | { jobId: string; kind: 'encrypt'; bytes: Uint8Array; password: string }
  | { jobId: string; kind: 'preflight'; input: DocumentSnapshot }
  | { jobId: string; kind: 'extract'; document: DocumentSnapshot; ids: readonly string[] }

export type ExportJobMessage =
  | { jobId: string; type: 'progress'; progress: ExportProgress }
  | { jobId: string; type: 'done'; result: ExportResult | Uint8Array | PreflightReport }
  | { jobId: string; type: 'error'; message: string }

export interface JobWorker {
  onmessage: ((event: MessageEvent<ExportJobMessage>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
  postMessage(message: ExportJob): void
  terminate(): void
}

export const spawnExportWorker = (): JobWorker => new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })

export interface JobOptions {
  signal?: AbortSignal
  timeoutMs?: number
  onProgress?: (progress: ExportProgress) => void
  spawn?: () => JobWorker
}

function runJob<T>(job: ExportJob, { signal, timeoutMs = EXPORT_TIMEOUT_MS, onProgress, spawn = spawnExportWorker }: JobOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Export abgebrochen.', 'AbortError'))
      return
    }
    const worker = spawn()
    const finish = (settle: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      worker.onmessage = worker.onerror = worker.onmessageerror = null
      worker.terminate()
      settle()
    }
    const abort = () => finish(() => reject(new DOMException('Export abgebrochen.', 'AbortError')))
    const fail = (message: string) => finish(() => reject(new Error(message)))
    const timer = setTimeout(() => fail('Der Export hat zu lange gedauert und wurde beendet. Es wurde keine Datei gespeichert.'), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = () => fail('Der Export ist fehlgeschlagen. Es wurde keine Datei gespeichert.')
    worker.onmessageerror = () => fail('Der Export ist fehlgeschlagen. Es wurde keine Datei gespeichert.')
    worker.onmessage = ({ data }) => {
      // A message from another job can never finish this one.
      if (data.jobId !== job.jobId) return
      if (data.type === 'progress') onProgress?.(data.progress)
      else if (data.type === 'error') fail(data.message)
      else finish(() => resolve(data.result as T))
    }
    // Structured clone copies the buffers, so the editor's own bytes stay usable.
    worker.postMessage(job)
  })
}

let jobs = 0
const nextJobId = () => `export-${Date.now().toString(36)}-${++jobs}`

export const exportInWorker = (request: ExportRequest, options: JobOptions = {}) =>
  runJob<ExportResult>({ jobId: nextJobId(), kind: 'export', request }, options)

export const preflightInWorker = (input: DocumentSnapshot, options: JobOptions = {}) =>
  runJob<PreflightReport>({ jobId: nextJobId(), kind: 'preflight', input }, options)

export const extractInWorker = (document: DocumentSnapshot, ids: readonly string[], options: JobOptions = {}) =>
  runJob<Uint8Array>({ jobId: nextJobId(), kind: 'extract', document, ids }, options)

export const encryptInWorker = (bytes: Uint8Array, password: string, options: JobOptions = {}) =>
  runJob<Uint8Array>({ jobId: nextJobId(), kind: 'encrypt', bytes, password }, options)
