import type { Command } from '../commands'
import type { EditorState } from '../model'
import { createId } from '../model'
import type { PageSource } from '../pages'

/** Replace one selected page's source revision. Other copies of that source page
 * remain unchanged. Keep geometry and all unrelated state; normal command order
 * handles subsequent overlays/page operations. No hidden change to original bytes. */
export function sourceRevision(state: EditorState, pageId: string, bytes: ArrayBuffer): Command {
  return sourceRevisions(state, [{ pageId, bytes }])
}
/** Why this page's source text cannot be corrected right now. Null when it can. */
export function sourceTextBlocker(state: EditorState, pageId: string): string | null {
  const page = state.pages?.find(value => value.id === pageId)
  if (page?.hasForms || page?.hasXfa) return 'PDFs mit Formularfeldern können derzeit nicht im Originaltext korrigiert werden.'
  if (!page || page.cropped || page.rotation !== 0 || page.unit !== 1 || page.redacted || state.redactions?.length || state.overlays.some(overlay => overlay.pageId === pageId))
    return 'Diese Seite ist derzeit nicht unterstützt: Drehung, Zuschnitt, Schwärzungen oder Overlays verhindern eine sichere Originaltext-Korrektur.'
  return null
}

/** Several pages corrected together: one command, so one undo step. */
export function sourceRevisions(state: EditorState, revisions: readonly { pageId: string; bytes: ArrayBuffer }[]): Command {
  if (!revisions.length || new Set(revisions.map(r => r.pageId)).size !== revisions.length) throw new Error('Ungültige Originaltext-Korrektur.')
  for (const { pageId } of revisions) {
    const blocker = sourceTextBlocker(state, pageId)
    if (blocker) throw new Error(blocker)
  }
  const beforePages = state.pages!, beforeSources = state.pageSources ?? []
  const sources = new Map(revisions.map(r => [r.pageId, { id: createId(), bytes: r.bytes.slice(0) } as PageSource]))
  const afterPages = beforePages.map(value => sources.has(value.id) ? { ...value, sourceId: sources.get(value.id)!.id, revisionOf: value.revisionOf ?? value.sourceId } : value)
  const afterSources = [...beforeSources, ...sources.values()]
  return { label: 'Originaltext korrigieren', apply(target) { target.pages = afterPages; target.pageSources = afterSources }, revert(target) { target.pages = beforePages; target.pageSources = beforeSources } }
}
