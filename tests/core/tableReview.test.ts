import { expect, test } from 'vitest'
import type { TableWord } from '../../src/core/tables/extract'
import { changeLines, changeLocale, changePage, chooseRegion, deleteRow, editCell, mergeWithNext, restoreCorrections, setColumnType, startReview, wordsLoaded } from '../../src/core/tables/tableReview'

const word = (text: string, left: number, top: number): TableWord => ({ text, left, right: left + text.length * 6, top, bottom: top + 10 })
const words = [word('Name', 20, 20), word('Betrag', 200, 20), word('Miete', 20, 40), word('1.234,50', 200, 40), word('Strom', 20, 60), word('80,00', 200, 60)]
const region = { left: 0, right: 300, top: 0, bottom: 100 }
const table = () => chooseRegion(startReview(0), words, region)

test('a chosen region gets detected columns and a fresh, unconfirmed table', () => {
  const state = table()
  expect(state.rows).toHaveLength(3)
  expect(state.lines).toHaveLength(1)
  expect(state.reviewed).toBe(false)
})

test('a region drawn before the words arrive is built when they do', () => {
  const early = chooseRegion(startReview(0), null, region)
  expect(early.rows).toEqual([])
  expect(wordsLoaded(early, words).rows).toHaveLength(3)
})

test('words arriving later leave a finished table alone', () => {
  const state = editCell(table(), 0, 0, 'Posten')
  expect(wordsLoaded(state, [])).toBe(state)
})

test('every correction withdraws the confirmation', () => {
  const confirmed = { ...table(), reviewed: true }
  for (const next of [editCell(confirmed, 0, 0, 'x'), setColumnType(confirmed, 1, 'text'), deleteRow(confirmed, 0), mergeWithNext(confirmed, 0), changeLocale(confirmed, 'en'), changeLines(confirmed, words, [150]), changePage(confirmed, 1)])
    expect(next.reviewed).toBe(false)
})

test('a rebuild keeps corrections restorable, with their columns', () => {
  const corrected = editCell(table(), 0, 0, 'Posten'), lines = corrected.lines
  const rebuilt = changeLines(corrected, words, [150])
  expect(rebuilt.rows[0][0].text).toBe('Name')
  expect(rebuilt.edited).toBe(false)
  const back = restoreCorrections(rebuilt)
  expect(back.rows[0][0].text).toBe('Posten')
  expect(back.lines).toEqual(lines)
  expect(back.edited).toBe(true)
  expect(back.replaced).toBeNull()
})

test('corrections survive a page change and bring their page back', () => {
  const moved = changePage(editCell(table(), 0, 0, 'Posten'), 3)
  expect(moved).toMatchObject({ pageIndex: 3, region: null, rows: [] })
  expect(restoreCorrections(moved)).toMatchObject({ pageIndex: 0, region })
})

test('restored numbers come back with the number format they were read in', () => {
  const moved = changeLocale(changePage(editCell(table(), 0, 0, 'Posten'), 1), 'en')
  expect(restoreCorrections(moved).locale).toBe('de')
})

test('an unedited table has nothing to restore', () => {
  const rebuilt = changeLines(table(), words, [150])
  expect(rebuilt.replaced).toBeNull()
  expect(restoreCorrections(rebuilt)).toBe(rebuilt)
})

test('a table beyond the limits is reported, not thrown', () => {
  const state = changeLines(table(), words, Array.from({ length: 40 }, (_, i) => 5 + i * 7))
  expect(state.rows).toEqual([])
  expect(state.problem).not.toBe('')
})
