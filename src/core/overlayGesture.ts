// Moving overlays by hand (framework-free, ADR-004): a pointer drag only counts while
// the scene it started in still holds, and arrow keys mean the same on every overlay.
import { nudgeOverlay, type Command } from './commands'
import { imageGeometry, moveImage, type Bounds } from './images/geometry'
import { isImage, isShape, isTextbox, type Overlay } from './model'
import { moveShape, shapeGeometry } from './shapes'

export interface GestureScene {
  zoom: number
  version: number
  tool: string
  /** The overlay can still be edited. It may only become so right after the gesture began. */
  active: boolean
}
export const sameScene = (start: GestureScene, now: GestureScene) =>
  now.active && start.zoom === now.zoom && start.version === now.version && start.tool === now.tool

export interface PointerSample {
  pointerId: number
  clientX: number
  clientY: number
  shiftKey: boolean
}
export interface GestureStep<Data> {
  data: Data
  /** Distance in page points since the start, y upwards. */
  dx: number
  dy: number
  sample: PointerSample
  scene: GestureScene
  valid: boolean
}

export class PointerGesture<Data> {
  private running: { start: PointerSample; scene: GestureScene; data: Data } | null = null

  /** Only one pointer at a time: a second one is refused. */
  begin(sample: PointerSample, scene: GestureScene, data: Data): boolean {
    if (this.running) return false
    this.running = { start: sample, scene, data }
    return true
  }

  /** Null when the pointer does not belong to this gesture. */
  step(sample: PointerSample, now: GestureScene): GestureStep<Data> | null {
    const running = this.running
    if (!running || running.start.pointerId !== sample.pointerId) return null
    const { start, scene, data } = running
    return {
      data, sample, scene,
      dx: (sample.clientX - start.clientX) / scene.zoom,
      dy: (start.clientY - sample.clientY) / scene.zoom,
      valid: sameScene(scene, now),
    }
  }

  cancel() {
    this.running = null
  }
}

/** Degrees of the pointer around a center, for rotation handles. */
export const pointerAngle = (center: { x: number; y: number }, sample: PointerSample) =>
  Math.atan2(sample.clientY - center.y, sample.clientX - center.x) * 180 / Math.PI

interface KeyPress { key: string; shiftKey: boolean }
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }

/** Page points for an arrow key, y upwards. Null for any other key. */
export function arrowStep({ key, shiftKey }: KeyPress) {
  const direction = ARROWS[key]
  if (!direction) return null
  const size = shiftKey ? 10 : 1
  return { dx: direction[0] * size, dy: direction[1] * size }
}

/** Degrees for an arrow key on a rotation handle. Null for any other key. */
export function arrowTurn({ key, shiftKey }: KeyPress) {
  if (!ARROWS[key]) return null
  return (key === 'ArrowLeft' || key === 'ArrowDown' ? -1 : 1) * (shiftKey ? 15 : 1)
}

const clamp = (value: number, high: number) => Math.max(0, Math.min(high, value))

/** The text can run past the page; its anchor stays on it. */
export function moveTextbox(box: { x: number; y: number }, dx: number, dy: number, page: Bounds) {
  return { x: clamp(box.x + dx, page.width), y: clamp(box.y + dy, page.height) }
}

/** The command for moving an overlay by keyboard. Null when it cannot move any further. */
export function nudgeCommand(overlay: Overlay, { dx, dy }: { dx: number; dy: number }, page: Bounds): Command | null {
  const moved = <T extends { x: number; y: number }>(before: T, next: T) =>
    next.x === before.x && next.y === before.y ? null : nudgeOverlay(overlay.id, before, next)
  if (isImage(overlay)) {
    const before = imageGeometry(overlay)
    return moved(before, moveImage(before, dx, dy, page))
  }
  if (isShape(overlay)) {
    const before = shapeGeometry(overlay)
    return moved(before, moveShape(before, dx, dy, page))
  }
  return isTextbox(overlay) ? moved({ x: overlay.x, y: overlay.y }, moveTextbox(overlay, dx, dy, page)) : null
}
