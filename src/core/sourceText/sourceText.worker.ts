import { inspectSimpleSourceText, previewSimpleSourceCorrection } from './simplePdf'
import type { SourceSelection } from './simplePdf'
self.onmessage = async (event: MessageEvent<{ action: 'inspect' | 'preview'; bytes: ArrayBuffer; selection?: SourceSelection; replacement?: string }>) => {
  try {
    const { action, bytes, selection, replacement } = event.data
    if (action === 'inspect') self.postMessage({ value: await inspectSimpleSourceText(new Uint8Array(bytes)) })
    else {
      if (!selection || typeof replacement !== 'string') throw new Error('Ungültiger Korrekturauftrag.')
      const result = await previewSimpleSourceCorrection(new Uint8Array(bytes), selection, replacement)
      self.postMessage({ value: result.buffer }, { transfer: [result.buffer] })
    }
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Die Textkorrektur ist fehlgeschlagen.' }) }
}
