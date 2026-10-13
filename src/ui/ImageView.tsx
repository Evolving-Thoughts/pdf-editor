import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { removeImage, updateImage, type ImageChanges } from '../core/commands'
import type { EditorStore } from '../core/editorStore'
import { imageGeometry, mmToPts, moveImage, ptsToMm, resizeImage, setImageSize, type Bounds, type Corner } from '../core/images/geometry'
import type { ImageOverlay } from '../core/model'
import type { Tool } from './tools'

interface Props {
  image: ImageOverlay
  zoom: number
  pageSize: Bounds
  selected: boolean
  tool: Tool
  store: EditorStore
  onSelect: (id: string | null) => void
}
interface Gesture {
  pointerId: number
  x: number
  y: number
  zoom: number
  version: number
  before: ImageChanges
  corner?: Corner
}
const cornerNames: Record<Corner, string> = { nw: 'oben links', ne: 'oben rechts', sw: 'unten links', se: 'unten rechts' }

export function ImageView({ image, zoom, pageSize, selected, tool, store, onSelect }: Props) {
  const anchor = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [preview, setPreview] = useState<{ geometry: ImageChanges; zoom: number; version: number } | null>(null)
  const active = selected && tool === 'select'
  const validGesture = preview && preview.zoom === zoom && preview.version === store.getVersion() && active
  const geometry = validGesture && preview ? preview.geometry : imageGeometry(image)
  const commit = (next: ImageChanges) => {
    const before = imageGeometry(image)
    if (JSON.stringify(before) !== JSON.stringify(next)) store.dispatch(updateImage(image.id, before, next))
  }
  const cancel = () => { gesture.current = null; setPreview(null) }
  const onImagePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const corner = event.currentTarget.dataset.corner as Corner | undefined
    if (tool !== 'select' || !event.isPrimary || event.button !== 0 || gesture.current) return
    event.stopPropagation()
    event.preventDefault()
    onSelect(image.id)
    anchor.current?.focus({ preventScroll: true })
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, zoom,
      version: store.getVersion(), before: imageGeometry(image), corner }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const nextGeometry = (event: React.PointerEvent, current: Gesture) => {
    const dx = (event.clientX - current.x) / current.zoom
    const dy = (current.y - event.clientY) / current.zoom
    return current.corner ? resizeImage(current.before, current.corner, dx, dy, pageSize)
      : moveImage(current.before, dx, dy, pageSize)
  }
  const move = (event: React.PointerEvent) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    event.stopPropagation()
    if (current.zoom !== zoom || current.version !== store.getVersion() || !active) { cancel(); return }
    setPreview({ geometry: nextGeometry(event, current), zoom: current.zoom, version: current.version })
  }
  const finish = (event: React.PointerEvent) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    event.stopPropagation()
    const valid = current.zoom === zoom && current.version === store.getVersion() && active
    const next = nextGeometry(event, current)
    cancel()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (valid) commit(next)
  }
  return (
    <div ref={anchor} className={`image-overlay${active ? ' selected' : ''}`} tabIndex={tool === 'select' ? 0 : -1}
      role="group" aria-label={`Bild: ${image.name}`} data-image-id={image.id}
      style={{ left: geometry.x * zoom, top: (pageSize.height - geometry.y - geometry.height) * zoom,
        width: geometry.width * zoom, height: geometry.height * zoom }}
      onFocus={() => { if (tool === 'select') onSelect(image.id) }}
      onPointerDown={onImagePointerDown} onPointerMove={move} onPointerUp={finish}
      onPointerCancel={cancel} onLostPointerCapture={cancel}>
      <img src={image.dataUrl} alt={image.name} draggable={false} />
      {active && (Object.keys(cornerNames) as Corner[]).map(corner => (
        <button key={corner} className={`image-handle ${corner}`} type="button"
          aria-label={`Bild skalieren: ${cornerNames[corner]}`} title="Ziehen zum Skalieren · Pfeiltasten für Feinschritte"
          data-corner={corner} onPointerDown={onImagePointerDown}
          onKeyDown={event => {
            if (!event.key.startsWith('Arrow')) return
            event.preventDefault(); event.stopPropagation()
            const step = event.shiftKey ? 10 : 1
            commit(resizeImage(imageGeometry(image), corner,
              event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
              event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0, pageSize))
          }}><span /></button>
      ))}
      {active && <ImageOptions image={image} geometry={geometry} anchor={anchor} pageSize={pageSize}
        onChange={commit} onDelete={() => { store.dispatch(removeImage(image)); onSelect(null) }} />}
    </div>
  )
}

