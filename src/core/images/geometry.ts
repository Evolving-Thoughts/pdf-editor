import type { ImageOverlay } from '../model'
import type { ImageChanges } from '../commands'

export interface Bounds { width: number; height: number }
export type Corner = 'nw' | 'ne' | 'sw' | 'se'
const MIN_SIZE = 4
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
export const ptsToMm = (pts: number) => pts * 25.4 / 72
export const mmToPts = (mm: number) => mm * 72 / 25.4

export function imageGeometry(image: ImageOverlay): ImageChanges {
  const { x, y, width, height, lockAspectRatio, rotation } = image
  return { x, y, width, height, lockAspectRatio, rotation }
}

export function moveImage(image: ImageChanges, dx: number, dy: number, page: Bounds): ImageChanges {
  if (normalizeAngle(image.rotation ?? 0) !== 0) return fitRotatedImage({ ...image, x: image.x + dx, y: image.y + dy }, page)
  return { ...image, x: clamp(image.x + dx, 0, page.width - image.width),
    y: clamp(image.y + dy, 0, page.height - image.height) }
}

/** The opposite corner stays fixed. Crossing it stops at the minimum size. */
export function resizeImage(image: ImageChanges, corner: Corner, dx: number, dy: number, page: Bounds): ImageChanges {
  if (normalizeAngle(image.rotation ?? 0) !== 0) return resizeRotatedImage(image, corner, dx, dy, page)
  const east = corner.endsWith('e')
  const north = corner.startsWith('n')
  const anchorX = east ? image.x : image.x + image.width
  const anchorY = north ? image.y : image.y + image.height
  const maxWidth = east ? page.width - anchorX : anchorX
  const maxHeight = north ? page.height - anchorY : anchorY
  let width = clamp(image.width + (east ? dx : -dx), Math.min(MIN_SIZE, maxWidth), maxWidth)
  let height = clamp(image.height + (north ? dy : -dy), Math.min(MIN_SIZE, maxHeight), maxHeight)
  if (image.lockAspectRatio) {
    const ratio = image.width / image.height
    const useWidth = Math.abs(dx / image.width) >= Math.abs(dy / image.height)
    width = useWidth ? width : height * ratio
    width = clamp(width, Math.min(Math.max(MIN_SIZE, MIN_SIZE * ratio), maxWidth, maxHeight * ratio),
      Math.min(maxWidth, maxHeight * ratio))
    height = width / ratio
  }
  return { ...image, width, height, x: east ? anchorX : anchorX - width, y: north ? anchorY : anchorY - height }
}

export function setImageSize(image: ImageChanges, dimension: 'width' | 'height', value: number, page: Bounds): ImageChanges {
  if (!Number.isFinite(value) || value <= 0) return image
  // Numeric size keeps the bottom-left corner fixed, just as PDF rectangles do.
  const delta = value - image[dimension]
  const localDx = dimension === 'width' ? delta : image.lockAspectRatio ? delta * image.width / image.height : 0
  const localDy = dimension === 'height' ? delta : image.lockAspectRatio ? delta * image.height / image.width : 0
  const { cos, sin } = imageAxes(image)
  return resizeImage(image, 'ne', cos * localDx + sin * localDy,
    -sin * localDx + cos * localDy, page)
}

export function initialImageGeometry(pixelWidth: number, pixelHeight: number, page: Bounds,
  center: { x: number; y: number }): ImageChanges {
  const ratio = pixelWidth / pixelHeight
  const width = Math.min(275, page.width * .8, page.height * .6 * ratio)
  const height = width / ratio
  return { x: clamp(center.x - width / 2, 0, page.width - width),
    y: clamp(center.y - height / 2, 0, page.height - height), width, height, lockAspectRatio: true }
}

/** Positive angles are clockwise on screen; all stored angles use [0, 360). */
export function normalizeAngle(angle: number): number {
  return Number.isFinite(angle) ? ((angle % 360) + 360) % 360 : 0
}

function imageAxes(image: ImageChanges) {
  const angle = normalizeAngle(image.rotation ?? 0) * Math.PI / 180
  return { cos: Math.cos(angle), sin: Math.sin(angle) }
}

