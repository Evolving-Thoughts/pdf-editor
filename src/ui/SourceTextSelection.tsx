import { useId, useRef } from 'react'
import type { SimpleSourceRun } from '../core/sourceText/simplePdf'
import type { SourcePageGeometry } from '../core/pdf/loadPdf'
import type { SearchFragment } from '../core/search'
import { directSelection } from '../core/sourceText/directSelection'
import type { DirectSelection } from '../core/sourceText/directSelection'

interface Props {
  runs: SimpleSourceRun[]
  size: SourcePageGeometry
  fragments: SearchFragment[]
  selection: DirectSelection | null
  onSelect: (value: DirectSelection) => void
  onReject: (text: string) => void
  /** Blocks with an inline editor model; a click opens it at that point. */
  blocks?: ReadonlySet<string>
  /** Block currently edited inline (drawn by the editor instead). */
  editing?: string
  onBlock?: (id: string, from?: { x: number; y: number }, to?: { x: number; y: number }) => void
}

export function SourceTextSelection({ runs, size, fragments, selection, onSelect, onReject, blocks, editing, onBlock }: Props) {
  const lastUp = useRef<{ x: number; y: number } | undefined>(undefined)
  const mask = useId().replace(/:/g, ''), dragged = useRef(false), layer = useRef<HTMLDivElement>(null), downAt = useRef<{ x: number; y: number } | undefined>(undefined)
  const transform = size.sourceTransform
  const horizontal = Math.abs(transform[0] - 1) < 1e-8 && Math.abs(transform[1]) < 1e-8 && Math.abs(transform[2]) < 1e-8 && Math.abs(transform[3] + 1) < 1e-8
  const position = (run: SimpleSourceRun) => ({ x: run.x + transform[4], y: -run.baseline + transform[5] })
  const percent = (x: number, axis = 'x') => `${x / (axis === 'x' ? size.width : size.height) * 100}%`
  // Bound DOM work separately from the worker's PDF limits. Unshown runs do not
  // become editable through extraction or through a cross-line native selection.
  let budget = 40000
  const withinBudget: SimpleSourceRun[] = []
  for (const run of runs) {
    if (!horizontal || !run.selection || run.text.length > budget) continue
    budget -= run.text.length
    withinBudget.push(run)
  }
  const included = new Set(withinBudget.map(run => run.id))
  const incomplete = new Set(runs.filter(run => run.selection?.groupId && !included.has(run.id)).map(run => run.selection!.groupId))
  const selectable = withinBudget.filter(run => !run.selection?.groupId || !incomplete.has(run.selection.groupId))
  const boxes = selectable.map(run => {
    const p = position(run), chars = run.selection!.characters
    const left = Math.min(0, ...chars.map(c => c.offset)), right = Math.max(run.width, ...chars.map(c => c.offset + c.width))
    return { run, x: p.x + left, y: p.y - run.fontSize * .95, width: right - left, height: run.fontSize * 1.25 }
  })
  const unknown = fragments.filter(fragment => !fragment.quad.every(p => boxes.some(b => p.x >= b.x - 1 && p.x <= b.x + b.width + 1 && p.y >= b.y - 1 && p.y <= b.y + b.height + 1)))
  const selectedGroup = selection && runs.find(run => run.id === selection.runId)?.selection?.groupId
  let prefix = 0
  const prefixes = new Map<string, number>()
  if (selectedGroup) for (const run of runs) {
    if (run.selection?.groupId !== selectedGroup) continue
    prefixes.set(run.id, prefix)
    prefix += run.text.length + (run.paragraph?.separator ?? ' ').length
  }
  // One outline per proved paragraph/source block; its member runs carry the
  // selectable characters but no frames of their own.
  const groups = new Map<string, typeof boxes>()
  for (const b of boxes) {
    const id = b.run.selection?.groupId
    if (id) groups.set(id, [...(groups.get(id) ?? []), b])
  }
  // Keep reading order: a block renders where its first member appears.
  const order = boxes.filter(b => { const id = b.run.selection?.groupId; return !id || groups.get(id)![0] === b })
  // Client point → PDF page space (horizontal pages only, see `horizontal`).
  const pagePoint = (event: { clientX: number; clientY: number }) => {
    const r = layer.current!.getBoundingClientRect()
    return { x: ((event.clientX - r.left) / r.width) * size.width - transform[4], y: transform[5] - ((event.clientY - r.top) / r.height) * size.height }
  }
  const inline = (run: SimpleSourceRun) => { const id = run.selection?.groupId; return id && run.paragraph?.automatic && blocks?.has(id) && onBlock ? id : undefined }
  function choose(run: SimpleSourceRun, at?: { x: number; y: number }) {
    const id = inline(run)
    if (id) { onBlock!(id, at); return }
    const members = run.paragraph?.automatic && run.selection?.groupId ? groups.get(run.selection.groupId) ?? [] : []
    const value = members.length
      ? directSelection(selectable, members[0].run.id, 0, members.at(-1)!.run.id)
      : directSelection(selectable, run.id, 0)
    if (value) onSelect(value)
  }
  function finish() {
    const native = window.getSelection()
    if (!native || native.isCollapsed) { dragged.current = false; return }
    dragged.current = true
    const range = native.getRangeAt(0)
    const element = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-source-id]')
    const start = element(range.startContainer), end = element(range.endContainer)
    const startRun = start && runs.find(r => r.id === start.dataset.sourceId), endRun = end && runs.find(r => r.id === end.dataset.sourceId)
    const id = startRun && inline(startRun)
    if (id && endRun && inline(endRun) === id) {
      native.removeAllRanges()
      onBlock!(id, downAt.current, lastUp.current)
      return
    }
    if (!start || !end) {
      native.removeAllRanges()
      onReject('Bitte nur innerhalb eines unterstützten Bereichs markieren. Nicht unterstützte und unabhängige Textfragmente dürfen nicht gemeinsam geändert werden.')
      return
    }
    const offset = (el: HTMLElement, node: Node, n: number) => {
      const part = document.createRange()
      part.selectNodeContents(el); part.setEnd(node, n)
      return part.toString().length
    }
    const value = directSelection(selectable, start.dataset.sourceId!, offset(start, range.startContainer, range.startOffset), end.dataset.sourceId!, offset(end, range.endContainer, range.endOffset))
    native.removeAllRanges()
    if (value) onSelect(value)
    else onReject('Diese Auswahl überschreitet unabhängig positionierte oder nicht unterstützte Textbereiche. Bitte eine einzelne unterstützte Stelle markieren.')
  }
  return <div ref={layer} className="source-selection-layer" data-analysis-state="ready" onPointerDown={event => { downAt.current = pagePoint(event) }} onPointerUp={event => { lastUp.current = pagePoint(event); finish() }}>
    <svg className="source-support-mask" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs><mask id={mask}><rect width={size.width} height={size.height} fill="black" />
        {fragments.map((f, i) => <polygon key={i} points={f.quad.map(p => `${p.x},${p.y}`).join(' ')} fill="white" />)}
        {boxes.map(b => <rect key={b.run.id} x={b.x - 1} y={b.y - 1} width={b.width + 2} height={b.height + 2} fill="black" />)}
      </mask></defs>
      <rect width={size.width} height={size.height} fill="white" opacity=".65" mask={`url(#${mask})`} />
    </svg>
    {unknown.map((f, i) => {
      const x = Math.min(...f.quad.map(p => p.x)), y = Math.min(...f.quad.map(p => p.y))
      const w = Math.max(...f.quad.map(p => p.x)) - x, h = Math.max(...f.quad.map(p => p.y)) - y
      return <button key={i} className="source-unknown-hit" style={{ left: percent(x), top: percent(y, 'y'), width: percent(w), height: percent(h, 'y') }} aria-label={`Unterstützung nicht nachgewiesen: ${f.text.slice(0, 80)}`} onClick={() => onReject('Dieser Bereich ist nicht als sicher markierbarer Originaltext nachgewiesen. Schriftkodierung, Ligaturen, Textstruktur oder das Markierungslimit können die Ursache sein. Er bleibt unverändert.')} />
    })}
    {order.map(first => {
      const id = first.run.selection?.groupId
      if (!id) return hit(first, true)
      if (id === editing) return null
      const members = groups.get(id)!
      const x = Math.min(...members.map(b => b.x)), y = Math.min(...members.map(b => b.y))
      const width = Math.max(...members.map(b => b.x + b.width)) - x, height = Math.max(...members.map(b => b.y + b.height)) - y
      const picked = selectedGroup === id
      return <div key={id} className="source-block" data-block-id={id}>
        <div className={`source-block-outline ${picked ? 'source-picked' : ''}`} aria-hidden="true" style={{ left: percent(x), top: percent(y, 'y'), width: percent(width), height: percent(height, 'y') }} />
        {members.map((b, i) => hit(b, i === 0))}
      </div>
    })}
  </div>
  function hit(b: typeof boxes[number], primary: boolean) {
    const run = b.run, active = selection?.runId === run.id
    const grouped = !!run.selection?.groupId, automatic = grouped && !!run.paragraph?.automatic
    const group = selection?.requiresReflow && grouped && run.selection!.groupId === selectedGroup
    const label = automatic ? `${run.paragraph!.lineCount > 1 ? 'Absatz' : 'Zeile'} auswählen: ${run.paragraph!.text.slice(0, 120)}` : `Textstelle auswählen: ${run.text}`
    const title = automatic ? 'Zusammenhängender Absatz · klicken wählt den ganzen Block, Markieren wählt einen Teil' : run.paragraph ? 'Unterstützter Absatz · markieren oder mit Enter auswählen' : 'Nur dieses Textfragment unterstützt · markieren oder mit Enter auswählen'
    const focusable = !automatic || primary
    return <div key={run.id} className={`source-run-hit ${grouped ? 'source-member' : ''} ${run.paragraph ? 'source-paragraph' : 'source-fragment'} ${!grouped && active ? 'source-picked' : ''}`} data-source-id={run.id} role={focusable ? 'button' : undefined} aria-hidden={focusable ? undefined : true} tabIndex={focusable ? 0 : -1} aria-label={focusable ? label : undefined} title={title} style={{ left: percent(b.x), top: percent(b.y, 'y'), width: percent(b.width), height: percent(b.height, 'y') }} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(run) }
    }} onClick={event => {
      if (dragged.current) { dragged.current = false; return }
      choose(run, event.detail ? pagePoint(event) : undefined)
    }}>
      {Array.from(run.text).map((char, i) => {
        const c = run.selection!.characters[i], at = (prefixes.get(run.id) ?? 0) + i
        const picked = group ? at >= selection!.paragraphFrom! && at < selection!.paragraphTo! : active && i >= selection!.from && i < selection!.to
        return <span key={i} className={picked ? 'source-char-picked' : ''} style={{ position: 'absolute', left: `${(position(run).x + c.offset - b.x) / b.width * 100}%`, width: `${c.width / b.width * 100}%`, height: '100%', fontSize: `${run.fontSize / b.height * 100}cqh` }}>{char}</span>
      })}
    </div>
  }
}
