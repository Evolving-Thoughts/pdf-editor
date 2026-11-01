// Reviewing an extracted table (framework-free, ADR-004). Every change to region, columns or
// cells passes through here, so each one withdraws the confirmation and keeps corrections reachable.
import { buildTable, detectColumns, keepCrossing, mergeRows, reclassifyRows, wordsInRegion, type TableRegion, type TableWord } from './extract'
import { asNumberCell, asTextCell, classifyCell, type NumberLocale, type TableCell } from './values'

interface TableSnapshot { pageIndex: number; region: TableRegion | null; lines: number[]; rows: TableCell[][]; locale: NumberLocale }

export interface TableReview extends TableSnapshot {
  problem: string
  reviewed: boolean
  edited: boolean
  /** A rebuilt table starts over, so the corrections stay one click away. */
  replaced: TableSnapshot | null
}
/** Words of the current page, null until they are loaded. */
type Words = TableWord[] | null

export const startReview = (pageIndex: number, locale: NumberLocale = 'de'): TableReview =>
  ({ pageIndex, region: null, lines: [], rows: [], locale, problem: '', reviewed: false, edited: false, replaced: null })

const corrections = (state: TableReview): TableSnapshot | null => {
  if (!state.edited) return state.replaced
  const { pageIndex, region, lines, rows, locale } = state
  return { pageIndex, region, lines, rows, locale }
}

function rebuilt(state: TableReview, words: Words, region: TableRegion | null, lines: number[]): TableReview {
  // Without words there is nothing to rebuild, so a failed read stays on screen.
  const next = { ...state, region, lines, rows: [], problem: words ? '' : state.problem, reviewed: false, edited: false }
  if (!region || !words) return next
  try { return { ...next, rows: buildTable(wordsInRegion(words, region), lines, state.locale).rows } }
  catch (error) { return { ...next, problem: error instanceof Error ? error.message : 'Die Tabelle konnte nicht erzeugt werden.' } }
}

export function chooseRegion(state: TableReview, words: Words, region: TableRegion): TableReview {
  const lines = words ? detectColumns(wordsInRegion(words, region)) : []
  return { ...rebuilt(state, words, region, lines), replaced: corrections(state) }
}

export const changeLines = (state: TableReview, words: Words, lines: number[]): TableReview =>
  ({ ...rebuilt(state, words, state.region, lines), replaced: corrections(state) })

/** A region can be drawn before the page's words arrive. */
export const wordsLoaded = (state: TableReview, words: TableWord[]): TableReview =>
  state.region && !state.rows.length && !state.edited ? chooseRegion(state, words, state.region) : state

export const changePage = (state: TableReview, pageIndex: number): TableReview =>
  ({ ...startReview(pageIndex, state.locale), replaced: corrections(state) })

export const restoreCorrections = (state: TableReview): TableReview =>
  state.replaced ? { ...state, ...state.replaced, edited: true, reviewed: false, problem: '', replaced: null } : state

const corrected = (state: TableReview, rows: TableCell[][]): TableReview =>
  ({ ...state, rows, edited: true, replaced: null, reviewed: false })

export const editCell = (state: TableReview, rowIndex: number, columnIndex: number, text: string): TableReview =>
  corrected(state, state.rows.map((row, r) => r !== rowIndex ? row : row.map((cell, c) => c === columnIndex ? classifyCell(text, state.locale) : cell)))

export const setColumnType = (state: TableReview, columnIndex: number, type: 'number' | 'text'): TableReview =>
  corrected(state, state.rows.map(row => row.map((cell, c) => {
    if (c !== columnIndex || !cell.text) return cell
    return keepCrossing(cell, type === 'number' ? asNumberCell(cell, state.locale) : asTextCell(cell.text))
  })))

export const deleteRow = (state: TableReview, rowIndex: number): TableReview =>
  corrected(state, state.rows.filter((_, index) => index !== rowIndex))

export const mergeWithNext = (state: TableReview, rowIndex: number): TableReview =>
  corrected(state, mergeRows(state.rows, rowIndex, state.locale))

export const changeLocale = (state: TableReview, locale: NumberLocale): TableReview =>
  ({ ...state, locale, rows: reclassifyRows(state.rows, locale), reviewed: false })
