// Table structure from text positions (T26). The result is a proposal: positions
// alone never prove which column a value belongs to, so a person reviews every table.
import { fragmentRange, type SearchFragment } from '../search'
import { asTextCell, classifyCell, type NumberLocale, type TableCell } from './values'

export const COLUMN_CROSSING = 'Ein Wort liegt über einer Spaltengrenze.'

export const TABLE_LIMITS = { words: 8000, rows: 400, columns: 30, cells: 12000, outputBytes: 10 * 1024 * 1024 }

export interface TableWord { text: string; left: number; right: number; top: number; bottom: number }
/** Displayed page points, top-left origin. */
export interface TableRegion { left: number; right: number; top: number; bottom: number }

export function wordsFromFragments(fragments: SearchFragment[]): TableWord[] {
  const words: TableWord[] = []
  for (const fragment of fragments) {
    const [start, end] = fragment.quad
    // Slanted or vertical text has no place in a row and column grid.
    if (Math.abs(end.y - start.y) > Math.abs(end.x - start.x) * 0.1) continue
    for (const match of fragment.text.matchAll(/\S+/g)) {
      const quad = fragmentRange(fragment, match.index, match.index + match[0].length)
      const xs = quad.map(point => point.x), ys = quad.map(point => point.y)
      words.push({ text: match[0], left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) })
    }
  }
  return words
}

export function wordsInRegion(words: TableWord[], region: TableRegion): TableWord[] {
  return words.filter(word => {
    const x = (word.left + word.right) / 2, y = (word.top + word.bottom) / 2
    return x >= region.left && x <= region.right && y >= region.top && y <= region.bottom
  })
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

export function groupRows(words: TableWord[]): TableWord[][] {
  const tolerance = median(words.map(word => word.bottom - word.top)) * 0.6, rows: { center: number; words: TableWord[] }[] = []
  const center = (word: TableWord) => (word.top + word.bottom) / 2
  for (const word of [...words].sort((a, b) => center(a) - center(b))) {
    const row = rows.at(-1)
    if (row && center(word) - row.center <= tolerance) {
      row.words.push(word)
      row.center += (center(word) - row.center) / row.words.length
    } else rows.push({ center: center(word), words: [word] })
  }
  return rows.map(row => row.words)
}

/** Places column lines in the vertical gaps that no word crosses. */
export function detectColumns(words: TableWord[]): number[] {
  const height = median(words.map(word => word.bottom - word.top)), minimumGap = Math.max(6, height * 0.7)
  const lines: number[] = []
  let reach = -Infinity
  for (const word of [...words].sort((a, b) => a.left - b.left)) {
    if (reach !== -Infinity && word.left - reach >= minimumGap) lines.push((word.left + reach) / 2)
    reach = Math.max(reach, word.right)
  }
  return lines
}

export interface ExtractedTable { rows: TableCell[][] }

export function buildTable(words: TableWord[], columnLines: number[], locale: NumberLocale): ExtractedTable {
  if (!words.length) throw new Error('In diesem Bereich liegt kein auswählbarer Text. Bei Scans zuerst die Texterkennung nutzen.')
  if (words.length > TABLE_LIMITS.words) throw new Error(`Der Bereich enthält ${words.length} Wörter. Möglich sind ${TABLE_LIMITS.words}. Bitte einen kleineren Bereich wählen.`)
  const lines = [...columnLines].sort((a, b) => a - b), columns = lines.length + 1
  const grouped = groupRows(words)
  if (columns > TABLE_LIMITS.columns) throw new Error(`Die Tabelle hätte ${columns} Spalten. Möglich sind ${TABLE_LIMITS.columns}.`)
  if (grouped.length > TABLE_LIMITS.rows) throw new Error(`Die Tabelle hätte ${grouped.length} Zeilen. Möglich sind ${TABLE_LIMITS.rows}.`)
  if (grouped.length * columns > TABLE_LIMITS.cells) throw new Error(`Die Tabelle hätte ${grouped.length * columns} Zellen. Möglich sind ${TABLE_LIMITS.cells}.`)
  const rows = grouped.map(row => {
    const cells: TableWord[][] = Array.from({ length: columns }, () => [])
    const crossing = new Set<number>()
    for (const word of row) {
      const center = (word.left + word.right) / 2
      const index = lines.filter(line => line <= center).length
      cells[index].push(word)
      if (lines.some(line => word.left < line - 1 && word.right > line + 1)) crossing.add(index)
    }
    return cells.map((cell, index): TableCell => {
      const classified = classifyCell(cell.sort((a, b) => a.left - b.left).map(word => word.text).join(' '), locale)
      return crossing.has(index) ? { ...classified, note: COLUMN_CROSSING } : classified
    })
  })
  return { rows }
}

/** A crossing word stays suspect until a person edits the cell itself. */
export const keepCrossing = (from: TableCell, cell: TableCell): TableCell =>
  from.note === COLUMN_CROSSING ? { ...cell, note: COLUMN_CROSSING } : cell

/** Another number format changes how cells read, never what they say. */
export const reclassifyRows = (rows: TableCell[][], locale: NumberLocale): TableCell[][] =>
  rows.map(row => row.map(cell => cell.chosenText ? cell : keepCrossing(cell, classifyCell(cell.text, locale))))

function joinCells(first: TableCell, second: TableCell, locale: NumberLocale): TableCell {
  const text = [first.text, second.text].filter(Boolean).join(' ')
  return keepCrossing(first, keepCrossing(second, first.chosenText || second.chosenText ? asTextCell(text) : classifyCell(text, locale)))
}

export const mergeRows = (rows: TableCell[][], index: number, locale: NumberLocale): TableCell[][] =>
  rows.flatMap((row, position) => {
    if (position === index + 1) return []
    if (position !== index || !rows[index + 1]) return [row]
    return [row.map((cell, column) => joinCells(cell, rows[index + 1][column], locale))]
  })
