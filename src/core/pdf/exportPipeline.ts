// Core module: the export steps in their fixed order, free of UI and of browser
// document APIs, so the same code runs in the export worker (T21).
import { compressPdf, checkExportAbort, type CompressionPreset, type CompressionResult, type ImageEncoder } from './compressPdf'
import { optimizePdfStructure, type OptimizationResult } from './optimizePdf'
import { applyMetadata, effectiveField, hasMetadataEdit, METADATA_FIELDS, readMetadata, type MetadataEdit } from './metadata'
import { exportPageDocument, keepsPageTree } from './pageOperations'
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
  metadata?: MetadataEdit
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

/** A rebuilt document starts empty, so its info is carried over. After a redaction
 * nothing is carried: that info may describe what was blacked out. */
async function finalMetadata(request: ExportRequest, output: Uint8Array, rebuilt: boolean): Promise<Uint8Array> {
  const edit = request.metadata
  if (!rebuilt && !hasMetadataEdit(edit)) return output
  const fields: MetadataEdit['fields'] = {}
  if (rebuilt && !request.secure) {
    const known = await readMetadata(request.original)
    for (const field of METADATA_FIELDS) {
      const text = effectiveField(known.fields[field])
      if (text) fields[field] = text
    }
  }
  const merged: MetadataEdit = { ...edit, fields: { ...fields, ...edit?.fields } }
  return hasMetadataEdit(merged) ? (await applyMetadata(output, merged)).bytes : output
}

/** Chosen pages as their own file. Info is not carried over, but a decision about it holds here too. */
export async function extractPages(request: Omit<ExportRequest, 'size'>, ids: readonly string[]): Promise<Uint8Array> {
  const bytes = await exportPageDocument(request.original, request.sources, request.pages, request.overlays, ids, request.formValues, request.secure)
  return hasMetadataEdit(request.metadata) ? (await applyMetadata(bytes, request.metadata!)).bytes : bytes
}

export async function runExport(
  request: ExportRequest,
  encodeImage: ImageEncoder,
  options: { signal?: AbortSignal; onProgress?: (progress: ExportProgress) => void } = {},
): Promise<ExportResult> {
  const { signal, onProgress } = options
  checkExportAbort(signal)
  onProgress?.({ stage: 'compose' })
  const keptTree = await keepsPageTree(request.original, request.pages, request.secure)
  const exported = await exportPageDocument(request.original, request.sources, request.pages, request.overlays, undefined, request.formValues, request.secure, keptTree)
  checkExportAbort(signal)
  const original = await finalMetadata(request, exported, !keptTree)
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
