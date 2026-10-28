/** Local undo/redo for unchecked inline paragraph drafts. Drafts live only in
 * the correction panel until a checked candidate is applied; this history lets
 * the toolbar and Ctrl+Z step through them before anything touches the PDF. */
export interface DraftRange { start: number; end: number; backward?: boolean }
export interface DraftState {
  /** Changed paragraphs only: block id → edited text. */
  drafts: Readonly<Record<string, string>>
  /** Paragraph with the caret, if any. */
  active: { id: string; range: DraftRange } | null
}
type Kind = 'insert' | 'delete' | 'other'
export interface DraftHistory {
  past: DraftState[]
  future: DraftState[]
  /** Last recorded edit; consecutive typing in one word is one step. */
  group?: { id: string; kind: Kind; at: number }
}
export const emptyHistory = (): DraftHistory => ({ past: [], future: [] })
export const COALESCE_MS = 1000
const HISTORY_LIMIT = 200

function kindOf(before: string, after: string): { kind: Kind; char?: string } {
  if (after.length === before.length + 1) {
    let i = 0
    while (i < before.length && before[i] === after[i]) i++
    if (before.slice(i) === after.slice(i + 1)) return { kind: 'insert', char: after[i] }
  }
  if (after.length === before.length - 1) {
    let i = 0
    while (i < after.length && before[i] === after[i]) i++
    if (before.slice(i + 1) === after.slice(i)) return { kind: 'delete' }
  }
  return { kind: 'other' }
}

/** Set a paragraph's text; an unchanged paragraph is no draft. */
export function withDraft(state: DraftState, id: string, text: string, original: string, range: DraftRange): DraftState {
  const drafts = { ...state.drafts }
  if (text === original) delete drafts[id]
  else drafts[id] = text
  return { drafts, active: { id, range } }
}

/** Record `before` as an undo step for an edit of paragraph `id`, unless the
 * edit continues the current typing group (same paragraph and kind, within
 * COALESCE_MS; a typed blank starts a new group). */
export function recordEdit(history: DraftHistory, before: DraftState, id: string, previous: string, next: string, now: number): DraftHistory {
  if (previous === next) return history
  const { kind, char } = kindOf(previous, next), g = history.group
  const continues = !!g && g.id === id && g.kind === kind && kind !== 'other' && now - g.at < COALESCE_MS && !(kind === 'insert' && char !== undefined && /\s/.test(char))
  const group = { id, kind, at: now }
  if (continues) return { ...history, future: [], group }
  return { past: [...history.past, before].slice(-HISTORY_LIMIT), future: [], group }
}
/** Record a non-typing change (e.g. discarding a paragraph) as its own step. */
export const recordStep = (history: DraftHistory, before: DraftState): DraftHistory =>
  ({ past: [...history.past, before].slice(-HISTORY_LIMIT), future: [], group: undefined })

export function undoDraft(history: DraftHistory, current: DraftState): { history: DraftHistory; state: DraftState } | null {
  const state = history.past.at(-1)
  if (!state) return null
  return { state, history: { past: history.past.slice(0, -1), future: [current, ...history.future], group: undefined } }
}
export function redoDraft(history: DraftHistory, current: DraftState): { history: DraftHistory; state: DraftState } | null {
  const state = history.future[0]
  if (!state) return null
  return { state, history: { past: [...history.past, current], future: history.future.slice(1), group: undefined } }
}