export function imageBounds(image: ImageChanges) {
  const { cos, sin } = imageAxes(image)
  const width = Math.abs(cos) * image.width + Math.abs(sin) * image.height
  const height = Math.abs(sin) * image.width + Math.abs(cos) * image.height
  const left = image.x + image.width / 2 - width / 2
  const bottom = image.y + image.height / 2 - height / 2
  return { left, bottom, right: left + width, top: bottom + height, width, height }
}

/** Keep a rotated footprint on the page. Only oversize images shrink uniformly. */
function fitRotatedImage(image: ImageChanges, page: Bounds): ImageChanges {
  const footprint = imageBounds(image)
  const factor = Math.min(1, page.width / footprint.width, page.height / footprint.height)
  const width = image.width * factor
  const height = image.height * factor
  const centerX = clamp(image.x + image.width / 2, footprint.width * factor / 2, page.width - footprint.width * factor / 2)
  const centerY = clamp(image.y + image.height / 2, footprint.height * factor / 2, page.height - footprint.height * factor / 2)
  return { ...image, width, height, x: centerX - width / 2, y: centerY - height / 2 }
}

export function rotateImage(image: ImageChanges, angle: number, page: Bounds, snap = false): ImageChanges {
  if (!Number.isFinite(angle)) return image
  let rotation = normalizeAngle(angle)
  if (snap) rotation = normalizeAngle(Math.round(rotation / 15) * 15)
  if (rotation === normalizeAngle(image.rotation ?? 0)) return image
  return fitRotatedImage({ ...image, rotation }, page)
}

function resizeRotatedImage(image: ImageChanges, corner: Corner, dx: number, dy: number, page: Bounds): ImageChanges {
  const { cos, sin } = imageAxes(image)
  // Inverse of the clockwise screen rotation, using bottom-left/y-up points.
  const localDx = cos * dx - sin * dy
  const localDy = sin * dx + cos * dy
  const sx = corner.endsWith('e') ? 1 : -1
  const sy = corner.startsWith('n') ? 1 : -1
  let width = Math.max(MIN_SIZE, image.width + sx * localDx)
  let height = Math.max(MIN_SIZE, image.height + sy * localDy)
  if (image.lockAspectRatio) {
    // Project onto the corner's direction. Choosing a dominant local axis can
    // shrink a rotated image even when the pointer moves outward.
    const projected = 1 + (sx * image.width * localDx + sy * image.height * localDy)
      / (image.width * image.width + image.height * image.height)
    const factor = Math.max(MIN_SIZE / image.width, MIN_SIZE / image.height,
      projected)
    width = image.width * factor
    height = image.height * factor
  }
  // Fixed opposite corner in world coordinates; interpolation also preserves it.
  const anchorX = image.x + image.width / 2 - cos * sx * image.width / 2 - sin * sy * image.height / 2
  const anchorY = image.y + image.height / 2 + sin * sx * image.width / 2 - cos * sy * image.height / 2
  const candidate = (fraction: number): ImageChanges => {
    const w = image.width + (width - image.width) * fraction
    const h = image.height + (height - image.height) * fraction
    const centerX = anchorX + cos * sx * w / 2 + sin * sy * h / 2
    const centerY = anchorY - sin * sx * w / 2 + cos * sy * h / 2
    return { ...image, width: w, height: h, x: centerX - w / 2, y: centerY - h / 2 }
  }
  const inside = (rect: ImageChanges) => {
    const b = imageBounds(rect)
    return b.left >= -1e-9 && b.bottom >= -1e-9 && b.right <= page.width + 1e-9 && b.top <= page.height + 1e-9
  }
  const desired = candidate(1)
  if (inside(desired)) return desired
  // With a fixed angle the footprint is linear in width/height. Stop the gesture
  // at the first page edge instead of shifting the opposite anchor or clipping.
  let low = 0
  let high = 1
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2
    if (inside(candidate(middle))) low = middle
    else high = middle
  }
  return candidate(low)
}
