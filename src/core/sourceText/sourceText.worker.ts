import { inspectSimpleSourceText, previewSimpleSourceCorrection } from './simplePdf'
import { inspectPageSource, previewPageSource } from './mixedPdf'
import { previewPageSources } from './mixedBatch'
import type { SourceSelection } from './simplePdf'
interface Message { action: 'inspect' | 'preview'; bytes: ArrayBuffer; selection?: SourceSelection; replacement?: string; edits?: { selection: SourceSelection; replacement: string }[]; pageIndex?: number }
self.onmessage = async (event: MessageEvent<Message>) => {
  try {
    const { action, bytes, selection, replacement, edits, pageIndex } = event.data
    if (action === 'inspect') self.postMessage({ value: await (pageIndex === undefined ? inspectSimpleSourceText(new Uint8Array(bytes)) : inspectPageSource(new Uint8Array(bytes), pageIndex)) })
    else {
      let result: Uint8Array
      if (edits) {
        if (!Array.isArray(edits) || edits.some(e => !e?.selection || typeof e.replacement !== 'string')) throw new Error('Ungültiger Korrekturauftrag.')
        result = await previewPageSources(new Uint8Array(bytes), edits)
      } else {
        if (!selection || typeof replacement !== 'string') throw new Error('Ungültiger Korrekturauftrag.')
        result = await (selection.runId.startsWith('mixed:') ? previewPageSource(new Uint8Array(bytes), selection, replacement) : previewSimpleSourceCorrection(new Uint8Array(bytes), selection, replacement))
      }
      const out = result.buffer.byteLength === result.byteLength ? result.buffer as ArrayBuffer : result.slice().buffer
      self.postMessage({ value: out }, { transfer: [out] })
    }
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Die Textkorrektur ist fehlgeschlagen.' }) }
}
