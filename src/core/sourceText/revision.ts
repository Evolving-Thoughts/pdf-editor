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
/** Several pages corrected together: one command, so one undo step. */
export function sourceRevisions(state: EditorState, revisions: readonly { pageId: string; bytes: ArrayBuffer }[]): Command {
  if (!revisions.length || new Set(revisions.map(r => r.pageId)).size !== revisions.length) throw new Error('Ungültige Originaltext-Korrektur.')
  for (const { pageId } of revisions) {
    const page = state.pages?.find(value => value.id === pageId)
    if (!page || state.redactions?.length || page.hasForms || page.hasXfa || page.redacted || state.overlays.some(overlay => overlay.pageId === pageId)) {
      throw new Error('Originaltext-Korrektur ist auf dieser Seite derzeit nicht sicher möglich. Overlays oder vorgemerkte Schwärzungen zuerst entfernen.')
    }
  }
  const beforePages = state.pages!, beforeSources = state.pageSources ?? []
  const sources = new Map(revisions.map(r => [r.pageId, { id: createId(), bytes: r.bytes.slice(0) } as PageSource]))
  const afterPages = beforePages.map(value => sources.has(value.id) ? { ...value, sourceId: sources.get(value.id)!.id, revisionOf: value.revisionOf ?? value.sourceId } : value)
  const afterSources = [...beforeSources, ...sources.values()]
  return { label: 'Originaltext korrigieren', apply(target) { target.pages = afterPages; target.pageSources = afterSources }, revert(target) { target.pages = beforePages; target.pageSources = beforeSources } }
}
