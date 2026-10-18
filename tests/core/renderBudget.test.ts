import { expect, test } from 'vitest'
import { MAX_RENDER_PIXELS, MAX_RENDER_SIDE, renderPlan, validatePageSize } from '../../src/core/pdf/renderBudget'

test('ordinary A4 rendering retains requested resolution and CSS geometry', () => {
  expect(renderPlan(595, 842, 1.5, 2)).toEqual({ scale: 3, cssWidth: 892.5, cssHeight: 1263 })
})

test('large zoom/HiDPI views stay within pixel and side budgets without moving overlays', () => {
  for (const [width, height] of [[595, 842], [842, 595], [32768, 1], [32768, 32768]]) {
    const zoom = width > 1000 ? 1 : 4
    const plan = renderPlan(width, height, zoom, 4)
    const rasterWidth = Math.max(1, Math.floor(width * plan.scale))
    const rasterHeight = Math.max(1, Math.floor(height * plan.scale))
    expect(rasterWidth).toBeLessThanOrEqual(MAX_RENDER_SIDE)
    expect(rasterHeight).toBeLessThanOrEqual(MAX_RENDER_SIDE)
    expect(rasterWidth * rasterHeight).toBeLessThanOrEqual(MAX_RENDER_PIXELS)
    expect(plan.cssWidth).toBe(width * zoom)
    expect(plan.cssHeight).toBe(height * zoom)
  }
})

test('rejects malicious UserUnit dimensions before canvas allocation', () => {
  expect(() => renderPlan(1_080_000, 1_080_000, 1, 1)).toThrow('Seitenabmessungen')
})

test('rejects invalid dimensions, zoom and pixel ratios', () => {
  for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
    expect(() => validatePageSize(invalid, 842)).toThrow()
    expect(() => validatePageSize(595, invalid)).toThrow()
    expect(() => renderPlan(595, 842, invalid, 1)).toThrow()
    expect(() => renderPlan(595, 842, 1, invalid)).toThrow()
  }
  expect(() => renderPlan(595, 842, Number.MAX_VALUE, 1)).toThrow()
})