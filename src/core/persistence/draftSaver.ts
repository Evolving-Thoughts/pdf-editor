// Saving the open draft (framework-free, ADR-004). IndexedDB work runs strictly in turn,
// so delete-after-autosave and document switches stay deterministic even with a save in flight.
import { copyEditorState, type EditorState } from '../model'
import { saveDraft, type DraftRecord } from './drafts'

const SAVE_DELAY_MS = 500

interface OpenDraft { id: string; name: string; createdAt: number; bytes: ArrayBuffer }

export class DraftSaver {
  private db: IDBDatabase | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private open: () => Promise<IDBDatabase>
  private state: () => EditorState
  private draft: () => OpenDraft | null
  /** Rises with every pause: a save from before it no longer counts. */
  generation = 0

  constructor(open: () => Promise<IDBDatabase>, state: () => EditorState, draft: () => OpenDraft | null) {
    this.open = open
    this.state = state
    this.draft = draft
  }

  /** Runs after everything queued so far. A failure reaches only this caller. */
  queue<T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const queued = this.tail.then(async () => work(this.db ??= await this.open()))
    this.tail = queued.catch(() => undefined)
    return queued
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Saves still waiting for the current draft will not happen anymore. */
  pause() {
    this.generation += 1
    this.clearTimer()
  }

  /** Describes this moment, even if editing goes on while the write waits. Null when nothing was saved. */
  async save(): Promise<DraftRecord | null> {
    this.clearTimer()
    const draft = this.draft()
    if (!draft) return null
    const generation = this.generation, snapshot = copyEditorState(this.state())
    return this.queue(async db => {
      if (generation !== this.generation) return null
      return saveDraft(db, { id: draft.id, name: draft.name, createdAt: draft.createdAt, pdfBytes: draft.bytes, ...snapshot })
    })
  }

  /** Gestures like dragging or typing end up as one save. */
  saveSoon(save: () => void) {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      save()
    }, SAVE_DELAY_MS)
  }

  stop() {
    this.clearTimer()
  }
}
