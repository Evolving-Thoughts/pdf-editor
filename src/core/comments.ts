// Comments: notes pinned to a page point. Framework-free; edits go through overlay commands (ADR-002).
import type { Bounds } from './images/geometry'
import { createId, isComment, type CommentOverlay, type EditorState, type Overlay, type StrokePoint } from './model'

/** Edge length of the pin in page points; its top-left corner is the comment point. */
export const COMMENT_PIN_SIZE = 20

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** Keeps the whole pin on the page. */
export function placeComment(point: StrokePoint, page: Bounds): StrokePoint {
  return {
    x: clamp(point.x, 0, Math.max(0, page.width - COMMENT_PIN_SIZE)),
    y: clamp(point.y, Math.min(page.height, COMMENT_PIN_SIZE), page.height),
  }
}

export function createComment(pageId: string, point: StrokePoint, page: Bounds, now = Date.now(), id = createId()): CommentOverlay {
  return { kind: 'comment', id, pageId, ...placeComment(point, page), note: '', createdAt: now }
}

export function moveComment(comment: StrokePoint, dx: number, dy: number, page: Bounds): StrokePoint {
  return placeComment({ x: comment.x + dx, y: comment.y + dy }, page)
}

/** Comments in reading order: by page, then top to bottom, then left to right. */
export function documentComments(state: Pick<EditorState, 'overlays' | 'pages'>): CommentOverlay[] {
  const order = new Map((state.pages ?? []).map((page, index) => [page.id, index]))
  return state.overlays.filter((overlay: Overlay): overlay is CommentOverlay => isComment(overlay) && order.has(overlay.pageId))
    .sort((a, b) => order.get(a.pageId)! - order.get(b.pageId)! || b.y - a.y || a.x - b.x)
}

/** First line, shortened for the list. */
export function commentExcerpt(note: string, length = 80): string {
  const line = note.trim().split('\n')[0] ?? ''
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}
