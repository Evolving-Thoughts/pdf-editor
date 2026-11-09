import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { removeOverlay, updateOverlay } from '../core/commands'
import { COMMENT_PIN_SIZE, moveComment } from '../core/comments'
import type { EditorStore } from '../core/editorStore'
import type { Bounds } from '../core/images/geometry'
import type { CommentOverlay } from '../core/model'
import type { GestureStep } from '../core/overlayGesture'
import { FloatingBar } from './FloatingBar'
import type { Tool } from './tools'
import { useOverlayGesture } from './useOverlayGesture'

interface Props {
  comment: CommentOverlay
  /** 1-based number in reading order, shown on the pin and in the list. */
  number: number
  zoom: number
  pageSize: Bounds
  selected: boolean
  tool: Tool
  store: EditorStore
  onSelect: Dispatch<SetStateAction<string | null>>
}

interface Point { x: number; y: number }

/** A pin on the page; selecting it opens the note for editing. */
export function CommentView({ comment, number, zoom, pageSize, selected, tool, store, onSelect }: Props) {
  const pinRef = useRef<HTMLButtonElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const movable = tool === 'select' || tool === 'comment'
  const drag = useOverlayGesture(
    () => ({ zoom, version: store.getVersion(), tool, active: movable }),
    ({ data, dx, dy }: GestureStep<Point>) => moveComment(data, dx, dy, pageSize),
    (next) => {
      if (next.x !== comment.x || next.y !== comment.y) store.dispatch(updateOverlay(comment.id, { x: comment.x, y: comment.y }, next))
    },
  )
  const position = drag.shown ?? comment
  const shownNote = draft ?? comment.note

  // A new, empty comment opens straight into typing.
  useEffect(() => {
    if (selected && comment.note === '') textareaRef.current?.focus({ preventScroll: true })
  }, [selected, comment.note])

  const latest = useRef({ draft, comment })
  useLayoutEffect(() => { latest.current = { draft, comment } })
  const commit = (leaving: boolean) => {
    const { draft: typed, comment: current } = latest.current
    latest.current = { draft: null, comment: current }
    setDraft(null)
    if (!store.state.overlays.some(overlay => overlay.id === current.id)) return
    const note = typed ?? current.note
    if (leaving && note.trim() === '') {
      // An empty note is no comment: leaving it removes the pin.
      store.dispatch(removeOverlay(current))
      onSelect(selectedId => selectedId === current.id ? null : selectedId)
      return
    }
    if (note !== current.note) store.dispatch(updateOverlay(current.id, { note: current.note }, { note }))
  }
  // Deselecting by clicking elsewhere removes the popover before its textarea
  // could blur: keep what was typed instead of losing it.
  const commitRef = useRef(commit)
  useLayoutEffect(() => { commitRef.current = commit })
  // Only a typed draft is saved here: StrictMode's trial cleanup of a fresh pin must not remove it.
  useEffect(() => {
    if (!selected) return
    return () => { if (latest.current.draft !== null) commitRef.current(false) }
  }, [selected])
  // Once deselected, an empty note is no comment: the pin goes away.
  const wasSelected = useRef(selected)
  useEffect(() => {
    const was = wasSelected.current
    wasSelected.current = selected
    if (!was || selected) return
    const current = store.state.overlays.find(overlay => overlay.id === comment.id)
    if (current && 'note' in current && current.note.trim() === '') store.dispatch(removeOverlay(current))
  }, [selected, comment.id, store])

  const size = COMMENT_PIN_SIZE * zoom
  return (
    <>
      <button
        ref={pinRef}
        type="button"
        className={`comment-pin${selected ? ' selected' : ''}`}
        data-comment-id={comment.id}
        aria-label={`Kommentar ${number}${comment.note ? `: ${comment.note.split('\n')[0]}` : ''}`}
        aria-expanded={selected}
        title={comment.note || 'Kommentar'}
        style={{ left: position.x * zoom, top: (pageSize.height - position.y) * zoom, width: size, height: size, fontSize: Math.max(9, 11 * zoom) }}
        onPointerDown={(event) => {
          event.stopPropagation()
          if (movable && drag.begin(event, { x: comment.x, y: comment.y })) onSelect(comment.id)
          else onSelect(comment.id)
        }}
        {...drag.pointer}
        onFocus={() => onSelect(comment.id)}
      >
        {number}
      </button>
      {selected && (
        <FloatingBar anchor={pinRef} barRef={barRef} className="comment-popover" label={`Kommentar ${number}`}>
          <textarea
            ref={textareaRef}
            aria-label="Kommentartext"
            placeholder="Notiz …"
            value={shownNote}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.currentTarget.blur()
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) event.currentTarget.blur()
            }}
            onBlur={(event) => {
              const staysInside = event.relatedTarget instanceof Node &&
                (barRef.current?.contains(event.relatedTarget) === true || pinRef.current?.contains(event.relatedTarget) === true)
              commit(!staysInside)
            }}
          />
          <div className="comment-actions">
            <button
              type="button"
              aria-label="Kommentar löschen"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setDraft(null)
                store.dispatch(removeOverlay(comment))
                onSelect(null)
              }}
            >
              🗑 Löschen
            </button>
            <button
              type="button"
              onClick={() => {
                commit(true)
                onSelect(current => current === comment.id ? null : current)
              }}
            >
              Fertig
            </button>
          </div>
        </FloatingBar>
      )}
    </>
  )
}
