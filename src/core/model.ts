import type { Redaction } from './redactions'
import type { FormValues } from './forms'
import type { DocumentPage, PageSource } from './pages'
import type { MetadataEdit } from './pdf/metadata'
// Domain model for overlay elements. Pure data, no framework, no PDF libraries.

/** 'zapfdingbats' = symbol font; the text then holds Unicode symbols (✓, ■, …). */
export type OverlayFont = 'helvetica' | 'times' | 'courier' | 'noto-sans' | 'noto-serif' | 'carlito' | 'lato' | 'eb-garamond' | 'roboto-mono' | 'caveat' | 'zapfdingbats'

/** Clipping polygons in element-local coordinates; strokes use page coordinates. */
export interface OverlayClipping { clips?: StrokePoint[][] }
export interface Textbox extends OverlayClipping {
  /** Clockwise rotation of the text baseline; absent in older drafts means zero. */
  rotation?: number
  id: string
  /** 0-based page index. */
  pageIndex: number
  /** Position in PDF points, origin bottom-left; y is the text baseline. */
  x: number
  y: number
  text: string
  font: OverlayFont
  fontSize: number
  bold: boolean
  italic: boolean
  /** Drawn as a line under the text (not a font variant). */
  underline: boolean
  /** Set on page labels (T22): the position they replace when applied again. */
  labelGroup?: string
}

export interface StrokePoint {
  /** Displayed PDF points, origin bottom-left of the visible, rotated page. */
  x: number
  y: number
}

export interface Stroke extends OverlayClipping {
  id: string
  /** 0-based page index. */
  pageIndex: number
  /** Ordered points relative to the visible, rotated page (bottom-left origin). */
  points: StrokePoint[]
  /** Hex color such as #111111. */
  color: string
  /** Stroke width in PDF points. */
  width: number
}

/** Immutable, locally decoded image source; no expiring blob URL in drafts. */
export interface ImageOverlay extends OverlayClipping {
  kind: 'image'
  id: string
  pageIndex: number
  /** Displayed page points, bottom-left origin, like strokes. */
  x: number
  y: number
  width: number
  height: number
  /** Clockwise degrees around the rectangle center; missing in older drafts means 0°. */
  rotation?: number
  lockAspectRatio: boolean
  name: string
  pixelWidth: number
  pixelHeight: number
  /** PNG normalized at import, including JPEG EXIF orientation. */
  dataUrl: string
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'marker'

/** Editable vector shape in displayed page points, with a clockwise center rotation. */
export interface ShapeOverlay extends OverlayClipping {
  kind: 'shape'
  shape: ShapeKind
  id: string
  pageIndex: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  fill: string | null
  strokeColor: string | null
  strokeWidth: number
  /** Endpoint direction within the local rectangle (lines/arrows only). */
  flipX?: boolean
  flipY?: boolean
  /** Immutable normalized local points (textmarker only), y-up fractions. */
  markerPoints?: StrokePoint[]
}

export type Overlay = Textbox | Stroke | ImageOverlay | ShapeOverlay

export function isShape(overlay: Overlay): overlay is ShapeOverlay {
  return 'kind' in overlay && overlay.kind === 'shape'
}

export type MarkerOverlay = ShapeOverlay & { shape: 'marker'; markerPoints: StrokePoint[] }

export function isMarker(overlay: Overlay): overlay is MarkerOverlay {
  return isShape(overlay) && overlay.shape === 'marker' && Array.isArray(overlay.markerPoints)
}

export function isImage(overlay: Overlay): overlay is ImageOverlay {
  return 'kind' in overlay && overlay.kind === 'image'
}

export function isStroke(overlay: Overlay): overlay is Stroke {
  return 'points' in overlay
}

export function isTextbox(overlay: Overlay): overlay is Textbox {
  return 'text' in overlay
}

export function cloneOverlay(overlay: Overlay): Overlay {
  if (overlay.clips) overlay = { ...overlay, clips: overlay.clips.map(polygon => polygon.map(point => ({ ...point }))) }
  if (isShape(overlay) && overlay.markerPoints) return { ...overlay, markerPoints: overlay.markerPoints.map(point => ({ ...point })) }
  if (isStroke(overlay)) return { ...overlay, points: overlay.points.map((point) => ({ ...point })) }
  return { ...overlay }
}

export interface EditorState {
  /** Keep secure export enabled even after all rasterized pages are deleted. */
  redactionApplied?: boolean
  redactions?: Redaction[]
  formValues?: FormValues
  pages?: DocumentPage[]
  pageSources?: PageSource[]
  overlays: Overlay[]
  /** Decisions about document info; the export writes them. */
  metadata?: MetadataEdit
}

let counter = 0
export function createId(): string {
  counter += 1
  return `ov-${Date.now().toString(36)}-${counter}`
}

/** Mutates one overlay in place; used by commands and previews alike. */
export function patchOverlay(state: EditorState, id: string, changes: Partial<Textbox>): void {
  const box = state.overlays.find((o) => o.id === id)
  if (box && isTextbox(box)) Object.assign(box, changes)
}
