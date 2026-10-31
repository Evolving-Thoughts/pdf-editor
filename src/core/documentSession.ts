// The open document's lifecycle (framework-free, ADR-004): which file is open, which
// long activity holds it, and whether a running activity still belongs to it.
import type { EditorStore } from './editorStore'
import { createId, type EditorState } from './model'
import type { DocumentPage } from './pages'
import { assertFileBudget } from './pdf/documentBudget'
import { previewDocument, snapshotDocument } from './pdf/documentOutput'
import type { PdfHandle } from './pdf/loadPdf'
import { inspectPages } from './pdf/pageOperations'
import { IncorrectPasswordError, PasswordRequiredError, preparePdf, unlockPdf } from './pdf/unlockPdf'
import type { DraftRecord } from './persistence/drafts'

export interface ActiveDraft {
  id: string
  name: string
  createdAt: number
  bytes: ArrayBuffer
}

/** Long work on the document. While any of it runs, the editor is locked. */
export type Activity = 'opening' | 'loadingDraft' | 'redacting' | 'exporting'

/** Answers whether the moment a watch was taken still holds. */
export interface Watch {
  /** No other document was opened or closed since. */
  sameDocument(): boolean
  /** The same document in the same editing state. */
  sameState(): boolean
}
export interface Task extends Watch { finish(): void }

interface Replacing {
  /** Saves the current document first. A failure ends the opening. */
  save(): Promise<unknown>
  /** Runs right before the new document takes over. */
  beforeReplace(): void
}
export interface FilePorts extends Replacing {
  askPassword(fileName: string, problem: string | null): Promise<string | null>
}
export interface DraftPorts extends Replacing { read(): Promise<DraftRecord | null> }

type LoadPdf = (name: string, bytes: Uint8Array) => Promise<PdfHandle>

export class DocumentSession {
  pdf: PdfHandle | null = null
  draft: ActiveDraft | null = null
  /** Stays while saving is suspended; only closing ends the document. */
  activeDraftId: string | null = null
  original: ArrayBuffer | null = null
  /** Page shown before switching to the page manager or the text correction: both
   * views open there, and the normal view returns to it. Never a reason to re-render. */
  viewedPage = 0
  private renderedPages: DocumentPage[] | undefined
  private activities = new Map<Activity, { draftId?: string }>()
  private epoch = 0
  private listeners = new Set<() => void>()
  private version = 0
  private store: EditorStore
  private load: LoadPdf

