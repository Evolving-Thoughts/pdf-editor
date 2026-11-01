import { expect, test } from 'vitest'
import { emptyHistory, historyStep, recordEdit, recordStep, redoDraft, undoDraft, withDraft } from '../../src/core/sourceText/draftHistory'
import type { DraftHistory, DraftState } from '../../src/core/sourceText/draftHistory'

const original = { a: 'Hallo Welt', b: 'Zweiter Absatz' }
function type(state: DraftState, history: DraftHistory, id: 'a' | 'b', next: string, at: number) {
  const before = state.drafts[id] ?? original[id]
  return { history: recordEdit(history, state, id, before, next, at), state: withDraft(state, id, next, original[id], { start: next.length, end: next.length }) }
}

test('typing within a word is one step; a blank, a pause or another paragraph starts a new one', () => {
  let s: DraftState = { drafts: {}, active: null }, h = emptyHistory()
  for (const [text, at] of [['Hallo Welt!', 0], ['Hallo Welt!!', 100], ['Hallo Welt!! ', 200], ['Hallo Welt!! x', 300], ['Hallo Welt!! xy', 2000]] as const)
    ({ state: s, history: h } = type(s, h, 'a', text, at))
  expect(h.past).toHaveLength(3)
  ;({ state: s, history: h } = type(s, h, 'b', 'Zweiter Absatz.', 2100))
  expect(h.past).toHaveLength(4)
  expect(s.drafts).toEqual({ a: 'Hallo Welt!! xy', b: 'Zweiter Absatz.' })
  // Undo goes back paragraph by paragraph, group by group, to no drafts at all.
  const steps: Record<string, string>[] = []
  for (let r = undoDraft(h, s); r; r = undoDraft(h, s)) { h = r.history; s = r.state; steps.push({ ...s.drafts }) }
  expect(steps).toEqual([{ a: 'Hallo Welt!! xy' }, { a: 'Hallo Welt!! x' }, { a: 'Hallo Welt!!' }, {}])
  // Redo restores every step; a new edit clears the redo list.
  for (let r = redoDraft(h, s); r; r = redoDraft(h, s)) { h = r.history; s = r.state }
  expect(s.drafts).toEqual({ a: 'Hallo Welt!! xy', b: 'Zweiter Absatz.' })
  const u = undoDraft(h, s)!
  expect(type(u.state, u.history, 'a', 'Hallo', 9000).history.future).toHaveLength(0)
})

test('restoring the original text removes the draft; discarding is an undoable step', () => {
  let s: DraftState = { drafts: {}, active: null }, h = emptyHistory()
  ;({ state: s, history: h } = type(s, h, 'a', 'Hallo Welt?', 0))
  ;({ state: s, history: h } = type(s, h, 'a', 'Hallo Welt', 5000))
  expect(s.drafts).toEqual({})
  ;({ state: s, history: h } = type(s, h, 'b', 'Anders', 9000))
  h = recordStep(h, s); s = { drafts: {}, active: null }
  const r = undoDraft(h, s)!
  expect(r.state.drafts).toEqual({ b: 'Anders' })
  expect(r.state.active?.id).toBe('b')
})

test('drafts take a step first, and the document only when nothing unchecked is lost', () => {
  expect(historyStep(true, true, true)).toBe('draft')
  expect(historyStep(false, false, true)).toBe('document')
  expect(historyStep(false, true, true)).toBeNull()
  expect(historyStep(false, false, false)).toBeNull()
})
