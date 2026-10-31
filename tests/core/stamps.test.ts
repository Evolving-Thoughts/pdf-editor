import { expect, test } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { addOverlay, CommandStack } from '../../src/core/commands'
import { exportPdf } from './exportFixture'
import { customStamp, formatStampDate, loadCustomStamps, saveCustomStamps, STAMP_TEMPLATES, stampGeometry, stampLines, stampOverlay, todayValue } from '../../src/core/stamps'
import type { EditorState } from '../../src/core/model'
import { PNG_DATA_URL } from '../imageFixtures.js'

const picture = { dataUrl: PNG_DATA_URL, pixelWidth: 400, pixelHeight: 120 }

function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, data }
}

test('the start set holds the agreed stamps and one dated stamp', () => {
  expect(STAMP_TEMPLATES.map(stamp => stamp.text)).toEqual(expect.arrayContaining(['ERLEDIGT', 'GEPRÜFT', 'ENTWURF', 'VERTRAULICH', 'KOPIE']))
  expect(STAMP_TEMPLATES.filter(stamp => stamp.dated)).toHaveLength(1)
})

test('a dated stamp shows the chosen date and not today', () => {
  const dated = STAMP_TEMPLATES.find(stamp => stamp.dated)!
  expect(stampLines(dated, '2026-03-05')).toEqual([dated.text, '05.03.2026'])
})

test('the date comes straight from the input, without a time zone shift', () => {
  expect(formatStampDate('2026-01-01')).toBe('01.01.2026')
  expect(formatStampDate('2026-12-31')).toBe('31.12.2026')
  expect(() => formatStampDate('')).toThrow(/gültiges Datum/)
})

test('today is the local date in the format of a date input', () => {
  expect(todayValue(new Date(2026, 0, 9, 23, 30))).toBe('2026-01-09')
})

test('a stamp without a date needs none', () => {
  expect(stampLines(STAMP_TEMPLATES[0], '')).toEqual(['ERLEDIGT'])
})

test('own stamps are cleaned up and checked', () => {
  expect(customStamp('  Bezahlt   am ', '#b3261e', true)).toMatchObject({ text: 'Bezahlt am', dated: true })
  expect(() => customStamp('   ', '#b3261e', false)).toThrow(/Stempeltext/)
  expect(() => customStamp('x'.repeat(41), '#b3261e', false)).toThrow(/40 Zeichen/)
  expect(() => customStamp('Test', 'url(evil)', false)).toThrow(/Farbe/)
})

test('own stamps come back from storage', () => {
  const storage = memoryStorage(), stamp = customStamp('Bezahlt', '#1f6a3a', false)
  expect(saveCustomStamps(storage, [stamp])).toBe(true)
  expect(loadCustomStamps(storage)).toEqual([stamp])
})

test('damaged or foreign storage content is ignored', () => {
  const storage = memoryStorage()
  storage.setItem('pdf-editor-stamps', 'kein json')
  expect(loadCustomStamps(storage)).toEqual([])
  storage.setItem('pdf-editor-stamps', JSON.stringify([{ id: 'a', text: 'Gut', color: '#333333', dated: false }, { id: 'b', text: 'Böse', color: 'red', dated: false }, 7]))
  expect(loadCustomStamps(storage).map(stamp => stamp.id)).toEqual(['a'])
})

test('blocked storage costs only the list', () => {
  const blocked = { getItem: () => { throw new Error('verboten') }, setItem: () => { throw new Error('verboten') } }
  expect(loadCustomStamps(blocked)).toEqual([])
  expect(saveCustomStamps(blocked, [])).toBe(false)
  expect(loadCustomStamps(undefined)).toEqual([])
})

test('a stamp is centered on the click and keeps its proportions', () => {
  const box = stampGeometry(400, 120, { x: 300, y: 400 }, { width: 600, height: 800 })
  expect(box.width / box.height).toBeCloseTo(400 / 120)
  expect(box.x + box.width / 2).toBeCloseTo(300)
  expect(box.y + box.height / 2).toBeCloseTo(400)
})

test('a click at the edge stays on the page, also on tiny pages', () => {
  for (const page of [{ width: 600, height: 800 }, { width: 120, height: 60 }]) {
    const box = stampGeometry(400, 120, { x: page.width, y: 0 }, page)
    expect(box.x + box.width).toBeLessThanOrEqual(page.width + 1e-9)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.width).toBeLessThanOrEqual(page.width)
  }
})

test('placing twice gives two independent overlays, undone one at a time', () => {
  const state: EditorState = { overlays: [] }, stack = new CommandStack(state)
  const page = { width: 600, height: 800 }
  stack.execute(addOverlay(stampOverlay(picture, 'ERLEDIGT', 'p0', { x: 100, y: 100 }, page)))
  stack.execute(addOverlay(stampOverlay(picture, 'ERLEDIGT', 'p1', { x: 300, y: 300 }, page)))
  expect(new Set(state.overlays.map(overlay => overlay.id)).size).toBe(2)
  stack.undo()
  expect(state.overlays).toHaveLength(1)
  stack.redo()
  expect(state.overlays).toHaveLength(2)
})

test('a stamp is marked as such and exports as a picture on differently sized pages', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([300, 300])
  doc.addPage([800, 400])
  const overlays = [
    stampOverlay(picture, 'ERLEDIGT', 'p0', { x: 100, y: 100 }, { width: 300, height: 300 }),
    stampOverlay(picture, 'ERLEDIGT', 'p1', { x: 100, y: 100 }, { width: 800, height: 400 }),
  ]
  expect(overlays[0].name).toBe('Stempel: ERLEDIGT')
  expect(overlays[0].lockAspectRatio).toBe(true)
  const output = await PDFDocument.load(await exportPdf(await doc.save(), overlays))
  expect(output.getPageCount()).toBe(2)
})