  constructor(store: EditorStore, load: LoadPdf) {
    this.store = store
    this.load = load
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion = (): number => this.version

  private changed() {
    this.version += 1
    this.listeners.forEach(listener => listener())
  }

  rememberPage(index: number) {
    this.viewedPage = index
  }

  get busy(): boolean { return this.activities.size > 0 }
  running(activity: Activity): boolean { return this.activities.has(activity) }
  get loadingDraftId(): string | null { return this.activities.get('loadingDraft')?.draftId ?? null }
  /** The viewer still shows an older page set. */
  get pagesStale(): boolean {
    const pages = this.store.state.pages
    return !!pages?.length && this.renderedPages !== pages
  }

  watch(): Watch {
    const { epoch, draft } = this, version = this.store.getVersion()
    const sameDocument = () => this.epoch === epoch
    return { sameDocument, sameState: () => sameDocument() && this.draft === draft && this.store.getVersion() === version }
  }

  /** Opening or loading replaces the document, so everything running before is outdated. */
  begin(activity: Activity, draftId?: string): Task {
    if (activity === 'opening' || activity === 'loadingDraft') this.epoch += 1
    const entry = { draftId }, watch = this.watch()
    this.activities.set(activity, entry)
    this.changed()
    return {
      ...watch,
      finish: () => {
        if (this.activities.get(activity) !== entry) return
        this.activities.delete(activity)
        this.changed()
      },
    }
  }

  /** Returns whether the file is now open. Throws only while the opening still counts. */
  async openFile(file: File, ports: FilePorts): Promise<boolean> {
    const task = this.begin('opening')
    try {
      // Do not discard the current document if its last save failed.
      await ports.save()
      assertFileBudget(file.size)
      const input = new Uint8Array(await file.arrayBuffer())
      if (!task.sameDocument()) return false
      const bytes = await this.unlocked(input, file.name, task, ports)
      if (!bytes || !task.sameDocument()) return false
      const buffer = bytes.slice().buffer as ArrayBuffer
      const pages = await inspectPages(bytes, file.name)
      const next = await this.load(file.name, bytes)
      if (!task.sameDocument()) {
        void next.destroy()
        return false
      }
      ports.beforeReplace()
      this.replace(next, { id: createId(), name: file.name, createdAt: Date.now(), bytes: buffer }, { overlays: [], pages })
      return true
    } catch (problem) {
      if (task.sameDocument()) throw problem
      return false
    } finally {
      task.finish()
    }
  }

  private async unlocked(input: Uint8Array, name: string, task: Task, ports: FilePorts) {
    try {
      return await preparePdf(input)
    } catch (problem) {
      if (!(problem instanceof PasswordRequiredError)) throw problem
    }
    let message: string | null = null
    for (;;) {
      if (!task.sameDocument()) return null
      const password = await ports.askPassword(name, message)
      if (password === null || !task.sameDocument()) return null
      try {
        return await unlockPdf(input, password)
      } catch (error) {
        if (!(error instanceof IncorrectPasswordError)) throw error
        message = error.message
      }
    }
  }

  /** 'outdated' means another document took over meanwhile. */
  async openDraft(id: string, ports: DraftPorts): Promise<'opened' | 'missing' | 'outdated'> {
    const task = this.begin('loadingDraft', id)
    try {
      await ports.save()
      const record = await ports.read()
      if (!task.sameDocument()) return 'outdated'
      if (!record) return 'missing'
      const bytes = record.pdfBytes.slice(0)
      const pages = record.pages ?? await inspectPages(new Uint8Array(bytes), record.name)
      const state = { ...record, pages, pageSources: record.pageSources ?? [] }
      const base = pages.length ? await previewDocument({ original: new Uint8Array(bytes), state }) : new Uint8Array(bytes)
      const next = await this.load(record.name, base)
      if (!task.sameDocument()) {
        void next.destroy()
        return 'outdated'
      }
      ports.beforeReplace()
      this.replace(next, { id: record.id, name: record.name, createdAt: record.createdAt, bytes }, state)
      return 'opened'
    } catch (problem) {
      if (task.sameDocument()) throw problem
      return 'outdated'
    } finally {
      task.finish()
    }
  }

  private replace(next: PdfHandle, draft: ActiveDraft, state: EditorState) {
    this.epoch += 1
    const previous = this.pdf
    this.pdf = next
    this.draft = draft
    this.activeDraftId = draft.id
    this.original = draft.bytes
    this.store.restore(state)
    this.renderedPages = this.store.state.pages
    void previous?.destroy()
    this.changed()
  }

  /** Rebuilds the viewer after a page change. Returns how to abandon that rebuild. */
  refreshPages(onProblem: (problem: unknown) => void): () => void {
    const pages = this.store.state.pages, draft = this.draft
    if (!pages || !draft || this.renderedPages === pages) return () => undefined
    if (!pages.length) {
      this.renderedPages = pages
      return () => undefined
    }
    let cancelled = false
    void previewDocument(snapshotDocument(new Uint8Array(draft.bytes), this.store.state)).then(bytes => this.load(draft.name, bytes)).then(next => {
      if (cancelled || this.draft !== draft) {
        void next.destroy()
        return
      }
      const old = this.pdf
      this.pdf = next
      this.renderedPages = pages
      void old?.destroy()
      this.changed()
    }).catch(problem => {
      if (!cancelled) onProblem(problem)
    })
    return () => {
      cancelled = true
    }
  }

  /** Takes the draft away from saving while it is being deleted; the view stays. */
  suspend(): ActiveDraft | null {
    const draft = this.draft
    this.epoch += 1
    this.draft = null
    return draft
  }

  resume(draft: ActiveDraft) {
    this.draft = draft
  }

  close() {
    const previous = this.pdf
    this.pdf = null
    this.draft = null
    this.activeDraftId = null
    this.original = null
    this.renderedPages = undefined
    this.store.reset()
    void previous?.destroy()
    this.changed()
  }

  /** The app is going away: nothing running may publish, and the worker document is released. */
  dispose() {
    this.epoch += 1
    void this.pdf?.destroy()
  }
}
