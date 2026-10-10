// Domain model for overlay elements. Pure data, no framework, no PDF libraries.

export type OverlayFont = 'helvetica' | 'times' | 'courier'

export interface Textbox {
  id: string
  /** 0-based page index. */
  pageIndex: number
  /** Position in PDF points, origin bottom-left; y is the text baseline. */
  x: number
  y: number
  text: string
  font: OverlayFont
  fontSize: number
}

export type Overlay = Textbox

export interface EditorState {
  overlays: Overlay[]
}

let counter = 0
export function createId(): string {
  counter += 1
  return `ov-${Date.now().toString(36)}-${counter}`
}

/** Mutates one overlay in place; used by commands and previews alike. */
export function patchOverlay(state: EditorState, id: string, changes: Partial<Textbox>): void {
  const box = state.overlays.find((o) => o.id === id)
  if (box) Object.assign(box, changes)
}
