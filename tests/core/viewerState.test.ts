import { expect, test } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM, zoomIn, zoomOut } from '../../src/core/viewerState'

test('Zoom wird auf die erlaubten Grenzen begrenzt', () => {
  expect(zoomOut(MIN_ZOOM)).toBe(MIN_ZOOM)
  expect(zoomIn(MAX_ZOOM)).toBe(MAX_ZOOM)
})

test('Zoom ändert sich in Schritten', () => {
  expect(zoomIn(1)).toBeCloseTo(1.25)
  expect(zoomOut(1)).toBeCloseTo(0.75)
})
