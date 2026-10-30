import { useEffect, useRef, useState } from 'react'
import { customStamp, loadCustomStamps, saveCustomStamps, STAMP_COLORS, STAMP_TEMPLATES, stampLines, todayValue, type StampDesign } from '../core/stamps'

export interface ChosenStamp { design: StampDesign; lines: string[] }

const browserStorage = () => {
  try { return window.localStorage } catch { return undefined }
}

function StampChip({ design }: { design: StampDesign }) {
  return <span className="stamp-chip" style={{ color: design.color, borderColor: design.color }}>{design.text}</span>
}

/** Same pattern as the symbol picker: choosing arms the tool, a click on the page places. */
export function StampPicker({ active, onPick }: { active: boolean; onPick: (stamp: ChosenStamp) => void }) {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(() => todayValue())
  const [custom, setCustom] = useState(() => loadCustomStamps(browserStorage()))
  const [creating, setCreating] = useState(false)
  const [text, setText] = useState('')
  const [color, setColor] = useState(STAMP_COLORS[0])
  const [dated, setDated] = useState(false)
  const [problem, setProblem] = useState('')
  const wrapRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const choose = (design: StampDesign) => {
    try {
      onPick({ design, lines: stampLines(design, date) })
      setOpen(false)
      setProblem('')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Dieser Stempel ist nicht verfügbar.')
    }
  }
  const store = (next: StampDesign[]) => {
    setCustom(next)
    if (!saveCustomStamps(browserStorage(), next)) setProblem('Eigene Stempel konnten nicht gespeichert werden und gelten nur bis zum Neuladen.')
  }
  const create = () => {
    try {
      const design = customStamp(text, color, dated)
      store([design, ...custom])
      setCreating(false)
      setText('')
      setProblem('')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Dieser Stempel ist nicht möglich.')
    }
  }

  return (
    <span className="symbol-picker stamp-picker" ref={wrapRef} onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false) } }}>
      <button type="button" className="tool" aria-label="Stempel auswählen" aria-expanded={open} aria-pressed={active} title="Stempel auswählen und per Klick platzieren" onClick={() => setOpen(value => !value)}>
        Stempel
        <span className="toolbar-chevron" aria-hidden="true" />
      </button>
      {open && (
        <span className="symbol-popover stamp-popover">
          {[...STAMP_TEMPLATES, ...custom].map(design => (
            <span key={design.id} className="stamp-row">
              <button type="button" aria-label={`Stempel ${design.text}`} onClick={() => choose(design)}><StampChip design={design} /></button>
              {custom.includes(design) && <button type="button" aria-label={`Stempel ${design.text} löschen`} onClick={() => store(custom.filter(item => item !== design))}>×</button>}
            </span>
          ))}
          <label className="stamp-date">Datum für Datumsstempel
            <input type="date" value={date} onChange={event => setDate(event.target.value)} />
          </label>
          {creating ? (
            <span className="stamp-form">
              <label>Text<input type="text" value={text} maxLength={40} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); create() } }} /></label>
              <span className="stamp-colors" role="radiogroup" aria-label="Farbe">
                {STAMP_COLORS.map(value => <button key={value} type="button" role="radio" aria-checked={color === value} aria-label={`Farbe ${value}`} style={{ background: value }} onClick={() => setColor(value)} />)}
              </span>
              <label className="stamp-check"><input type="checkbox" checked={dated} onChange={event => setDated(event.target.checked)} />Mit Datum</label>
              <span className="stamp-actions"><button type="button" onClick={() => setCreating(false)}>Abbrechen</button><button type="button" onClick={create}>Speichern</button></span>
            </span>
          ) : <button type="button" onClick={() => setCreating(true)}>Eigener Stempel …</button>}
          {problem && <span role="alert" className="export-error">{problem}</span>}
          <small>Stempel sind Bilder, keine digitale Signatur, und sagen nichts über die Identität aus.</small>
        </span>
      )}
    </span>
  )
}
