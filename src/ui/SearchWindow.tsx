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

// Browser font measurement follows the editor fonts. PDF substring advances
// are font-measured estimates (PDF.js does not expose individual glyph advances).
function overlayGroups(
  overlays: Overlay[],
  sizes: { width: number; height: number }[],
): SearchGroup[] {
  const context = document.createElement('canvas').getContext('2d')
  return overlays.filter(isTextbox).flatMap((box) => {
    const size = sizes[box.pageIndex]
    if (!size || !context) return []
    context.font = `${box.italic ? 'italic' : 'normal'} ${box.bold ? 'bold' : 'normal'} ${box.fontSize}px ${box.font === 'times' ? 'Times New Roman' : box.font === 'courier' ? 'Courier New' : 'Arial'}`
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
          top = line * box.fontSize * 1.2 - box.fontSize * 0.85,
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
        pageIndex: box.pageIndex,
        fragments: visibleFragments(fragments, size, clips),
      },
    ]
  })
}

export function SearchWindow({
  pdf,
  overlays,
  onClose,
  onHits,
  onJump,
}: {
  pdf: PdfHandle
  overlays: Overlay[]
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
            [...data.groups, ...overlayGroups(overlays, data.sizes)],
            query,
          )
        : [],
    [ready, data, overlays, query],
  )
  const active = hits.length ? Math.min(index, hits.length - 1) : 0
  const move = (delta: number) =>
    setIndex((current) =>
      hits.length
        ? (Math.min(current, hits.length - 1) + delta + hits.length) %
          hits.length
        : 0,
    )
  useEffect(() => {
    onHits(hits, active)
    if (hits[active]) onJump(hits[active])
  }, [hits, active, onHits, onJump])
  useEffect(() => {
    const parent = windowRef.current?.parentElement
    if (!parent || !hits[active]) return
    const observer = new ResizeObserver(() => onJump(hits[active]))
    observer.observe(parent)
    return () => observer.disconnect()
  }, [hits, active, onJump])
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
