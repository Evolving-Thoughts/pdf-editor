import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { nudgeOverlay, removeOverlay, updateOverlay, type ImageChanges, type ImageKeyboardAction } from '../core/commands'
import type { EditorStore } from '../core/editorStore'
import { imageGeometry, mmToPts, moveImage, ptsToMm, resizeImage, rotateImage, setImageSize, type Bounds, type Corner } from '../core/images/geometry'
import type { ImageOverlay } from '../core/model'
import { arrowStep, arrowTurn, pointerAngle, type GestureStep } from '../core/overlayGesture'
import type { Tool } from './tools'
import { useOverlayGesture } from './useOverlayGesture'

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
  before: ImageChanges
  corner?: Corner
  rotating: boolean
  center: { x: number; y: number }
  startAngle: number
}
const cornerNames: Record<Corner, string> = { nw: 'oben links', ne: 'oben rechts', sw: 'unten links', se: 'unten rechts' }

export function ImageView({ image, zoom, pageSize, selected, tool, store, onSelect }: Props) {
  const anchor = useRef<HTMLDivElement>(null)
  const active = selected && tool === 'select'
  const commit = (next: ImageChanges, keyboardAction?: ImageKeyboardAction) => {
    const before = imageGeometry(image)
    if (JSON.stringify(before) !== JSON.stringify(next)) store.dispatch(keyboardAction ? nudgeOverlay(image.id, before, next, keyboardAction) : updateOverlay(image.id, before, next))
  }
  const nextGeometry = ({ data, dx, dy, sample }: GestureStep<Gesture>) => {
    if (data.rotating) return rotateImage(data.before, (data.before.rotation ?? 0) + pointerAngle(data.center, sample) - data.startAngle, pageSize, sample.shiftKey)
    return data.corner ? resizeImage(data.before, data.corner, dx, dy, pageSize) : moveImage(data.before, dx, dy, pageSize)
  }
  const gesture = useOverlayGesture<Gesture, ImageChanges>(() => ({ zoom, version: store.getVersion(), tool, active }), nextGeometry, next => commit(next))
  const geometry = gesture.shown ?? imageGeometry(image)
  const onImagePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const corner = event.currentTarget.dataset.corner as Corner | undefined
    const rotating = event.currentTarget.dataset.rotate === 'true'
    if (tool !== 'select') return
    const rect = anchor.current!.getBoundingClientRect()
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    if (!gesture.begin(event, { before: imageGeometry(image), corner, rotating, center, startAngle: pointerAngle(center, event) })) return
    onSelect(image.id)
    ;(corner || rotating ? event.currentTarget : anchor.current)?.focus({ preventScroll: true })
  }
  return (
    <div ref={anchor} className={`image-overlay${active ? ' selected' : ''}`} tabIndex={tool === 'select' ? 0 : -1}
      role="group" aria-label={`Bild: ${image.name}`} data-image-id={image.id}
      style={{ left: geometry.x * zoom, top: (pageSize.height - geometry.y - geometry.height) * zoom,
        width: geometry.width * zoom, height: geometry.height * zoom, transform: `rotate(${geometry.rotation ?? 0}deg)` }}
      onFocus={() => { if (tool === 'select') onSelect(image.id) }}
      onPointerDown={onImagePointerDown} {...gesture.pointer}>
      <img src={image.dataUrl} alt={image.name} draggable={false} />
      {active && (Object.keys(cornerNames) as Corner[]).map(corner => (
        <button key={corner} className={`image-handle ${corner}`} type="button"
          aria-label={`Bild skalieren: ${cornerNames[corner]}`} title="Ziehen zum Skalieren · Pfeiltasten für Feinschritte"
          data-corner={corner} onPointerDown={onImagePointerDown}
          onKeyDown={event => {
            const step = arrowStep(event)
            if (!step) return
            event.preventDefault(); event.stopPropagation()
            commit(resizeImage(imageGeometry(image), corner, step.dx, step.dy, pageSize), `resize:${corner}`)
          }}><span /></button>
      ))}
      {active && <button type="button" className="image-rotate-handle" data-rotate="true"
        aria-label="Bild frei drehen" title="Ziehen zum Drehen · Shift: 15°-Schritte · Pfeiltasten: 1°"
        onPointerDown={onImagePointerDown} onKeyDown={event => {
          const turn = arrowTurn(event)
          if (turn === null) return
          event.preventDefault(); event.stopPropagation()
          commit(rotateImage(imageGeometry(image), (image.rotation ?? 0) + turn, pageSize), 'rotate')
        }}><span><RotationIcon clockwise /></span></button>}
      {active && <ImageOptions image={image} geometry={geometry} anchor={anchor} pageSize={pageSize}
        onChange={commit} onDelete={() => { store.dispatch(removeOverlay(image)); onSelect(null) }} />}
    </div>
  )
}

