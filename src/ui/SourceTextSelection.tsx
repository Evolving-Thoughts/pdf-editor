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
}

export function SourceTextSelection({ runs, size, fragments, selection, onSelect, onReject }: Props) {
  const mask = useId().replace(/:/g, ''), dragged = useRef(false)
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
    prefix += run.text.length + 1
  }
  function choose(run: SimpleSourceRun) {
    const value = directSelection(selectable, run.id, 0)
    if (value) onSelect(value)
  }
  function finish() {
    const native = window.getSelection()
    if (!native || native.isCollapsed) { dragged.current = false; return }
    dragged.current = true
    const range = native.getRangeAt(0)
    const element = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-source-id]')
    const start = element(range.startContainer), end = element(range.endContainer)
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
  return <div className="source-selection-layer" data-analysis-state="ready" onPointerUp={finish}>
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
    {boxes.map(b => {
      const run = b.run, active = selection?.runId === run.id
      const group = selection?.requiresReflow && run.selection?.groupId && run.selection.groupId === selectedGroup
      return <div key={run.id} className={`source-run-hit ${run.paragraph ? 'source-paragraph' : 'source-fragment'} ${active || group ? 'source-picked' : ''}`} data-source-id={run.id} role="button" tabIndex={0} aria-label={`Textstelle auswählen: ${run.text}`} title={run.paragraph ? 'Unterstützter Absatz · markieren oder mit Enter auswählen' : 'Nur dieses Textfragment unterstützt · markieren oder mit Enter auswählen'} style={{ left: percent(b.x), top: percent(b.y, 'y'), width: percent(b.width), height: percent(b.height, 'y') }} onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(run) }
      }} onClick={() => {
        if (dragged.current) { dragged.current = false; return }
        choose(run)
      }}>
        {Array.from(run.text).map((char, i) => {
          const c = run.selection!.characters[i], at = (prefixes.get(run.id) ?? 0) + i
          const picked = group ? at >= selection!.paragraphFrom! && at < selection!.paragraphTo! : active && i >= selection!.from && i < selection!.to
          return <span key={i} className={picked ? 'source-char-picked' : ''} style={{ position: 'absolute', left: `${(position(run).x + c.offset - b.x) / b.width * 100}%`, width: `${c.width / b.width * 100}%`, height: '100%', fontSize: `${run.fontSize / b.height * 100}cqh` }}>{char}</span>
        })}
      </div>
    })}
  </div>
}