function ImageOptions({ image, geometry, anchor, pageSize, onChange, onDelete }: {
  image: ImageOverlay; geometry: ImageChanges; anchor: React.RefObject<HTMLDivElement | null>; pageSize: Bounds
  onChange: (next: ImageChanges) => void; onDelete: () => void
}) {
  const toolbar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = toolbar.current
    const target = anchor.current
    const workspace = target?.closest('.workspace')
    const pages = target?.closest('.pages')
    if (!element || !target || !workspace || !pages) return
    const place = () => {
      const box = target.getBoundingClientRect()
      const area = workspace.getBoundingClientRect()
      const left = Math.max(8, area.left + 8)
      const right = Math.min(window.innerWidth - 8, area.right - 8)
      const top = Math.max(8, area.top + 8)
      const bottom = Math.min(window.innerHeight - 8, area.bottom - 8)
      const visible = box.bottom > top && box.top < bottom && box.right > left && box.left < right
      element.style.visibility = visible ? 'visible' : 'hidden'
      element.style.maxWidth = `${Math.max(0, right - left)}px`
      const width = element.offsetWidth
      const height = element.offsetHeight
      const above = box.top - height - 12
      const desiredY = above >= top ? above : box.bottom + 12
      element.style.left = `${Math.max(left, Math.min(right - width, box.left + (box.width - width) / 2))}px`
      element.style.top = `${Math.max(top, Math.min(bottom - height, desiredY))}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(workspace); observer.observe(element); observer.observe(target)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchor, geometry])
  return createPortal(
    <div ref={toolbar} className="image-options" role="toolbar" aria-label={`Bildoptionen: ${image.name}`}
      onPointerDown={event => event.stopPropagation()}>
      {(['width', 'height'] as const).map(dimension => <ImageSizeInput key={dimension}
        label={dimension === 'width' ? 'Breite' : 'Höhe'} value={geometry[dimension]}
        onCommit={value => onChange(setImageSize(imageGeometry(image), dimension, value, pageSize))} />)}
      <button type="button" aria-label="Proportionen beibehalten" title="Proportionen beibehalten"
        aria-pressed={image.lockAspectRatio} onClick={() => onChange({ ...imageGeometry(image), lockAspectRatio: !image.lockAspectRatio })}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="m 10 14 4 -4 M 8 16 l -1 1 a 4 4 0 0 1 -6 -6 l 5 -5 a 4 4 0 0 1 6 0 M 16 8 l 1 -1 a 4 4 0 0 1 6 6 l -5 5 a 4 4 0 0 1 -6 0" />
        </svg>
      </button>
      <button type="button" aria-label="Bild löschen" title="Bild löschen (Entf)" onClick={onDelete}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 4 6 h 16 M 9 6 V 3 h 6 v 3 M 6 6 l 1 15 h 10 l 1 -15 M 10 10 v 7 M 14 10 v 7" />
        </svg>
      </button>
    </div>, document.body)
}

function ImageSizeInput({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [editing, setEditing] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  return <label>{label} · mm
    <input ref={input} type="number" min="0.1" step="0.1" aria-label={`${label} in Millimetern`}
      value={editing ?? ptsToMm(value).toFixed(1)}
      onFocus={event => { cancelled.current = false; setEditing(event.currentTarget.value) }}
      onChange={event => setEditing(event.currentTarget.value)}
      onBlur={() => {
        if (!cancelled.current && editing !== null && editing.trim() !== '') onCommit(mmToPts(Number(editing)))
        setEditing(null)
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); input.current?.blur() }
        if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setEditing(null); input.current?.blur() }
      }} />
  </label>
}
