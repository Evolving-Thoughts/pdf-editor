import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocumentSession } from '../core/documentSession'
import type { EditorStore } from '../core/editorStore'
import { copyEditorState } from '../core/model'
import {
  listDrafts,
  openDraftDb,
  saveDraft,
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

/** Auto-save, manual save and the draft list. Owns the IndexedDB queue. */
export function useDraftPersistence(store: EditorStore, session: DocumentSession) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [draftsError, setDraftsError] = useState<string | null>(null)
  const [manualSave, setManualSave] = useState<ManualSave | null>(null)
  const manualSaveRequestRef = useRef<object | null>(null)
  const inputEpochRef = useRef(0)
  // Lazily opened IndexedDB handle.
  const dbRef = useRef<IDBDatabase | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const persistenceGenerationRef = useRef(0)

  const ensureDraftDb = useCallback(async () => {
    dbRef.current ??= await openDraftDb()
    return dbRef.current
  }, [])

  // IndexedDB operations are serialized. That keeps delete-after-autosave and
  // document switches deterministic even when a debounced save is in flight.
  const queuePersistence = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const queued = saveQueueRef.current.then(work)
    saveQueueRef.current = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }, [])

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
    persistenceGenerationRef.current += 1
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    setManualSave(null)
    manualSaveRequestRef.current = null
  }, [])

  const persistActiveDraft = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const draft = session.draft
    if (!draft) return null
    const generation = persistenceGenerationRef.current
    // Copy now: the record must describe this save point even if the user keeps
    // editing while the queued IndexedDB write is waiting.
    const snapshot = copyEditorState(store.state)
    const record = await queuePersistence(async () => {
      if (generation !== persistenceGenerationRef.current) return null
      const db = await ensureDraftDb()
      return saveDraft(db, {
        id: draft.id,
        name: draft.name,
        createdAt: draft.createdAt,
        pdfBytes: draft.bytes,
        ...snapshot,
      })
    })
    if (record) {
      rememberDraft(record)
      setDraftsError(null)
    }
    return record
  }, [ensureDraftDb, queuePersistence, rememberDraft, session, store])

  const onManualSave = useCallback(async () => {
    const draft = session.draft
    if (!draft || (manualSave?.draftId === draft.id && manualSave.status === 'saving')) return
    const request = {}
    manualSaveRequestRef.current = request
    const generation = persistenceGenerationRef.current
    const version = store.getVersion()
    const inputEpoch = inputEpochRef.current
    const stillCurrent = () => manualSaveRequestRef.current === request &&
      session.draft?.id === draft.id && persistenceGenerationRef.current === generation
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
  }, [manualSave, persistActiveDraft, reportDraftProblem, session, store])

  const refreshDrafts = useCallback(async () => {
    const list = await queuePersistence(async () => listDrafts(await ensureDraftDb()))
    setDrafts(list)
    setDraftsError(null)
  }, [ensureDraftDb, queuePersistence])

  useEffect(() => {
    let cancelled = false
    void queuePersistence(async () => listDrafts(await ensureDraftDb()))
      .then((list) => {
        if (!cancelled) setDrafts(list)
      })
      .catch((problem) => {
        if (!cancelled) reportDraftProblem(problem, 'Gespeicherte Entwürfe sind auf diesem Gerät nicht verfügbar.')
      })
    return () => {
      cancelled = true
    }
  }, [ensureDraftDb, queuePersistence, reportDraftProblem])

  const onDraftsMenuOpen = useCallback(() => {
    void (async () => {
      await persistActiveDraft()
      await refreshDrafts()
    })().catch((problem) => reportDraftProblem(problem, 'Die Entwurfsliste konnte nicht aktualisiert werden.'))
  }, [persistActiveDraft, refreshDrafts, reportDraftProblem])

  // Auto-save: every store change (edits, moves, deletes) persists the draft
  // to IndexedDB, debounced so gestures like dragging or typing coalesce.
  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      if (!session.draft) return
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        // Persistence must never break editing (e.g. private browsing).
        void persistActiveDraft().catch((problem) =>
          reportDraftProblem(problem, 'Der Entwurf konnte nicht gespeichert werden.'),
        )
      }, 500)
    })
    return () => {
      unsubscribe()
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [persistActiveDraft, reportDraftProblem, session, store])

  return {
    drafts, setDrafts, draftsError, setDraftsError, manualSave, setManualSave, inputEpochRef,
    pauseSaving, ensureDraftDb, queuePersistence, reportDraftProblem,
    persistActiveDraft, onManualSave, onDraftsMenuOpen,
  }
}
