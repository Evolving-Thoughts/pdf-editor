import { expect, test } from 'vitest'
import { largestVisiblePage, polygonCenter, scrollToPoint, visibleArea, visibleCenter, type Box } from '../../src/core/pageViewport'

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, right: left + width, bottom: top + height })
const view = box(0, 0, 100, 100)

test('only the part inside the view counts', () => {
  expect(visibleArea(box(50, 50, 100, 100), view)).toBe(2500)
  expect(visibleArea(box(200, 0, 10, 10), view)).toBe(0)
})

test('the largest visible page wins, and without one the fallback stands', () => {
  const pages = [{ index: 0, box: box(0, -90, 100, 100) }, { index: 1, box: box(0, 10, 100, 100) }]
  expect(largestVisiblePage(pages, view, 7)).toBe(1)
  expect(largestVisiblePage([{ index: 0, box: box(0, 500, 10, 10) }], view, 7)).toBe(7)
})

test('the center of the visible part is given in page points, y upwards', () => {
  expect(visibleCenter(box(0, -100, 400, 400), view, 2, 200)).toEqual({ x: 25, y: 125 })
})

test('a polygon has its center at the mean of its corners', () => {
  expect(polygonCenter([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }])).toEqual({ x: 2, y: 1 })
})

test('a point lands in the middle of the view', () => {
  expect(scrollToPoint({ x: 10, y: 20 }, box(0, 0, 100, 100), view, 2, { width: 100, height: 100 })).toEqual({ left: -30, top: -10 })
})

test('a panel over the view moves the point below it, one beside the center does not', () => {
  const client = { width: 100, height: 100 }
  expect(scrollToPoint({ x: 0, y: 0 }, view, view, 1, client, box(0, 0, 100, 42)).top).toBe(-75)
  expect(scrollToPoint({ x: 0, y: 0 }, view, view, 1, client, box(70, 0, 30, 42)).top).toBe(-50)
})
