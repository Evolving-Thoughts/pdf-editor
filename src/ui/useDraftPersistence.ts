import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentSession } from '../core/documentSession'
import type { EditorStore } from '../core/editorStore'
import { DraftSaver } from '../core/persistence/draftSaver'
import {
  listDrafts,
  openDraftDb,
  type DraftRecord,
  type DraftSummary,
} from '../core/persistence/drafts'

interface ManualSave {
  draftId: string
  version: number
  status: 'saving' | 'saved' | 'error'
}

function draftSummary(record: DraftRecord): DraftSummary {
  return {
    id: record.id,
    name: record.name,
    updatedAt: record.updatedAt,
    sizeBytes: record.pdfBytes.byteLength + (record.pageSources ?? []).filter(source => record.pages?.some(page => page.sourceId === source.id)).reduce((size, source) => size + source.bytes.byteLength, 0),
    overlayCount: record.overlays.length,
  }
}

/** Auto-save, manual save and the draft list for the view. */
export function useDraftPersistence(store: EditorStore, session: DocumentSession) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [draftsError, setDraftsError] = useState<string | null>(null)
  const [manualSave, setManualSave] = useState<ManualSave | null>(null)
  const manualSaveRequestRef = useRef<object | null>(null)
  const inputEpochRef = useRef(0)
  const [saver] = useState(() => new DraftSaver(openDraftDb, () => store.state, () => session.draft))

  const rememberDraft = useCallback((record: DraftRecord) => {
    const summary = draftSummary(record)
    setDrafts((current) =>
      [summary, ...current.filter((draft) => draft.id !== summary.id)].sort((a, b) => b.updatedAt - a.updatedAt),
    )
  }, [])

  const reportDraftProblem = useCallback((problem: unknown, message: string) => {
    console.warn(message, problem)
    setDraftsError(message)
  }, [])

  /** Saves still waiting for the current draft will not happen anymore. */
  const pauseSaving = useCallback(() => {
    saver.pause()
    setManualSave(null)
    manualSaveRequestRef.current = null
  }, [saver])

  const forgetDraft = useCallback((id: string) => {
    setDrafts((current) => current.filter((item) => item.id !== id))
    setDraftsError(null)
  }, [])

  /** Text typed but not yet in the store makes a saved state outdated. */
  const noteInput = useCallback(() => {
    inputEpochRef.current += 1
    setManualSave(current => current?.status === 'saved' ? null : current)
  }, [])

  const persistActiveDraft = useCallback(async () => {
    const record = await saver.save()
    if (record) {
      rememberDraft(record)
      setDraftsError(null)
    }
    return record
  }, [rememberDraft, saver])

  const onManualSave = useCallback(async () => {
    const draft = session.draft
    if (!draft || (manualSave?.draftId === draft.id && manualSave.status === 'saving')) return
    const request = {}
    manualSaveRequestRef.current = request
    const generation = saver.generation
    const version = store.getVersion()
    const inputEpoch = inputEpochRef.current
    const stillCurrent = () => manualSaveRequestRef.current === request &&
      session.draft?.id === draft.id && saver.generation === generation
    setManualSave({ draftId: draft.id, version, status: 'saving' })
    try {
      // A normal button click blurs the active textarea first, committing its
      // text before persistActiveDraft snapshots and queues this save point.
      const record = await persistActiveDraft()
      if (!stillCurrent()) return
      setManualSave(record && store.getVersion() === version && inputEpochRef.current === inputEpoch
        ? { draftId: draft.id, version, status: 'saved' } : null)
    } catch (problem) {
      if (!stillCurrent()) return
      reportDraftProblem(problem, 'Der Entwurf konnte nicht gespeichert werden. Bitte erneut versuchen.')
      setManualSave({ draftId: draft.id, version, status: 'error' })
    }
  }, [manualSave, persistActiveDraft, reportDraftProblem, saver, session, store])

  const refreshDrafts = useCallback(async () => {
    const list = await saver.queue(listDrafts)
    setDrafts(list)
    setDraftsError(null)
  }, [saver])

  useEffect(() => {
    let cancelled = false
    void saver.queue(listDrafts)
      .then((list) => {
        if (!cancelled) setDrafts(list)
      })
      .catch((problem) => {
        if (!cancelled) reportDraftProblem(problem, 'Gespeicherte Entwürfe sind auf diesem Gerät nicht verfügbar.')
      })
    return () => {
      cancelled = true
    }
  }, [reportDraftProblem, saver])

  const onDraftsMenuOpen = useCallback(() => {
    void (async () => {
      await persistActiveDraft()
      await refreshDrafts()
    })().catch((problem) => reportDraftProblem(problem, 'Die Entwurfsliste konnte nicht aktualisiert werden.'))
  }, [persistActiveDraft, refreshDrafts, reportDraftProblem])

  // Auto-save: every store change (edits, moves, deletes) persists the draft.
  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      if (!session.draft) return
      // Persistence must never break editing (e.g. private browsing).
      saver.saveSoon(() => void persistActiveDraft().catch((problem) =>
        reportDraftProblem(problem, 'Der Entwurf konnte nicht gespeichert werden.'),
      ))
    })
    return () => {
      unsubscribe()
      saver.stop()
    }
  }, [persistActiveDraft, reportDraftProblem, saver, session, store])

  return {
    drafts, draftsError, manualSave, saver, forgetDraft, noteInput,
    pauseSaving, reportDraftProblem, persistActiveDraft, onManualSave, onDraftsMenuOpen,
  }
}
