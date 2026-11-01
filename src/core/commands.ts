// Command stack for unlimited undo/redo (ADR-002).
// Every state change goes through a reversible Command; no direct mutations
// from the UI. A running gesture is only a preview in its view.
import type { EditorState, ImageOverlay, Overlay, Textbox } from './model'
import type { ShapeChanges } from './shapes'
import { cloneOverlay, isMarker, isStroke } from './model'

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

export function addOverlay(overlay: Overlay): Command {
  const snapshot = cloneOverlay(overlay)
  return {
    label: 'Add overlay',
    apply: (s) => {
      s.overlays.push(cloneOverlay(snapshot))
    },
    revert: (s) => {
      s.overlays = s.overlays.filter((o) => o.id !== snapshot.id)
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
    ...replaceOverlays(overlays, overlays.filter((overlay) => !isStroke(overlay) && !isMarker(overlay))),
    label: 'Clear drawing',
  }
}

export function removeOverlay(overlay: Overlay): Command {
  const snapshot = cloneOverlay(overlay)
  // Captured in apply: undo must restore the exact prior state, including
  // the overlay's position in the array (stacking/paint order, hit targets).
  let index = -1
  return {
    label: 'Remove overlay',
    apply: (s) => {
      index = s.overlays.findIndex((o) => o.id === snapshot.id)
      s.overlays = s.overlays.filter((o) => o.id !== snapshot.id)
    },
    revert: (s) => {
      const restored = cloneOverlay(snapshot)
      if (index >= 0 && index <= s.overlays.length) s.overlays.splice(index, 0, restored)
      else s.overlays.push(restored)
    },
  }
}

/** Source data is immutable; edits only change geometry and proportion locking. */
export type ImageChanges = Pick<ImageOverlay, 'x' | 'y' | 'width' | 'height' | 'lockAspectRatio' | 'rotation'>
type OverlayChanges = Partial<Textbox> | ImageChanges | ShapeChanges

export function updateOverlay(id: string, before: OverlayChanges, after: OverlayChanges): Command {
  const from = { ...before }, to = { ...after }
  const patch = (state: EditorState, changes: OverlayChanges) => {
    const overlay = state.overlays.find((o) => o.id === id)
    if (overlay) Object.assign(overlay, changes)
  }
  return { label: 'Edit overlay', apply: (s) => patch(s, to), revert: (s) => patch(s, from) }
}

/** Repeats within this gap merge into one undo step. */
const NUDGE_MERGE_MS = 1000

export type ImageKeyboardAction = 'move' | 'rotate' | 'resize:nw' | 'resize:ne' | 'resize:sw' | 'resize:se'
export type ShapeKeyboardAction = ImageKeyboardAction | 'endpoint:start' | 'endpoint:end'
interface NudgeData { id: string; action: ShapeKeyboardAction; before: OverlayChanges; after: OverlayChanges; time: number }

/** Keyboard edit: rapid repeats on one overlay and action form one undo step. */
export function nudgeOverlay(id: string, before: OverlayChanges, after: OverlayChanges, action: ShapeKeyboardAction = 'move'): Command {
  const own: NudgeData = { id, action, before: { ...before }, after: { ...after }, time: Date.now() }
  const command: Command & { nudge: NudgeData } = {
    ...updateOverlay(id, own.before, own.after),
    label: 'Keyboard edit overlay',
    nudge: own,
    merge(previous) {
      const prev = (previous as Command & { nudge?: NudgeData }).nudge
      if (!prev || prev.id !== id || prev.action !== action || own.time - prev.time > NUDGE_MERGE_MS) return null
      if (JSON.stringify(prev.after) !== JSON.stringify(own.before)) return null
      return nudgeOverlay(id, prev.before, own.after, action)
    },
  }
  return command
}
