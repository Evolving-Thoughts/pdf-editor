import type { SimpleSourceRun } from './simplePdf'

export interface DirectSelection {
  runId: string
  from: number
  to: number
  text: string
  paragraphFrom?: number
  paragraphTo?: number
  requiresReflow: boolean
}

/** Only proved source runs, never PDF.js extraction alone, authorize edits.
 * Offsets are UTF-16 indices; the supported DE/EN source alphabet is BMP-only.
 */
export function directSelection(
  runs: readonly SimpleSourceRun[], firstId: string, from: number,
  lastId = firstId, to?: number,
): DirectSelection | null {
  const a = runs.findIndex(run => run.id === firstId), b = runs.findIndex(run => run.id === lastId)
  const first = runs[a], last = runs[b]
  if (!first?.selection || !last?.selection || a > b) return null
  to ??= last.text.length
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from > first.text.length || to > last.text.length || (a === b && from >= to)) return null
  const group = first.selection.groupId
  if (a !== b && (!group || group !== last.selection.groupId || runs.slice(a, b + 1).some(run => run.selection?.groupId !== group))) return null
  const members = group ? runs.filter(run => run.selection?.groupId === group) : []
  // Line-based paragraphs join their runs with a space; reconstructed source
  // blocks own every character (including spaces) and use no separator.
  const separator = first.paragraph?.separator ?? ' '
  const prefix = (id: string) => {
    let length = 0
    for (const run of members) { if (run.id === id) return length; length += run.text.length + separator.length }
    return -1
  }
  const paragraphFrom = members.length ? prefix(first.id) + from : undefined
  const paragraphTo = members.length ? prefix(last.id) + to : undefined
  // A truncated/filtered group must not silently become a complete paragraph.
  if (members.length && members.map(run => run.text).join(separator) !== first.paragraph?.text) return null
  const text = a === b ? first.text.slice(from, to) : first.paragraph!.text.slice(paragraphFrom, paragraphTo)
  if (!text.trim()) return null
  return { runId: first.id, from, to: a === b ? to : first.text.length, text, paragraphFrom, paragraphTo, requiresReflow: a !== b }
}

/** Rebuild the proved source unit, changing only the selected substring. */
export function selectedReplacement(run: SimpleSourceRun, selection: DirectSelection, draft: string, reflow: boolean) {
  if (run.id !== selection.runId || (!reflow && selection.requiresReflow)) throw new Error('Diese Auswahl benötigt einen bestätigten, unterstützten Absatzumbruch.')
  if (reflow) {
    if (!run.paragraph || selection.paragraphFrom === undefined || selection.paragraphTo === undefined) throw new Error('Die Auswahl ist keinem sicher unterstützten Absatz zugeordnet.')
    return run.paragraph.text.slice(0, selection.paragraphFrom) + draft + run.paragraph.text.slice(selection.paragraphTo)
  }
  return run.text.slice(0, selection.from) + draft + run.text.slice(selection.to)
}
