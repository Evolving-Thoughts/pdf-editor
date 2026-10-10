// Command stack for unlimited undo/redo (ADR-002).
// Every state change goes through a reversible Command; no direct mutations
// from the UI except store.preview() for transient gestures.
import type { EditorState, Textbox } from './model'
import { patchOverlay } from './model'

export interface Command {
  readonly label: string
  apply(state: EditorState): void
  revert(state: EditorState): void
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
    this.done.push(command)
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
