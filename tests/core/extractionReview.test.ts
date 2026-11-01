import { expect, test } from 'vitest'
import { reviewExtraction, type Assessment, type PreflightReport, type TextIssue } from '../../src/core/pdf/preflight'

const item = (decision: Assessment['decision'], message: string) => ({ decision, message }) as Assessment
const report = (assessments: Assessment[], textIssues: TextIssue[] = []): PreflightReport => ({ rebuilt: false, assessments, textIssues, xmpDropped: false })

test('a refusal wins over everything to confirm', () => {
  expect(reviewExtraction(report([item('confirm', 'A'), item('reject', 'B')]))).toEqual({ rejected: 'B', confirm: [] })
})

test('confirmations come with a note about characters that cannot be shown', () => {
  const issue = { overlayId: 't' } as TextIssue
  const { confirm, rejected } = reviewExtraction(report([item('confirm', 'A')], [issue]))
  expect(rejected).toBeUndefined()
  expect(confirm).toEqual(['A', expect.stringContaining('Nicht darstellbare Zeichen')])
})

test('a clean report needs no confirmation', () => {
  expect(reviewExtraction(report([]))).toEqual({ confirm: [] })
})

test('a failed check is never silently passed', () => {
  expect(reviewExtraction(null).confirm).toHaveLength(1)
})
