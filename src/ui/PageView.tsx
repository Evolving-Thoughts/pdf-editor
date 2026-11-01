import type { SearchHit } from '../core/search'
import { RedactionView } from './RedactionView'
import { createRedaction,replaceRedactions,type Redaction } from '../core/redactions'
import type { NativeWidget } from '../core/forms'
import { NativeFormLayer } from './NativeFormLayer'
import { useEffect, useRef, useState, type ReactNode, type Dispatch, type SetStateAction } from 'react'
import { resolvedOverlayClips } from '../core/overlayClipping'
import { addOverlay, replaceOverlays } from '../core/commands'
import { eraseStrokes, strokeToSvgPath } from '../core/drawing'
import type { EditorStore } from '../core/editorStore'
import { createId, isImage, isShape, isStroke, type Overlay, type StrokePoint, type Textbox } from '../core/model'
import type { PageSize, PdfHandle } from '../core/pdf/loadPdf'
import { ImageView } from './ImageView'
import { createShape, MARKER_OPACITY, shapeToSvgPath, type ShapeStyle } from '../core/shapes'
import { ShapeView } from './ShapeView'
import { isShapeTool } from './tools'
import { TextboxView } from './TextboxView'
import type { Tool } from './tools'

interface PageViewProps {
  searchHits?: SearchHit[]
  activeSearchHit?: SearchHit

  redactionFill?: Redaction['fill']
  nativeWidgets?: NativeWidget[]
  highlightFields?: boolean
  onFormError?: (message: string) => void
  pdf: PdfHandle
  readOnly?: boolean
  pageIndex: number
  pageId: string
  zoom: number
  tool: Tool
  symbol: string
  overlays: Overlay[]
  store: EditorStore
  selectedId: string | null
  onSelect: Dispatch<SetStateAction<string | null>>
  strokeColor?: string
  strokeWidth?: number
  onImageDrop: (file: File, pageIndex: number, point: StrokePoint) => void
  onPlaceStamp?: (pageId: string, point: StrokePoint, page: PageSize) => void
  shapeStyle: ShapeStyle
  markerStyle: ShapeStyle
  eraserRadius?: number
}

interface DrawingGesture {
  pointerId: number
  pdf: PdfHandle
  tool: Tool
  version: number
  style: ShapeStyle
  zoom: number
  color: string
  width: number
  radius: number
  points: StrokePoint[]
}

