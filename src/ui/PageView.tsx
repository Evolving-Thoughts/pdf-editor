import { useEffect, useRef, useState } from 'react'
import { addTextbox } from '../core/commands'
import type { EditorStore } from '../core/editorStore'
import { createId, type Overlay, type Textbox } from '../core/model'
import type { PageSize, PdfHandle } from '../core/pdf/loadPdf'
import { TextboxView } from './TextboxView'
import type { Tool } from './tools'

interface PageViewProps {
  pdf: PdfHandle
  pageIndex: number
  zoom: number
  tool: Tool
  symbol: string
  overlays: Overlay[]
  store: EditorStore
  selectedId: string | null
  onSelect: (id: string | null) => void
}

export function PageView({ pdf, pageIndex, zoom, tool, symbol, overlays, store, selectedId, onSelect }: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [pageSize, setPageSize] = useState<PageSize | null>(null)

  useEffect(() => {
    let cancelled = false
    void pdf.getPageSize(pageIndex + 1).then((size) => {
      if (!cancelled) setPageSize(size)
    })
    return () => {
      cancelled = true
    }
  }, [pdf, pageIndex])

  useEffect(() => {
    if (canvasRef.current) void pdf.renderPage(pageIndex + 1, canvasRef.current, zoom)
  }, [pdf, pageIndex, zoom])

  const onPagePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.textbox')) return
    if (tool === 'select') {
      onSelect(null)
      return
    }
    // Text and symbol tools create their respective box at the click position.
    if (!pageSize || !wrapperRef.current) return
    // Prevent the browser's mousedown default from moving focus to the
    // (non-focusable) canvas, which would undo the textarea autofocus.
    event.preventDefault()
    const rect = wrapperRef.current.getBoundingClientRect()
    const cssX = event.clientX - rect.left
    const cssY = event.clientY - rect.top
    const placingSymbol = tool === 'symbol'
    const box: Textbox = {
      id: createId(),
      pageIndex,
      x: cssX / zoom,
      y: pageSize.height - cssY / zoom,
      text: placingSymbol ? symbol : '',
      font: placingSymbol ? 'zapfdingbats' : 'helvetica',
      fontSize: 14,
      bold: false,
      italic: false,
      underline: false,
    }
    store.dispatch(addTextbox(box))
    onSelect(box.id)
  }

  return (
    <div
      className={`page${tool === 'text' ? ' text-tool' : ''}${tool === 'symbol' ? ' symbol-tool' : ''}`}
      ref={wrapperRef}
      onPointerDown={onPagePointerDown}
    >
      <canvas ref={canvasRef} />
      {pageSize &&
        overlays
          .filter((overlay) => overlay.pageIndex === pageIndex)
          .map((box) => (
            <TextboxView
              key={box.id}
              box={box}
              zoom={zoom}
              pageHeightPts={pageSize.height}
              selected={box.id === selectedId}
              tool={tool}
              store={store}
              onSelect={onSelect}
            />
          ))}
    </div>
  )
}
