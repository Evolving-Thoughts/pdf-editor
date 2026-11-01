import type { SourceRun } from './sourceTypes'

export interface DirectSelection {
  runId: string
  from: number
  to: number
  text: string
}

/** Only proved source runs, never PDF.js extraction alone, authorize edits.
 * Runs of a proved paragraph are edited through its block, not here.
 * Offsets are UTF-16 indices; the supported DE/EN source alphabet is BMP-only.
 */
export function directSelection(run: SourceRun | undefined, from = 0, to = run?.text.length): DirectSelection | null {
  if (!run?.selection || run.selection.groupId || to === undefined) return null
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= to || to > run.text.length) return null
  const text = run.text.slice(from, to)
  return text.trim() ? { runId: run.id, from, to, text } : null
}

/** Rebuild the proved source unit, changing only the selected substring. */
export function selectedReplacement(run: SourceRun, selection: DirectSelection, draft: string) {
  if (run.id !== selection.runId) throw new Error('Die Auswahl gehört nicht zu dieser Textstelle.')
  return run.text.slice(0, selection.from) + draft + run.text.slice(selection.to)
}
