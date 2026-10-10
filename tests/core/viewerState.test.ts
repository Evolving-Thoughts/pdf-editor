import { expect, test } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM, zoomIn, zoomOut } from '../../src/core/viewerState'

test('zoom is clamped to the allowed bounds', () => {
  expect(zoomOut(MIN_ZOOM)).toBe(MIN_ZOOM)
  expect(zoomIn(MAX_ZOOM)).toBe(MAX_ZOOM)
})

test('zoom changes in steps', () => {
  expect(zoomIn(1)).toBeCloseTo(1.25)
  expect(zoomOut(1)).toBeCloseTo(0.75)
})