function ImageOptions({ image, geometry, anchor, pageSize, onChange, onDelete }: {
  image: ImageOverlay; geometry: ImageChanges; anchor: React.RefObject<HTMLDivElement | null>; pageSize: Bounds
  onChange: (next: ImageChanges) => void; onDelete: () => void
}) {
  const toolbar = useRef<HTMLDivElement>(null)
  const reposition = useRef<(() => void) | null>(null)
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
      const above = box.top - height - 64
      const desiredY = above >= top ? above : box.bottom + 12
      element.style.left = `${Math.max(left, Math.min(right - width, box.left + (box.width - width) / 2))}px`
      element.style.top = `${Math.max(top, Math.min(bottom - height, desiredY))}px`
    }
    reposition.current = place
    place()
    const observer = new ResizeObserver(place)
    observer.observe(workspace); observer.observe(element); observer.observe(target)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      reposition.current = null
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])
  // Position updates are lightweight; don't reconnect observers per pointer frame.
  useEffect(() => { reposition.current?.() }, [geometry.x, geometry.y, geometry.width, geometry.height, geometry.rotation])
  return createPortal(
    <div ref={toolbar} className="image-options" role="toolbar" aria-label={`Bildoptionen: ${image.name}`}
      onPointerDown={event => event.stopPropagation()}>
      {(['width', 'height'] as const).map(dimension => <ImageNumberInput key={dimension}
        label={dimension === 'width' ? 'Breite' : 'Höhe'} unit="mm" min={0.1} value={ptsToMm(geometry[dimension])}
        onCommit={value => onChange(setImageSize(imageGeometry(image), dimension, mmToPts(value), pageSize))} />)}
      <ImageNumberInput label="Winkel" unit="°" value={geometry.rotation ?? 0}
        onCommit={value => onChange(rotateImage(imageGeometry(image), value, pageSize))} />
      <div className="image-actions">
      <button type="button" aria-label="Proportionen beibehalten" title="Proportionen beibehalten"
        aria-pressed={image.lockAspectRatio} onClick={() => onChange({ ...imageGeometry(image), lockAspectRatio: !image.lockAspectRatio })}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="m 10 14 4 -4 M 8 16 l -1 1 a 4 4 0 0 1 -6 -6 l 5 -5 a 4 4 0 0 1 6 0 M 16 8 l 1 -1 a 4 4 0 0 1 6 6 l -5 5 a 4 4 0 0 1 -6 0" />
        </svg>
      </button>
      <button type="button" aria-label="90° gegen den Uhrzeigersinn drehen" title="90° gegen den Uhrzeigersinn drehen"
        onClick={() => onChange(rotateImage(imageGeometry(image), (image.rotation ?? 0) - 90, pageSize))}>
        <RotationIcon />
      </button>
      <button type="button" aria-label="90° im Uhrzeigersinn drehen" title="90° im Uhrzeigersinn drehen"
        onClick={() => onChange(rotateImage(imageGeometry(image), (image.rotation ?? 0) + 90, pageSize))}>
        <RotationIcon clockwise />
      </button>
      <button type="button" aria-label="Bild löschen" title="Bild löschen (Entf)" onClick={onDelete}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 4 6 h 16 M 9 6 V 3 h 6 v 3 M 6 6 l 1 15 h 10 l 1 -15 M 10 10 v 7 M 14 10 v 7" />
        </svg>
      </button>
      </div>
    </div>, document.body)
}

function ImageNumberInput({ label, unit, min, value, onCommit }: { label: string; unit: 'mm' | '°'; min?: number; value: number; onCommit: (value: number) => void }) {
  const [editing, setEditing] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  return <label>{label} · {unit}
    <input ref={input} type="number" min={min} step="0.1" aria-label={`${label} in ${unit === 'mm' ? 'Millimetern' : 'Grad'}`}
      value={editing ?? value.toFixed(1)}
      onFocus={event => { cancelled.current = false; setEditing(event.currentTarget.value) }}
      onChange={event => setEditing(event.currentTarget.value)}
      onBlur={() => {
        if (!cancelled.current && editing !== null && editing.trim() !== '') onCommit(Number(editing))
        setEditing(null)
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); input.current?.blur() }
        if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setEditing(null); input.current?.blur() }
      }} />
  </label>
}

export function RotationIcon({ clockwise = false }: { clockwise?: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d={clockwise ? 'M 21 10 a 9 9 0 1 0 -1.5 7 M 21 4 v 6 h -6' : 'M 3 10 a 9 9 0 1 1 1.5 7 M 3 4 v 6 h 6'} />
  </svg>
}
