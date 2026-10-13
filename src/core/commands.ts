// Command stack for unlimited undo/redo (ADR-002).
// Every state change goes through a reversible Command; no direct mutations
// from the UI except store.preview() for transient gestures.
import type { EditorState, ImageOverlay, Overlay, Stroke, Textbox } from './model'
import { cloneOverlay, isImage, isStroke, patchOverlay } from './model'

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

export function addStroke(stroke: Stroke): Command {
  const snapshot = cloneOverlay(stroke) as Stroke
  return {
    label: 'Add stroke',
    apply: (s) => {
      s.overlays.push(cloneOverlay(snapshot))
    },
    revert: (s) => {
      s.overlays = s.overlays.filter((overlay) => overlay.id !== snapshot.id)
    },
  }
}

/** Replaces the overlay order atomically, e.g. for one completed eraser gesture. */
export function replaceOverlays(before: Overlay[], after: Overlay[]): Command {
  const beforeSnapshot = before.map(cloneOverlay)
  const afterSnapshot = after.map(cloneOverlay)
  return {
    label: 'Erase stroke parts',
    apply: (s) => {
      s.overlays = afterSnapshot.map(cloneOverlay)
    },
    revert: (s) => {
      s.overlays = beforeSnapshot.map(cloneOverlay)
    },
  }
}

/** Removes only this document's freehand drawing as one undo step. */
export function clearDrawing(overlays: Overlay[]): Command {
  return {
    ...replaceOverlays(overlays, overlays.filter((overlay) => !isStroke(overlay))),
    label: 'Clear drawing',
  }
}

export function removeTextbox(box: Textbox): Command {
  const snapshot = { ...box }
  // Captured in apply: undo must restore the exact prior state, including
  // the overlay's position in the array (stacking/paint order, hit targets).
  let index = -1
  return {
    label: 'Remove textbox',
    apply: (s) => {
      index = s.overlays.findIndex((o) => o.id === snapshot.id)
      s.overlays = s.overlays.filter((o) => o.id !== snapshot.id)
    },
    revert: (s) => {
      const restored = { ...snapshot }
      if (index >= 0 && index <= s.overlays.length) s.overlays.splice(index, 0, restored)
      else s.overlays.push(restored)
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

/** Source data is immutable; edits only change geometry and proportion locking. */
export type ImageChanges = Pick<ImageOverlay, 'x' | 'y' | 'width' | 'height' | 'lockAspectRatio' | 'rotation'>

export function addImage(image: ImageOverlay): Command {
  const snapshot = { ...image }
  return {
    label: 'Add image',
    apply: (s) => { s.overlays.push({ ...snapshot }) },
    revert: (s) => { s.overlays = s.overlays.filter((o) => o.id !== snapshot.id) },
  }
}

export function removeImage(image: ImageOverlay): Command {
  const snapshot = { ...image }
  let index = -1
  return {
    label: 'Remove image',
    apply: (s) => {
      index = s.overlays.findIndex((o) => o.id === snapshot.id)
      s.overlays = s.overlays.filter((o) => o.id !== snapshot.id)
    },
    revert: (s) => { s.overlays.splice(Math.max(0, index), 0, { ...snapshot }) },
  }
}

export function updateImage(id: string, before: ImageChanges, after: ImageChanges): Command {
  const from = { ...before }
  const to = { ...after }
  const patch = (state: EditorState, changes: ImageChanges) => {
    const image = state.overlays.find((o) => o.id === id)
    if (image && isImage(image)) Object.assign(image, changes)
  }
  return { label: 'Edit image', apply: (s) => patch(s, to), revert: (s) => patch(s, from) }
}

export type ImageKeyboardAction = 'move' | 'rotate' | 'resize:nw' | 'resize:ne' | 'resize:sw' | 'resize:se'
interface ImageNudgeData {
  id: string
  action: ImageKeyboardAction
  before: ImageChanges
  after: ImageChanges
  time: number
}

/** Like textbox nudges: rapid repeats on one image/action form one undo step. */
export function nudgeImage(id: string, before: ImageChanges, after: ImageChanges, action: ImageKeyboardAction = 'move'): Command {
  const own: ImageNudgeData = { id, action, before: { ...before }, after: { ...after }, time: Date.now() }
  const command: Command & { imageNudge: ImageNudgeData } = {
    ...updateImage(id, own.before, own.after),
    label: 'Keyboard edit image',
    imageNudge: own,
    merge(previous) {
      const prev = (previous as Command & { imageNudge?: ImageNudgeData }).imageNudge
      if (!prev || prev.id !== id || prev.action !== action || own.time - prev.time > NUDGE_MERGE_MS) return null
      if (JSON.stringify(prev.after) !== JSON.stringify(own.before)) return null
      return nudgeImage(id, prev.before, own.after, action)
    },
  }
  return command
}
