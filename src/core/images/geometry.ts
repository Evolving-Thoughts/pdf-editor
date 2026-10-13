import type { ImageOverlay } from '../model'
import type { ImageChanges } from '../commands'

export interface Bounds { width: number; height: number }
export type Corner = 'nw' | 'ne' | 'sw' | 'se'
const MIN_SIZE = 4
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
export const ptsToMm = (pts: number) => pts * 25.4 / 72
export const mmToPts = (mm: number) => mm * 72 / 25.4

export function imageGeometry(image: ImageOverlay): ImageChanges {
  const { x, y, width, height, lockAspectRatio } = image
  return { x, y, width, height, lockAspectRatio }
}

export function moveImage(image: ImageChanges, dx: number, dy: number, page: Bounds): ImageChanges {
  return { ...image, x: clamp(image.x + dx, 0, page.width - image.width),
    y: clamp(image.y + dy, 0, page.height - image.height) }
}

/** The opposite corner stays fixed. Crossing it stops at the minimum size. */
export function resizeImage(image: ImageChanges, corner: Corner, dx: number, dy: number, page: Bounds): ImageChanges {
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
  return resizeImage(image, 'ne', dimension === 'width' ? value - image.width : 0,
    dimension === 'height' ? value - image.height : 0, page)
}

export function initialImageGeometry(pixelWidth: number, pixelHeight: number, page: Bounds,
  center: { x: number; y: number }): ImageChanges {
  const ratio = pixelWidth / pixelHeight
  const width = Math.min(275, page.width * .8, page.height * .6 * ratio)
  const height = width / ratio
  return { x: clamp(center.x - width / 2, 0, page.width - width),
    y: clamp(center.y - height / 2, 0, page.height - height), width, height, lockAspectRatio: true }
}
