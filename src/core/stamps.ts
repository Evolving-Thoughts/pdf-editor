// Reusable stamps (T23). A stamp is a text picture placed as an image overlay, so it
// moves, scales, rotates, exports and persists like every other image. Its date is
// part of the picture and can never change later. It proves nothing about identity.
import { createId, type ImageOverlay } from './model'

export interface StampDesign { id: string; text: string; color: string; dated: boolean }

export const STAMP_COLORS = ['#b3261e', '#1f6a3a', '#2455c7', '#333333']

export const STAMP_TEMPLATES: StampDesign[] = [
  { id: 'erledigt', text: 'ERLEDIGT', color: '#1f6a3a', dated: false },
  { id: 'geprueft', text: 'GEPRÜFT', color: '#2455c7', dated: false },
  { id: 'entwurf', text: 'ENTWURF', color: '#b3261e', dated: false },
  { id: 'vertraulich', text: 'VERTRAULICH', color: '#b3261e', dated: false },
  { id: 'kopie', text: 'KOPIE', color: '#333333', dated: false },
  { id: 'datum', text: 'ERLEDIGT AM', color: '#333333', dated: true },
]

const MAX_CUSTOM_STAMPS = 20
const MAX_STAMP_TEXT = 40
const STORAGE_KEY = 'pdf-editor-stamps'
const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/

/** From a date input's yyyy-mm-dd. Parsing by hand avoids any time zone shift. */
export function formatStampDate(value: string): string {
  const match = isoDate.exec(value)
  if (!match) throw new Error('Bitte ein gültiges Datum wählen.')
  return `${match[3]}.${match[2]}.${match[1]}`
}

export function todayValue(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function stampLines(design: StampDesign, date: string): string[] {
  return design.dated ? [design.text, formatStampDate(date)] : [design.text]
}

/** One stamp text, ready to draw. Refuses what would make an unusable stamp. */
export function customStamp(text: string, color: string, dated: boolean): StampDesign {
  const clean = text.trim().replace(/\s+/g, ' ')
  if (!clean) throw new Error('Bitte einen Stempeltext eingeben.')
  if (clean.length > MAX_STAMP_TEXT) throw new Error(`Ein Stempel darf höchstens ${MAX_STAMP_TEXT} Zeichen haben.`)
  if (!STAMP_COLORS.includes(color)) throw new Error('Diese Farbe steht nicht zur Auswahl.')
  return { id: createId(), text: clean, color, dated }
}

const isDesign = (value: unknown): value is StampDesign => {
  const stamp = value as StampDesign
  return !!stamp && typeof stamp.id === 'string' && typeof stamp.text === 'string' && stamp.text.length > 0 && stamp.text.length <= MAX_STAMP_TEXT &&
    STAMP_COLORS.includes(stamp.color) && typeof stamp.dated === 'boolean'
}

/** Own stamps stay in this browser. Storage can be blocked, which only costs the list. */
export function loadCustomStamps(storage: Pick<Storage, 'getItem'> | undefined): StampDesign[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isDesign).slice(0, MAX_CUSTOM_STAMPS) : []
  } catch {
    return []
  }
}

export function saveCustomStamps(storage: Pick<Storage, 'setItem'> | undefined, stamps: StampDesign[]): boolean {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(stamps.slice(0, MAX_CUSTOM_STAMPS)))
    return !!storage
  } catch {
    return false
  }
}

/** Width in page points for a picture, kept inside the page and centered on the click. */
export function stampGeometry(pixelWidth: number, pixelHeight: number, point: { x: number; y: number }, page: { width: number; height: number }) {
  const scale = Math.min(0.25, (page.width * 0.6) / pixelWidth, (page.height * 0.3) / pixelHeight)
  const width = pixelWidth * scale, height = pixelHeight * scale
  return {
    x: Math.max(0, Math.min(page.width - width, point.x - width / 2)),
    y: Math.max(0, Math.min(page.height - height, point.y - height / 2)),
    width,
    height,
  }
}

export function stampOverlay(picture: { dataUrl: string; pixelWidth: number; pixelHeight: number }, text: string, pageId: string, point: { x: number; y: number }, page: { width: number; height: number }): ImageOverlay {
  return {
    kind: 'image', id: createId(), pageId, name: `Stempel: ${text}`, lockAspectRatio: true, rotation: 0,
    ...picture, ...stampGeometry(picture.pixelWidth, picture.pixelHeight, point, page),
  }
}
