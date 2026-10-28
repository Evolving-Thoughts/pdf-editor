import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { SourcePageGeometry } from '../core/pdf/loadPdf'
import type { EditModel, LiveFont } from '../core/sourceText/editModel'
import { cssFill } from '../core/sourceText/editModel'
import { caretStops, hitOffset, nearestOffset, paintedGlyphs, selectionRects } from '../core/sourceText/inlineLayout'
import type { InlineView } from '../core/sourceText/inlineLayout'

export interface TextRange { start: number; end: number; backward?: boolean }
interface Props {
  model: EditModel
  view: InlineView | null
  text: string
  range: TextRange
  size: SourcePageGeometry
  canvas: HTMLCanvasElement | null
  disabled?: boolean
  onChange: (text: string, range: TextRange) => void
  onRange: (range: TextRange) => void
  onSubmit: () => void
  onCancel: () => void
}
type Box = { left: number; right: number; bottom: number; top: number }

/** Most frequent colour inside page rectangles of the rendered canvas. */
function background(canvas: HTMLCanvasElement | null, rects: Box[], size: SourcePageGeometry) {
  const ctx = canvas?.getContext('2d', { willReadFrequently: true })
  if (!canvas || !ctx || !canvas.width) return '#fff'
  const t = size.sourceTransform, sx = canvas.width / size.width, sy = canvas.height / size.height
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor((r.left + t[4]) * sx)), x1 = Math.min(canvas.width, Math.ceil((r.right + t[4]) * sx))
    const y0 = Math.max(0, Math.floor((t[5] - r.top) * sy)), y1 = Math.min(canvas.height, Math.ceil((t[5] - r.bottom) * sy))
    if (x1 <= x0 || y1 <= y0) continue
    const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data, step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)))
    for (let y = 0; y < y1 - y0; y += step)
      for (let x = 0; x < x1 - x0; x += step) {
        const i = (y * (x1 - x0) + x) * 4, key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
        const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
        c.n++; c.r += data[i]; c.g += data[i + 1]; c.b += data[i + 2]
        counts.set(key, c)
      }
  }
  let best: { n: number; r: number; g: number; b: number } | undefined
  for (const c of counts.values()) if (!best || c.n > best.n) best = c
  return best ? `rgb(${Math.round(best.r / best.n)},${Math.round(best.g / best.n)},${Math.round(best.b / best.n)})` : '#fff'
}
const weight = (name: string) => (/bold|black|heavy|semibold|demi/i.test(name) ? 'bold' : 'normal')
const slant = (name: string) => (/italic|oblique/i.test(name) ? 'italic' : 'normal')

/** Edits a proved paragraph in place: the original lines are masked with the
 * page background and the live layout is drawn with the font's own outlines
 * (or a CSS fallback with the same advances). A hidden textarea carries
 * input, IME and clipboard; caret and selection are drawn here. */
