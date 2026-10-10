// Command stack for unlimited undo/redo (ADR-002).
// Every state change goes through a reversible Command; no direct mutations
// from the UI except store.preview() for transient gestures.
import type { EditorState, Textbox } from './model'
import { patchOverlay } from './model'

export interface Command {
  readonly label: string
  apply(state: EditorState): void
  revert(state: EditorState): void
  /**
   * Optionally absorb the previous top-of-stack command (already applied)
   * into this one, returning the combined command. Used to coalesce rapid
   * repeats like arrow-key nudges into a single undo step.
   */
  merge?(previous: Command): Command | null
}

export class CommandStack {
  private readonly state: EditorState
  private done: Command[] = []
  private undone: Command[] = []

  constructor(state: EditorState) {
    this.state = state
  }

  get canUndo(): boolean {
    return this.done.length > 0
  }

  get canRedo(): boolean {
    return this.undone.length > 0
  }

  execute(command: Command): void {
    command.apply(this.state)
    const previous = this.done[this.done.length - 1]
    const merged = previous && command.merge ? command.merge(previous) : null
    if (merged) this.done[this.done.length - 1] = merged
    else this.done.push(command)
    this.undone = []
  }

  undo(): Command | null {
    const command = this.done.pop()
    if (!command) return null
    command.revert(this.state)
    this.undone.push(command)
    return command
  }

  redo(): Command | null {
    const command = this.undone.pop()
    if (!command) return null
    command.apply(this.state)
    this.done.push(command)
    return command
  }
}

export function addTextbox(box: Textbox): Command {
  const snapshot = { ...box }
  return {
    label: 'Add textbox',
    apply: (s) => {
      s.overlays.push({ ...snapshot })
    },
    revert: (s) => {
      s.overlays = s.overlays.filter((o) => o.id !== snapshot.id)
    },
  }
}

export function removeTextbox(box: Textbox): Command {
  const snapshot = { ...box }
  return {
    label: 'Remove textbox',
    apply: (s) => {
      s.overlays = s.overlays.filter((o) => o.id !== snapshot.id)
    },
    revert: (s) => {
      s.overlays.push({ ...snapshot })
    },
  }
}

export function updateTextbox(id: string, before: Partial<Textbox>, after: Partial<Textbox>): Command {
  return {
    label: 'Edit textbox',
    apply: (s) => patchOverlay(s, id, after),
    revert: (s) => patchOverlay(s, id, before),
  }
}

export function moveTextbox(
  id: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Command {
  return {
    label: 'Move textbox',
    apply: (s) => patchOverlay(s, id, to),
    revert: (s) => patchOverlay(s, id, from),
  }
}

/** Nudges within this gap merge into one undo step. */
const NUDGE_MERGE_MS = 1000

interface NudgeData {
  id: string
  from: { x: number; y: number }
  time: number
}

/** Small keyboard move; consecutive nudges on the same box merge for undo. */
export function nudgeTextbox(id: string, from: { x: number; y: number }, to: { x: number; y: number }): Command {
  const self: Command & { nudge?: NudgeData } = {
    label: 'Nudge textbox',
    nudge: { id, from, time: Date.now() },
    apply: (s) => patchOverlay(s, id, to),
    revert: (s) => patchOverlay(s, id, from),
    merge: (previous) => {
      const prev = (previous as { nudge?: NudgeData }).nudge
      const own = self.nudge
      if (!prev || !own || prev.id !== id) return null
      if (own.time - prev.time > NUDGE_MERGE_MS) return null
      return nudgeTextbox(id, prev.from, to)
    },
  }
  return self
}
