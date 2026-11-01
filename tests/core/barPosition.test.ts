import { expect, test } from 'vitest'
import { BAR_HOME, barKeyTarget, boundBar } from '../../src/core/barPosition'

const space = { width: 500, height: 400 }, bar = { width: 100, height: 50 }

test('the bar stays inside the workspace with a margin', () => {
  expect(boundBar({ x: -50, y: 900 }, space, bar)).toEqual({ x: 8, y: 342 })
  expect(boundBar({ x: 900, y: -5 }, space, bar)).toEqual({ x: 392, y: 8 })
  expect(boundBar({ x: 30, y: 40 }, space, bar)).toEqual({ x: 30, y: 40 })
})

test('in a space too small for it the grip stays reachable', () => {
  expect(boundBar({ x: 90, y: 90 }, { width: 50, height: 20 }, bar)).toEqual({ x: 8, y: 8 })
})

test('the grip keys move, jump home, and ignore everything else', () => {
  const from = { x: 100, y: 100 }
  expect(barKeyTarget({ key: 'ArrowRight', shiftKey: false }, from)).toEqual({ x: 110, y: 100 })
  expect(barKeyTarget({ key: 'ArrowUp', shiftKey: true }, from)).toEqual({ x: 100, y: 60 })
  expect(barKeyTarget({ key: 'Home', shiftKey: false }, from)).toBe(BAR_HOME)
  expect(barKeyTarget({ key: 'a', shiftKey: false }, from)).toBeNull()
})
