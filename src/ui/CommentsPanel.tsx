import { removeOverlay } from '../core/commands'
import { commentExcerpt } from '../core/comments'
import type { EditorStore } from '../core/editorStore'
import type { CommentOverlay } from '../core/model'

interface Props {
  comments: CommentOverlay[]
  /** Page number (1-based) of each comment's page. */
  pageNumber: (comment: CommentOverlay) => number
  selectedId: string | null
  store: EditorStore
  onJump: (comment: CommentOverlay) => void
  onClose: () => void
}

/** All comments of the document in reading order, at the edge of the workspace. */
export function CommentsPanel({ comments, pageNumber, selectedId, store, onJump, onClose }: Props) {
  return (
    <aside className="comments-panel" aria-label="Kommentare">
      <header>
        <h2>Kommentare ({comments.length})</h2>
        <button type="button" aria-label="Kommentarliste schließen" onClick={onClose}>✕</button>
      </header>
      {comments.length === 0
        ? <p className="hint">Noch keine Kommentare. Mit „💬 Kommentar“ auf eine Stelle im Dokument klicken.</p>
        : (
          <ol>
            {comments.map((comment, index) => (
              <li key={comment.id}>
                <button
                  type="button"
                  className="comment-jump"
                  aria-current={comment.id === selectedId ? 'true' : undefined}
                  onClick={() => onJump(comment)}
                >
                  <small>#{index + 1} · Seite {pageNumber(comment)}</small>
                  {commentExcerpt(comment.note) || <em>Leere Notiz</em>}
                </button>
                <button
                  type="button"
                  aria-label={`Kommentar ${index + 1} löschen`}
                  title="Kommentar löschen (rückgängig mit Strg+Z)"
                  onClick={() => store.dispatch(removeOverlay(comment))}
                >
                  🗑
                </button>
              </li>
            ))}
          </ol>
        )}
    </aside>
  )
}
