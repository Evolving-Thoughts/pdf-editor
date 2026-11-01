import { useEffect, useMemo, useRef, useState } from 'react'
import type { PdfHandle } from '../core/pdf/loadPdf'
import {
  visibleFragments,
  searchDocument,
  type SearchGroup,
  type SearchHit,
  type SearchFragment,
} from '../core/search'
import { isTextbox, type Overlay } from '../core/model'
import { resolvedOverlayClips } from '../core/overlayClipping'
import type { DocumentPage } from '../core/pages'
import { TEXT_LINE_HEIGHT } from '../core/textLayout'
import { FONT_CSS } from './fontStacks'

// Browser font measurement follows the editor fonts. PDF substring advances
// are font-measured estimates (PDF.js does not expose individual glyph advances).
function overlayGroups(
  overlays: Overlay[],
  sizes: { width: number; height: number }[],
  pages: readonly DocumentPage[],
): SearchGroup[] {
  const context = document.createElement('canvas').getContext('2d')
  return overlays.filter(isTextbox).flatMap((box) => {
    const pageIndex = pages.findIndex((page) => page.id === box.pageId)
    const size = sizes[pageIndex]
    if (!size || !context) return []
    context.font = `${box.italic ? 'italic' : 'normal'} ${box.bold ? 'bold' : 'normal'} ${box.fontSize}px ${FONT_CSS[box.font]}`
    const angle = ((box.rotation ?? 0) * Math.PI) / 180,
      cos = Math.cos(angle),
      sin = Math.sin(angle)
    const point = (x: number, y: number) => ({
      x: box.x + cos * x - sin * y,
      y: size.height - box.y + sin * x + cos * y,
    })
    const fragments: SearchFragment[] = box.text
      .split('\n')
      .map((text, line) => {
        const width = context.measureText(text).width,
          top = line * box.fontSize * TEXT_LINE_HEIGHT - box.fontSize * 0.85,
          bottom = top + box.fontSize
        const advances =
          width > 0
            ? Array.from(
                { length: text.length + 1 },
                (_, i) => context.measureText(text.slice(0, i)).width / width,
              )
            : undefined
        return {
          text,
          breakAfter: true,
          advances,
          quad: [
            point(0, top),
            point(width, top),
            point(width, bottom),
            point(0, bottom),
          ],
        }
      })
    // Fully outside a cropped page/clip contributes no hidden text to search.
    const clips = resolvedOverlayClips(box).map((p) =>
      p.map((v) => ({ x: v.x, y: size.height - v.y })),
    )
    return [
      {
        pageIndex,
        fragments: visibleFragments(fragments, size, clips),
      },
    ]
  })
}

export function SearchWindow({
  pdf,
  overlays,
  pages,
  onClose,
  onHits,
  onJump,
}: {
  pdf: PdfHandle
  overlays: Overlay[]
  pages: readonly DocumentPage[]
  onClose: () => void
  onHits: (hits: SearchHit[], active: number) => void
  onJump: (hit: SearchHit) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const windowRef = useRef<HTMLElement>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [data, setData] = useState<{
    pdf: PdfHandle
    groups: SearchGroup[]
    sizes: { width: number; height: number }[]
  } | null>(null)
  const [failure, setFailure] = useState(false)
  useEffect(() => {
    let cancelled = false
    async function indexPages() {
      const groups: SearchGroup[] = [],
        sizes: { width: number; height: number }[] = []
      // Sequential indexing avoids launching a worker request for every page at once.
      for (let page = 1; page <= pdf.pageCount; page++) {
        if (cancelled) return
        const size = await pdf.getPageSize(page),
          fragments = await pdf.getSearchText(page)
        sizes.push(size)
        groups.push({
          pageIndex: page - 1,
          fragments: visibleFragments(fragments, size),
        })
      }
      if (!cancelled) {
        setData({ pdf, groups, sizes })
        setFailure(false)
      }
    }
    void indexPages().catch(() => {
      if (!cancelled) setFailure(true)
    })
    return () => {
      cancelled = true
    }
  }, [pdf])
  const ready = data?.pdf === pdf
  const hits = useMemo(
    () =>
      ready
        ? searchDocument(
            [...data.groups, ...overlayGroups(overlays, data.sizes, pages)],
            query,
          )
        : [],
    [ready, data, overlays, pages, query],
  )
  const active = hits.length ? Math.min(index, hits.length - 1) : 0
  const move = (delta: number) =>
    setIndex((current) =>
      hits.length
        ? (Math.min(current, hits.length - 1) + delta + hits.length) %
          hits.length
        : 0,
    )
  const activeHit = useRef<SearchHit | undefined>(undefined)
  const jumpedTo = useRef<string | null>(null)
  useEffect(() => {
    onHits(hits, active)
  }, [hits, active, onHits])
  // Edits elsewhere recompute the hits: the marks follow, the view only moves
  // for a new query or another hit.
  useEffect(() => {
    activeHit.current = hits[active]
    const target = hits[active] ? `${active}:${query}` : null
    if (target !== null && target !== jumpedTo.current) onJump(hits[active])
    jumpedTo.current = target
  }, [hits, active, query, onJump])
  // A new observer reports once, so another zoom also brings the hit back.
  useEffect(() => {
    const parent = windowRef.current?.parentElement
    if (!parent) return
    const observer = new ResizeObserver(() => {
      if (activeHit.current) onJump(activeHit.current)
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [onJump])
  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('dialog')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onClose])
  return (
    <section
      ref={windowRef}
      className="search-window"
      aria-label="Im Dokument suchen"
    >
      <div className="search-query">
        <input
          ref={input}
          aria-label="Suchtext"
          placeholder="Im Dokument suchen"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              move(event.shiftKey ? -1 : 1)
            }
          }}
        />
      </div>
      <div className="search-controls">
        <span role="status">
          {failure
            ? 'Suche fehlgeschlagen'
            : !ready
              ? 'Text wird geladen …'
              : query.trim()
                ? `${hits.length ? active + 1 : 0} / ${hits.length}`
                : 'Suchtext eingeben'}
        </span>
        <button
          type="button"
          aria-label="Vorheriger Treffer"
          disabled={!hits.length}
          onClick={() => move(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Nächster Treffer"
          disabled={!hits.length}
          onClick={() => move(1)}
        >
          ↓
        </button>
        <button type="button" aria-label="Suche schließen" onClick={onClose}>
          ×
        </button>
      </div>
      <small>PDF-Text und Textboxen · keine OCR</small>
    </section>
  )
}
