import type { Redaction } from './redactions'
import type { FormValues } from './forms'
import type { DocumentPage, PageSource } from './pages'
// Central editor store: holds the document overlay state and the command
// stack (ADR-002). Framework-free; the UI subscribes and re-renders.
import { CommandStack, type Command } from './commands'
import { cloneOverlay, type EditorState, type Overlay } from './model'
import type { MetadataEdit } from './pdf/metadata'

export class EditorStore {
  readonly state: EditorState = { overlays: [] }
  private stack = new CommandStack(this.state)
  private listeners = new Set<() => void>()
  private version = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion = (): number => this.version

  get canUndo(): boolean {
    return this.stack.canUndo
  }

  get canRedo(): boolean {
    return this.stack.canRedo
  }

  dispatch(command: Command): void {
    this.stack.execute(command)
    this.notify()
  }

  undo(): void {
    if (this.stack.undo()) this.notify()
  }

  redo(): void {
    if (this.stack.redo()) this.notify()
  }

  /** Mutates state without recording history (transient gestures like live dragging). */
  preview(mutate: (state: EditorState) => void): void {
    mutate(this.state)
    this.notify()
  }

  /** Clears all overlays and history, e.g. when a new document is loaded. */
  reset(): void {
    this.state.redactionApplied = undefined
    this.state.redactions = undefined
    this.state.formValues = undefined
    this.state.overlays = []
    this.state.pages = undefined
    this.state.pageSources = undefined
    this.state.metadata = undefined
    this.stack = new CommandStack(this.state)
    this.notify()
  }

  /** Replaces overlays with a stored draft's state and clears history. */
  restore(overlays: Overlay[], pages?: DocumentPage[], sources?: PageSource[], formValues?: FormValues, redactions?: Redaction[], redactionApplied?: boolean, metadata?: MetadataEdit): void {
    this.state.redactionApplied = redactionApplied
    this.state.redactions = redactions ? structuredClone(redactions) : undefined
    this.state.formValues = formValues ? structuredClone(formValues) : undefined
    this.state.overlays = overlays.map(cloneOverlay)
    this.state.pages = pages ? structuredClone(pages) : undefined
    this.state.pageSources = sources ? [...sources] : undefined
    this.state.metadata = metadata ? structuredClone(metadata) : undefined
    this.stack = new CommandStack(this.state)
    this.notify()
  }

  private notify(): void {
    this.version += 1
    this.listeners.forEach((listener) => listener())
  }
}
