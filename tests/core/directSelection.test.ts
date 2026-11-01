import { expect, test } from 'vitest'
import { directSelection, selectedReplacement } from '../../src/core/sourceText/directSelection'
import type { SourceRun } from '../../src/core/sourceText/sourceTypes'

const make = (id: string, text: string, groupId?: string): SourceRun => ({
  id, text, pageIndex: 0, fontName: 'Helvetica', fontSize: 12, x: 50, baseline: 700, width: 100,
  selection: { characters: [...text].map((_, i) => ({ offset: i * 5, width: 5 })), groupId },
})
const fragment = make('a', 'Grüße Welt')

test('a partial selection keeps the text around it', () => {
  const selection = directSelection(fragment, 6, 10)!
  expect(selection.text).toBe('Welt')
  expect(selectedReplacement(fragment, selection, 'Erde')).toBe('Grüße Erde')
})

test('without offsets the whole fragment is selected', () => {
  expect(directSelection(fragment)?.text).toBe(fragment.text)
})

test('invalid, backward, empty and whitespace ranges fail closed', () => {
  for (const [from, to] of [[-1, 2], [3, 2], [2, 2], [0, 100], [0, NaN], [.5, 3], [5, 6]]) expect(directSelection(fragment, from, to)).toBeNull()
})

test('unproved text and runs of a proved paragraph are not fragments', () => {
  expect(directSelection(undefined)).toBeNull()
  expect(directSelection({ ...fragment, selection: undefined })).toBeNull()
  expect(directSelection(make('b', 'Absatz', 'block'))).toBeNull()
})

test('a replacement is bound to the selected run', () => {
  expect(() => selectedReplacement(make('b', 'Anders'), directSelection(fragment)!, 'Oops')).toThrow()
})
