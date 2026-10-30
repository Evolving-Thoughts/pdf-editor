// Core module: the export steps in their fixed order, free of UI and of browser
// document APIs, so the same code runs in the export worker (T21).
import { compressPdf, checkExportAbort, type CompressionPreset, type CompressionResult, type ImageEncoder } from './compressPdf'
import { optimizePdfStructure, type OptimizationResult } from './optimizePdf'
import { exportPageDocument } from './pageOperations'
import type { Overlay } from '../model'
import type { FormValues } from '../forms'
import type { DocumentPage, PageSource } from '../pages'

export type ExportSize = { mode: 'none' } | { mode: 'structure' } | { mode: 'images'; preset: CompressionPreset }

export interface ExportRequest {
  original: Uint8Array
  sources: PageSource[]
  pages: DocumentPage[]
  overlays: Overlay[]
  formValues?: FormValues
  secure: boolean
  size: ExportSize
}

export interface ExportResult {
  original: Uint8Array
  compression?: CompressionResult
  optimization?: OptimizationResult
}

export type ExportProgress =
  | { stage: 'compose' }
  | { stage: 'structure' }
  | { stage: 'images'; done: number; total: number }

export async function runExport(
  request: ExportRequest,
  encodeImage: ImageEncoder,
  options: { signal?: AbortSignal; onProgress?: (progress: ExportProgress) => void } = {},
): Promise<ExportResult> {
  const { signal, onProgress } = options
  checkExportAbort(signal)
  onProgress?.({ stage: 'compose' })
  const original = await exportPageDocument(request.original, request.sources, request.pages, request.overlays, undefined, request.formValues, request.secure)
  checkExportAbort(signal)
  if (request.size.mode === 'structure') {
    onProgress?.({ stage: 'structure' })
    return { original, optimization: await optimizePdfStructure(original, { signal }) }
  }
  if (request.size.mode === 'images') {
    const compression = await compressPdf(original, request.size.preset, encodeImage, {
      signal,
      onProgress: (done, total) => onProgress?.({ stage: 'images', done, total }),
    })
    return { original, compression }
  }
  return { original }
}
