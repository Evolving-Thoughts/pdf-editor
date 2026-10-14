import { expect, test } from 'vitest'
import { selectPages } from '../../src/core/pageSelection'
const order = ['a', 'b', 'c', 'd', 'e']
test('preview click changes range anchor but preserves the checked selection', () => {
  expect(selectPages(order, ['a', 'e'], 'a', 'c')).toEqual({ ids: ['a', 'e'], anchor: 'c' })
})
test('Ctrl/Meta toggle individual pages and checkbox changes preserve other checks', () => {
  expect(selectPages(order, ['a'], 'a', 'd', { toggle: true })).toEqual({ ids: ['a', 'd'], anchor: 'd' })
  expect(selectPages(order, ['a', 'd'], 'd', 'a', { toggle: true })).toEqual({ ids: ['d'], anchor: 'a' })
  expect(selectPages(order, ['a', 'd'], 'd', 'c', { checked: true }).ids).toEqual(['a', 'c', 'd'])
})
test('Shift selects an inclusive range with stable anchor in either direction', () => {
  const first = selectPages(order, ['a'], 'b', 'e', { range: true })
  expect(first).toEqual({ ids: ['b', 'c', 'd', 'e'], anchor: 'b' })
  expect(selectPages(order, first.ids, first.anchor, 'a', { range: true })).toEqual({ ids: ['a', 'b'], anchor: 'b' })
  expect(selectPages(order, ['a'], 'd', 'b', { range: true }).ids).toEqual(['b', 'c', 'd'])
})
test('Ctrl+Shift adds a range and uses current document order after moving pages', () => {
  expect(selectPages(order, ['a'], 'd', 'b', { range: true, toggle: true }).ids).toEqual(['a', 'b', 'c', 'd'])
  expect(selectPages(['e','b','d','a','c'], ['e'], 'b', 'a', { range: true }).ids).toEqual(['b','d','a'])
})
test('a missing anchor starts a one-page range; obsolete selections are discarded', () => {
  expect(selectPages(order, ['missing','a'], 'removed', 'c', { range: true })).toEqual({ ids: ['c'], anchor: 'c' })
  expect(selectPages(order, ['a','missing'], 'a', 'missing', { toggle: true })).toEqual({ ids: ['a'], anchor: 'a' })
})
