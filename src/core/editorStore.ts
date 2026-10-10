// Central editor store: holds the document overlay state and the command
// stack (ADR-002). Framework-free; the UI subscribes and re-renders.
import { CommandStack, type Command } from './commands'
import type { EditorState } from './model'

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
    this.state.overlays = []
    this.stack = new CommandStack(this.state)
    this.notify()
  }

  private notify(): void {
    this.version += 1
    this.listeners.forEach((listener) => listener())
  }
}
