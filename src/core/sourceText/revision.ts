import type { Command } from '../commands'
import type { EditorState } from '../model'
import { createId } from '../model'
import type { PageSource } from '../pages'

/** Replace one selected page's source revision. Other copies of that source page
 * remain unchanged. Keep geometry and all unrelated state; normal command order
 * handles subsequent overlays/page operations. No hidden change to original bytes. */
export function sourceRevision(state: EditorState, pageId: string, bytes: ArrayBuffer): Command {
  const page = state.pages?.find(value => value.id === pageId)
  if (!page || state.redactions?.length || page.hasForms || page.hasXfa || page.redacted || state.overlays.some(overlay => overlay.pageIndex === state.pages!.indexOf(page))) {
    throw new Error('Originaltext-Korrektur ist auf dieser Seite derzeit nicht sicher möglich. Overlays oder vorgemerkte Schwärzungen zuerst entfernen.')
  }
  const beforePages = state.pages!, beforeSources = state.pageSources ?? []
  const source: PageSource = { id: createId(), bytes: bytes.slice(0) }
  const afterPages = beforePages.map(value => value.id === pageId ? { ...value, sourceId: source.id } : value)
  const afterSources = [...beforeSources, source]
  return { label: 'Originaltext korrigieren', apply(target) { target.pages = afterPages; target.pageSources = afterSources }, revert(target) { target.pages = beforePages; target.pageSources = beforeSources } }
}