export function InlineSourceEditor({ model, view, text, range, size, canvas, disabled, onChange, onRange, onSubmit, onCancel }: Props) {
  const area = useRef<HTMLTextAreaElement>(null), svg = useRef<SVGSVGElement>(null)
  const goal = useRef<number | null>(null), drag = useRef<number | null>(null)
  const t = size.sourceTransform
  const X = (x: number) => x + t[4], Y = (y: number) => t[5] - y
  const fill = useMemo(() => background(canvas, model.slots, size), [canvas, model.slots, size])
  const stops = useMemo(() => (view ? caretStops(view) : null), [view])
  const focus = range.backward ? range.start : range.end
  // Keep the hidden textarea's selection equal to the drawn one.
  useLayoutEffect(() => {
    const a = area.current
    if (!a || a.value !== text) return
    if (a.selectionStart !== range.start || a.selectionEnd !== range.end) a.setSelectionRange(range.start, range.end, range.backward ? 'backward' : 'forward')
  }, [text, range])
  useEffect(() => { if (!disabled) area.current?.focus({ preventScroll: true }) }, [disabled, model.id])
  const lines = view?.lines ?? []
  const lastBaseline = lines.at(-1)?.baseline ?? model.lines.at(-1)!.baseline
  const frame: Box = {
    left: Math.min(...model.slots.map(s => s.left), ...lines.map(l => l.left)) - 2,
    right: Math.max(...model.slots.map(s => s.right), model.right, ...lines.map(l => l.extent)) + 2,
    bottom: Math.min(...model.slots.map(s => s.bottom), lastBaseline - 0.3 * model.size) - 2,
    top: Math.max(...model.slots.map(s => s.top)) + 2,
  }
  const pagePoint = (event: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect()
    return { x: ((event.clientX - r.left) / r.width) * size.width - t[4], y: t[5] - ((event.clientY - r.top) / r.height) * size.height }
  }
  function down(event: ReactPointerEvent<SVGRectElement>) {
    if (!view || !stops || disabled) return
    event.preventDefault()
    const p = pagePoint(event), o = hitOffset(view, stops, p.x, p.y, model.size)
    const anchor = event.shiftKey ? (range.backward ? range.end : range.start) : o
    drag.current = anchor
    goal.current = null
    event.currentTarget.setPointerCapture(event.pointerId)
    onRange(o < anchor ? { start: o, end: anchor, backward: true } : { start: anchor, end: o })
    area.current?.focus({ preventScroll: true })
  }
  function move(event: ReactPointerEvent<SVGRectElement>) {
    if (drag.current === null || !view || !stops) return
    const p = pagePoint(event), o = hitOffset(view, stops, p.x, p.y, model.size), a = drag.current
    onRange(o < a ? { start: o, end: a, backward: true } : { start: a, end: o })
  }
  function key(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') { event.preventDefault(); onCancel(); return }
    if (event.key === 'Enter') { event.preventDefault(); if (event.ctrlKey || event.metaKey) onSubmit(); return }
    if (!view || !stops || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || event.altKey) return
    if ((event.ctrlKey || event.metaKey) && (event.key === 'Home' || event.key === 'End')) return // native: text start/end
    event.preventDefault()
    const here = stops[focus], line = here.line
    let target: number
    if (event.key === 'Home') target = view.offsets[view.lines[line].from]
    else if (event.key === 'End') {
      const l = view.lines[line], end = view.offsets[l.to]
      target = line < view.lines.length - 1 && view.glyphs[l.to - 1].char === ' ' ? end - 1 : end
    } else {
      const x = (goal.current ??= here.x), next = line + (event.key === 'ArrowUp' ? -1 : 1)
      target = next < 0 ? 0 : next >= view.lines.length ? text.length : nearestOffset(view, stops, next, x)
    }
    if (event.key === 'Home' || event.key === 'End') goal.current = null
    const anchor = event.shiftKey ? (range.backward ? range.end : range.start) : target
    onRange(target < anchor ? { start: target, end: anchor, backward: true } : { start: anchor, end: target })
  }
  const caret = stops?.[focus], caretLine = caret && lines[caret.line]
  const textareaAt = caretLine ? { left: X(caret.x), top: Y(caretLine.baseline + model.size) } : { left: X(frame.left), top: Y(frame.top) }
  const pct = (v: number, axis: 'x' | 'y') => `${(v / (axis === 'x' ? size.width : size.height)) * 100}%`
  return <div className="source-inline" data-block-id={model.id}>
    <svg ref={svg} className="source-inline-svg" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
      {model.slots.map((s, i) => <rect key={i} x={X(s.left) - 0.6} y={Y(s.top) - 0.6} width={s.right - s.left + 1.2} height={s.top - s.bottom + 1.2} fill={fill} />)}
      {view && [...view.overflow].map(i => <rect key={`o${i}`} className="source-inline-overflow" x={X(lines[i].left)} y={Y(lines[i].baseline + 0.9 * model.size)} width={Math.max(1, lines[i].extent - lines[i].left)} height={1.15 * model.size} />)}
      {view && stops && selectionRects(view, stops, range.start, range.end, model.size).map((r, i) => <rect key={`s${i}`} className="source-inline-selection" x={X(r.left)} y={Y(r.top)} width={r.right - r.left} height={r.top - r.bottom} />)}
      {view && paintedGlyphs(view).map(p => {
        const g = p.glyph, font = g.font as LiveFont, x = X(p.x), y = Y(p.baseline), bad = view.missing.has(p.k), over = view.overflow.has(p.line)
        if (bad) return <rect key={p.k} className="source-inline-missing" x={x} y={y - 0.7 * g.size} width={Math.max(g.width, 0.3 * g.size)} height={0.8 * g.size} />
        const color = over ? '#c62828' : cssFill(g.fill), path = font.paths?.get(g.code)
        if (path) return <path key={p.k} d={path} fill={color} transform={`translate(${x} ${y}) scale(${g.size / 1000} ${-g.size / 1000})`} />
        return <text key={p.k} x={x} y={y} fontSize={g.size} fill={color} fontFamily={font.family ?? 'sans-serif'} fontWeight={weight(font.name)} fontStyle={slant(font.name)} textLength={g.width > 0 ? g.width : undefined} lengthAdjust="spacingAndGlyphs">{p.char}</text>
      })}
      {caret && caretLine && range.start === range.end && !disabled && <line key={`${focus}:${text.length}`} className="source-inline-caret" x1={X(caret.x)} x2={X(caret.x)} y1={Y(caretLine.baseline - 0.22 * model.size)} y2={Y(caretLine.baseline + 0.88 * model.size)} />}
      <rect className="source-inline-frame" x={X(frame.left)} y={Y(frame.top)} width={frame.right - frame.left} height={frame.top - frame.bottom} onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} />
    </svg>
    <textarea ref={area} className="source-inline-input" aria-label={`Absatz bearbeiten: ${model.text.slice(0, 80)}`} aria-describedby="source-fit" spellCheck={false} autoCapitalize="off" autoComplete="off" maxLength={4096} disabled={disabled} value={text} style={{ left: pct(textareaAt.left, 'x'), top: pct(textareaAt.top, 'y') }}
      onChange={event => {
        const a = event.currentTarget, value = a.value.replace(/[\r\n\t]/g, ' ')
        goal.current = null
        onChange(value, { start: a.selectionStart, end: a.selectionEnd, backward: a.selectionDirection === 'backward' })
      }}
      onSelect={event => {
        const a = event.currentTarget
        if (a.value !== text || drag.current !== null) return
        if (a.selectionStart !== range.start || a.selectionEnd !== range.end) { goal.current = null; onRange({ start: a.selectionStart, end: a.selectionEnd, backward: a.selectionDirection === 'backward' }) }
      }}
      onKeyDown={key} />
  </div>
}
