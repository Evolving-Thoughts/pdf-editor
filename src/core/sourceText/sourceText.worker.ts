import { inspectSimpleSourceText, previewSimpleSourceCorrection } from './simplePdf'
import { inspectPageSource, previewPageSource } from './mixedPdf'
import type { SourceSelection } from './simplePdf'
self.onmessage = async (event: MessageEvent<{ action: 'inspect' | 'preview'; bytes: ArrayBuffer; selection?: SourceSelection; replacement?: string; pageIndex?: number }>) => {
  try {
    const { action, bytes, selection, replacement, pageIndex } = event.data
    if (action === 'inspect') self.postMessage({ value: await (pageIndex === undefined ? inspectSimpleSourceText(new Uint8Array(bytes)) : inspectPageSource(new Uint8Array(bytes), pageIndex)) })
    else {
      if (!selection || typeof replacement !== 'string') throw new Error('Ungültiger Korrekturauftrag.')
      const result = await (selection.runId.startsWith('mixed:') ? previewPageSource(new Uint8Array(bytes), selection, replacement) : previewSimpleSourceCorrection(new Uint8Array(bytes), selection, replacement))
      self.postMessage({ value: result.buffer }, { transfer: [result.buffer] })
    }
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Die Textkorrektur ist fehlgeschlagen.' }) }
}
