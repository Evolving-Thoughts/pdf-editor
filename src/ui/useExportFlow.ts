import { useCallback, useRef, useState, type RefObject } from 'react'
import { checkExportAbort } from '../core/pdf/compressPdf'
import { encryptInWorker, exportInWorker, preflightInWorker } from '../core/pdf/exportJob'
import type { ExportProgress, ExportSize } from '../core/pdf/exportPipeline'
import { downloadPdf } from '../core/pdf/downloadPdf'
import type { EditorStore } from '../core/editorStore'
import { cloneOverlay } from '../core/model'
import type { PreparedExport } from './ExportDialog'
import type { ActiveDraft } from './useDraftPersistence'

/** The export dialog's three steps. Each runs in a worker and refuses an outdated state. */
export function useExportFlow(store: EditorStore, draftRef: RefObject<ActiveDraft | null>, documentIntentRef: RefObject<number>, pageBusy: boolean) {
  const [exportBusy, setExportBusy] = useState(false)
  // The export must describe the same editing state as the check the user read.
  const checkedVersionRef = useRef<number | null>(null)
  const exportRunningRef = useRef(false)

  const checkExport = useCallback(async (signal: AbortSignal) => {
    const draft = draftRef.current
    if (!draft || !store.state.pages?.length) throw new Error('Der Export ist gerade nicht verfügbar.')
    const version = store.getVersion()
    try {
      return await preflightInWorker({
        original: new Uint8Array(draft.bytes), sources: store.state.pageSources ?? [], pages: store.state.pages,
        overlays: store.state.overlays.map(cloneOverlay),
        secure: !!store.state.redactionApplied || store.state.pages.some(page => page.redacted),
      }, { signal })
    } finally {
      // A failed check is confirmed in the dialog, and that answer is about this state too.
      checkedVersionRef.current = version
    }
  }, [store, draftRef])
  const prepareExport = useCallback(
    async (size: ExportSize, signal: AbortSignal, onProgress: (progress: ExportProgress) => void): Promise<PreparedExport> => {
      const draft = draftRef.current
      if (!draft || !store.state.pages?.length || pageBusy || exportRunningRef.current)
        throw new Error('Der Export ist gerade nicht verfügbar.')
      exportRunningRef.current = true
      setExportBusy(true)
      const version = store.getVersion(), intent = documentIntentRef.current
      try {
        checkExportAbort(signal)
        if (store.state.redactions?.length)
          throw new Error('Vorgemerkte Schwärzungen zuerst anwenden oder verwerfen; sie sind noch nicht sicher entfernt.')
        if (checkedVersionRef.current !== store.getVersion())
          throw new Error('Der Stand hat sich seit der Prüfung geändert. Bitte den Export neu öffnen.')
        const result = await exportInWorker({
          original: new Uint8Array(draft.bytes), sources: store.state.pageSources ?? [], pages: store.state.pages,
          overlays: store.state.overlays.map(cloneOverlay), formValues: store.state.formValues,
          secure: !!store.state.redactionApplied || store.state.pages.some(page => page.redacted), size,
          metadata: store.state.metadata,
        }, { signal, onProgress })
        checkExportAbort(signal)
        // An outdated result is thrown away, whatever changed in the meantime.
        if (draftRef.current !== draft || documentIntentRef.current !== intent || store.getVersion() !== version)
          throw new Error('Das Dokument hat sich während des Exports geändert. Bitte erneut exportieren.')
        return { name: draft.name, ...result }
      } finally {
        exportRunningRef.current = false
        setExportBusy(false)
      }
    }, [store, pageBusy, draftRef, documentIntentRef],
  )
  const downloadExport = useCallback(async (bytes: Uint8Array, name: string, password: string | undefined, signal: AbortSignal) => {
    exportRunningRef.current = true
    setExportBusy(true)
    try {
      checkExportAbort(signal)
      const output = password === undefined ? bytes : await encryptInWorker(bytes, password, { signal })
      checkExportAbort(signal)
      downloadPdf(output, name)
    } finally {
      exportRunningRef.current = false
      setExportBusy(false)
    }
  }, [])

  return { exportBusy, checkExport, prepareExport, downloadExport }
}
