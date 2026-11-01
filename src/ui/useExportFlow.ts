import { useCallback, useRef } from 'react'
import { checkExportAbort } from '../core/pdf/compressPdf'
import { encryptInWorker, exportInWorker, preflightInWorker } from '../core/pdf/exportJob'
import type { ExportProgress, ExportSize } from '../core/pdf/exportPipeline'
import { downloadPdf } from '../core/pdf/downloadPdf'
import type { DocumentSession } from '../core/documentSession'
import type { EditorStore } from '../core/editorStore'
import type { PreparedExport } from './ExportDialog'

/** The export dialog's three steps. Each runs in a worker and refuses an outdated state. */
export function useExportFlow(store: EditorStore, session: DocumentSession, pageBusy: boolean) {
  // The export must describe the same editing state as the check the user read.
  const checkedVersionRef = useRef<number | null>(null)

  const checkExport = useCallback(async (signal: AbortSignal) => {
    if (!session.draft || !store.state.pages?.length) throw new Error('Der Export ist gerade nicht verfügbar.')
    const version = store.getVersion()
    try {
      return await preflightInWorker(session.snapshot(), { signal })
    } finally {
      // A failed check is confirmed in the dialog, and that answer is about this state too.
      checkedVersionRef.current = version
    }
  }, [store, session])
  const prepareExport = useCallback(
    async (size: ExportSize, signal: AbortSignal, onProgress: (progress: ExportProgress) => void): Promise<PreparedExport> => {
      const draft = session.draft
      if (!draft || !store.state.pages?.length || pageBusy || session.running('exporting'))
        throw new Error('Der Export ist gerade nicht verfügbar.')
      const task = session.begin('exporting')
      try {
        checkExportAbort(signal)
        if (store.state.redactions?.length)
          throw new Error('Vorgemerkte Schwärzungen zuerst anwenden oder verwerfen; sie sind noch nicht sicher entfernt.')
        if (checkedVersionRef.current !== store.getVersion())
          throw new Error('Der Stand hat sich seit der Prüfung geändert. Bitte den Export neu öffnen.')
        const result = await exportInWorker({ ...session.snapshot(), size }, { signal, onProgress })
        checkExportAbort(signal)
        // An outdated result is thrown away, whatever changed in the meantime.
        if (!task.sameState())
          throw new Error('Das Dokument hat sich während des Exports geändert. Bitte erneut exportieren.')
        return { name: draft.name, ...result }
      } finally {
        task.finish()
      }
    }, [store, pageBusy, session],
  )
  const downloadExport = useCallback(async (bytes: Uint8Array, name: string, password: string | undefined, signal: AbortSignal) => {
    const task = session.begin('exporting')
    try {
      checkExportAbort(signal)
      const output = password === undefined ? bytes : await encryptInWorker(bytes, password, { signal })
      checkExportAbort(signal)
      downloadPdf(output, name)
    } finally {
      task.finish()
    }
  }, [session])

  return { checkExport, prepareExport, downloadExport }
}
