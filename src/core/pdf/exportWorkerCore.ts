// Worker side of an export job, separated from `self` so it can run in tests.
// Messages carry only what the user is meant to read: never document content or passwords.
import type { ExportJob, ExportJobMessage } from './exportJob'
import { extractPages, runExport, type ExportResult } from './exportPipeline'
import { preflightExport, type PreflightReport } from './preflight'
import { encodeCompressedImage } from '../images/compressImage'
import { encryptPdf } from './unlockPdf'

const buffersOf = (result: ExportResult | Uint8Array | PreflightReport): ArrayBuffer[] => {
  if ('assessments' in result) return []
  const views = result instanceof Uint8Array ? [result] : [result.original, result.compression?.bytes, result.optimization?.bytes]
  const buffers = new Set(views.flatMap(view => (view ? [view.buffer as ArrayBuffer] : [])))
  return [...buffers]
}

export async function executeJob(job: ExportJob, post: (message: ExportJobMessage, transfer?: ArrayBuffer[]) => void): Promise<void> {
  const { jobId } = job
  try {
    const result = job.kind === 'encrypt'
      ? await encryptPdf(job.bytes, job.password)
      : job.kind === 'preflight'
        ? await preflightExport(job.input)
        : job.kind === 'extract'
          ? await extractPages(job.document, job.ids)
          : await runExport(job.request, encodeCompressedImage, { onProgress: progress => post({ jobId, type: 'progress', progress }) })
    post({ jobId, type: 'done', result }, buffersOf(result))
  } catch (problem) {
    post({ jobId, type: 'error', message: problem instanceof Error && problem.message ? problem.message : 'Der Export ist fehlgeschlagen. Es wurde keine Datei gespeichert.' })
  }
}