export function PageView({
  searchHits = [], activeSearchHit, redactionFill = 'black', nativeWidgets = [], highlightFields = false, onFormError,
  pdf, readOnly = false, pageIndex, pageId, zoom, tool, symbol, overlays, store, selectedId, onSelect,
  shapeStyle, markerStyle, onImageDrop, onPlaceStamp, strokeColor = '#111111', strokeWidth = 3, eraserRadius = 8,
}: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const textPointerRef = useRef<{ x: number; y: number } | null>(null)
  const [hasText, setHasText] = useState<{ pdf: PdfHandle; pageIndex: number; value: boolean } | null>(null)
  const [noTextHint, setNoTextHint] = useState(false)
  const selectableText = !readOnly && tool === 'select'
  const pageHasNoText = hasText?.pdf === pdf && hasText.pageIndex === pageIndex && !hasText.value
  const [pageSize, setPageSize] = useState<PageSize | null>(null)
  const [renderError, setRenderError] = useState<{ pdf: PdfHandle; pageIndex: number; zoom: number; message: string } | null>(null)
  const gestureRef = useRef<DrawingGesture | null>(null)
  const [preview, setPreview] = useState<DrawingGesture | null>(null)
  const previewPoints = preview && preview.pdf === pdf && preview.tool === tool && preview.zoom === zoom && preview.version === store.getVersion()
    ? preview.points : []
  const drawing = tool === 'redact' || tool === 'pen' || tool === 'eraser' || isShapeTool(tool)

  useEffect(() => {
    let cancelled = false
    void pdf.getPageSize(pageIndex + 1).then((size) => {
      if (!cancelled) setPageSize(size)
    }).catch(error => {
      // A superseded preview may be destroyed while its page size is loading.
      if (!cancelled) console.warn(error)
    })
    return () => {
      cancelled = true
    }
  }, [pdf, pageIndex])

  useEffect(() => {
    let cancelled = false
    // Aborting removes queued work and cancels running work of an unmounted page.
    const controller = new AbortController()
    if (canvasRef.current) void pdf.renderPage(pageIndex + 1, canvasRef.current, zoom, controller.signal).then(() => {
      if (!cancelled) setRenderError(null)
    }).catch(error => {
      if (!cancelled) setRenderError({ pdf, pageIndex, zoom, message: error instanceof Error ? error.message : 'Die Seite konnte nicht angezeigt werden.' })
    })
    return () => { cancelled = true; controller.abort() }
  }, [pdf, pageIndex, zoom])

  // Text selection belongs to the select tool only, so drawing never hits text spans.
  useEffect(() => {
    const layer = textLayerRef.current
    if (!selectableText || !layer) return
    const controller = new AbortController()
    void pdf.renderTextLayer(pageIndex + 1, layer, zoom, controller.signal).then(value => {
      if (controller.signal.aborted) return
      const end = document.createElement('div')
      end.className = 'endOfContent'
      layer.append(end)
      setHasText({ pdf, pageIndex, value })
    }).catch(error => {
      // Aborted layers are expected; a missing layer never blocks the page itself.
      if (!controller.signal.aborted) console.warn(error)
    })
    return () => {
      controller.abort()
      const selection = window.getSelection()
      if (selection?.anchorNode && layer.contains(selection.anchorNode)) selection.removeAllRanges()
      layer.replaceChildren()
    }
  }, [pdf, pageIndex, zoom, selectableText])

  useEffect(() => {
    if (!noTextHint) return
    const timer = setTimeout(() => setNoTextHint(false), 5000)
    return () => clearTimeout(timer)
  }, [noTextHint])

  const onTextLayerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return
    event.preventDefault()
    const selection = window.getSelection(), range = document.createRange()
    range.selectNodeContents(event.currentTarget)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  const onPagePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (readOnly) return
    if (!event.isPrimary || event.button !== 0 || gestureRef.current) return
    if ((event.target as HTMLElement).closest('.textbox, .image-overlay, .shape-overlay, .native-widget, .redaction-overlay')) return
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
    if (drawing) {
      // Keep the previous completed selection/options while painting another shape.
      if (!isShapeTool(tool)) onSelect(null)
      gestureRef.current = {
        pointerId: event.pointerId, pdf, tool, zoom, version: store.getVersion(), style: { ...(tool === 'marker' ? markerStyle : shapeStyle) }, color: strokeColor,
        width: strokeWidth, radius: eraserRadius,
        points: [pointFrom(event.clientX, event.clientY)],
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      setPreview({ ...gestureRef.current, points: [...gestureRef.current.points] })
      return
    }
    if (tool === 'stamp') {
      onPlaceStamp?.(pageId, pointFrom(event.clientX, event.clientY), pageSize)
      return
    }
    const placingSymbol = tool === 'symbol'
    const box: Textbox = {
      id: createId(),
      pageId,
      x: cssX / zoom,
      y: pageSize.height - cssY / zoom,
      text: placingSymbol ? symbol : '',
      font: placingSymbol ? 'zapfdingbats' : 'helvetica',
      fontSize: 14,
      bold: false,
      italic: false,
      underline: false,
    }
    store.dispatch(addOverlay(box))
    onSelect(box.id)
  }

  const pointFrom = (clientX: number, clientY: number): StrokePoint => {
    const rect = wrapperRef.current!.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(pageSize!.width, (clientX - rect.left) / zoom)),
      y: Math.max(0, Math.min(pageSize!.height, pageSize!.height - (clientY - rect.top) / zoom)),
    }
  }

  const appendPoints = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId || !pageSize) return
    if (gesture.pdf !== pdf || gesture.zoom !== zoom || gesture.tool !== tool || gesture.version !== store.getVersion()) return
    const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? []
    const samples = coalesced.length ? coalesced : [event]
    for (const sample of samples) {
      const point = pointFrom(sample.clientX, sample.clientY)
      const last = gesture.points[gesture.points.length - 1]
      if (last.x !== point.x || last.y !== point.y) gesture.points.push(point)
    }
    setPreview({ ...gesture, points: [...gesture.points] })
  }

  const cancelDrawing = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return
    gestureRef.current = null
    setPreview(null)
  }

  const finishDrawing = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (gesture.pdf !== pdf || gesture.zoom !== zoom || gesture.tool !== tool || gesture.version !== store.getVersion()) {
      cancelDrawing(event)
      return
    }
    appendPoints(event)
    gestureRef.current = null
    setPreview(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (gesture.tool === 'pen') {
      store.dispatch(addOverlay({
        id: createId(), pageId, points: gesture.points, color: gesture.color, width: gesture.width,
      }))
    } else if (gesture.tool === 'redact') {
      const mark = createRedaction(pageId,gesture.points[0],gesture.points.at(-1)!,pageSize!,redactionFill)
      if(mark){store.dispatch(replaceRedactions(store.state,[...(store.state.redactions??[]),mark]));onSelect(mark.id)}
    } else if (isShapeTool(gesture.tool)) {
      const shape = createShape(gesture.tool, gesture.points, pageId, gesture.style)
      if (shape) { store.dispatch(addOverlay(shape)); onSelect(shape.id) }
    } else {
      const before = store.state.overlays
      const after = eraseStrokes(before, pageId, gesture.points, gesture.radius)
      if (after !== before) store.dispatch(replaceOverlays(before, after))
    }
  }

  const redactionPreview = tool==='redact'&&previewPoints.length?createRedaction(pageId,previewPoints[0],previewPoints.at(-1)!,pageSize!,redactionFill):null
  const shapePreview = isShapeTool(tool) && previewPoints.length > 0 ? createShape(tool, previewPoints, pageId, preview!.style) : null
  return (
    <div
      className={`page${tool==='redact'?' redact-tool':''}${tool === 'text' ? ' text-tool' : ''}${tool === 'symbol' || tool === 'stamp' ? ' symbol-tool' : ''}${drawing ? ' drawing-tool' : ''}`}
      ref={wrapperRef}
      data-page-index={pageIndex}
      inert={readOnly}
      style={{pointerEvents: readOnly ? 'none' : undefined, overflow: store.state.pages?.[pageIndex]?.cropped ? 'hidden' : undefined}}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
      onDrop={event => {
        event.preventDefault()
        const file = event.dataTransfer.files[0]
        if (file && (file.type==='application/pdf' || /\.pdf$/i.test(file.name))) return
        if (!readOnly && file && pageSize) onImageDrop(file, pageIndex, pointFrom(event.clientX, event.clientY))
      }}
      onPointerDown={onPagePointerDown}
      onPointerMove={appendPoints}
      onPointerUp={finishDrawing}
      onPointerCancel={cancelDrawing}
      onLostPointerCapture={cancelDrawing}
    >
      <canvas ref={canvasRef} />
      {selectableText && <div
        ref={textLayerRef}
        className="textLayer"
        tabIndex={0}
        role="region"
        aria-label={pageHasNoText ? `Seite ${pageIndex + 1}: keine Textebene` : `Text von Seite ${pageIndex + 1}, markierbar`}
        onKeyDown={onTextLayerKeyDown}
        onFocus={event => { if (pageHasNoText && event.currentTarget.matches(':focus-visible')) setNoTextHint(true) }}
        onPointerDown={event => {
          textPointerRef.current = { x: event.clientX, y: event.clientY }
          event.currentTarget.classList.add('selecting')
        }}
        onPointerUp={event => {
          event.currentTarget.classList.remove('selecting')
          const start = textPointerRef.current
          textPointerRef.current = null
          if (pageHasNoText && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) setNoTextHint(true)
        }}
        onPointerCancel={event => event.currentTarget.classList.remove('selecting')}
      />}
      {selectableText && pageHasNoText && noTextHint && <p role="status" className="page-no-text">Diese Seite hat keine Textebene. Text lässt sich hier nicht markieren.</p>}
      {renderError?.pdf === pdf && renderError.pageIndex === pageIndex && renderError.zoom === zoom && <p role="alert">{renderError.message}</p>}
      {pageSize && !!searchHits.length && <svg className="search-highlights" viewBox={`0 0 ${pageSize.width} ${pageSize.height}`} aria-hidden="true">
        {searchHits.flatMap((hit,index)=>hit.polygons.map((polygon,part)=><polygon key={`${index}-${part}`} data-search-active={hit===activeSearchHit?'true':undefined} points={polygon.map(p=>`${p.x},${p.y}`).join(' ')} className={hit===activeSearchHit?'active':''}/>))}
      </svg>}
      {pageSize && nativeWidgets.some(field => field.pageIndex === pageIndex) && <NativeFormLayer fields={nativeWidgets.filter(field => field.pageIndex === pageIndex)} store={store} interactive={!readOnly && (tool === 'select' || tool === 'text')} highlight={highlightFields} zoom={zoom} onSelect={onSelect} onError={onFormError} />}
      {pageSize &&
        overlays
          .filter((overlay) => overlay.pageId === pageId)
          .map((overlay) => {
            const element: ReactNode = isStroke(overlay) ? (
            <svg key={overlay.id} className="stroke-layer" viewBox={`0 0 ${pageSize.width} ${pageSize.height}`} aria-hidden="true">
              <path className="stroke" d={strokeToSvgPath(overlay.points, pageSize.height)} fill="none"
                stroke={overlay.color} strokeWidth={overlay.width} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : isImage(overlay) ? (
            <ImageView key={overlay.id} image={overlay} zoom={zoom} pageSize={pageSize}
              selected={overlay.id === selectedId} tool={tool} store={store} onSelect={onSelect} />
          ) : isShape(overlay) ? (
            <ShapeView key={overlay.id} shape={overlay} zoom={zoom} pageSize={pageSize}
              selected={overlay.id === selectedId} tool={tool} store={store} onSelect={onSelect} />
          ) : (
            <TextboxView key={overlay.id} box={overlay} zoom={zoom} pageSize={pageSize}
              selected={overlay.id === selectedId} tool={tool} store={store} onSelect={onSelect} />
          )
            return resolvedOverlayClips(overlay).reduceRight<ReactNode>((child, polygon, clipIndex) => (
              <div key={`${overlay.id}-clip-${clipIndex}`} className="overlay-clip" style={{ clipPath: `polygon(${polygon.map(p => `${p.x * zoom}px ${(pageSize.height - p.y) * zoom}px`).join(',')})` }}>{child}</div>
            ), element)
          })}
      {pageSize && previewPoints.length > 0 && tool!=='redact' && !isShapeTool(tool) && (
        <svg className="stroke-layer" viewBox={`0 0 ${pageSize.width} ${pageSize.height}`} aria-hidden="true">
          <path className="stroke-preview" d={strokeToSvgPath(previewPoints, pageSize.height)} fill="none"
            stroke={tool === 'eraser' ? '#2783de' : preview?.color}
            strokeWidth={tool === 'eraser' ? (preview?.radius ?? eraserRadius) * 2 : preview?.width}
            opacity={tool === 'eraser' ? 0.25 : 1} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {pageSize && (store.state.redactions??[]).filter(mark=>mark.pageId===pageId).map(mark=><RedactionView key={mark.id} mark={mark} zoom={zoom} pageSize={pageSize} selected={selectedId===mark.id} tool={tool} store={store} onSelect={onSelect} readOnly={readOnly}/>)}
      {pageSize && redactionPreview && <div className={`redaction-overlay preview ${redactionPreview.fill}`} style={{left:redactionPreview.x*zoom,top:(pageSize.height-redactionPreview.y-redactionPreview.height)*zoom,width:redactionPreview.width*zoom,height:redactionPreview.height*zoom,pointerEvents:'none'}}/>}
      {pageSize && shapePreview && <svg className="stroke-layer" viewBox={`0 0 ${pageSize.width} ${pageSize.height}`} aria-hidden="true"
        style={tool === 'marker' ? {mixBlendMode:'multiply'} : undefined}>
        <g transform={`translate(${shapePreview.x},${pageSize.height-shapePreview.y-shapePreview.height})`}>
          <path className="shape-preview" d={shapeToSvgPath(shapePreview)} fill={shapePreview.fill ?? 'none'} stroke={shapePreview.strokeColor ?? 'none'}
            strokeWidth={shapePreview.strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity={tool === 'marker' ? MARKER_OPACITY : 1} />
        </g>
      </svg>}
    </div>
  )
}
