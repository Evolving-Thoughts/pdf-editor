import { useEffect, useMemo, useRef, useState } from 'react'
import { LABEL_POSITIONS, labelCollisions, labelOverlays, parsePageRange, planLabels, withoutLabelGroup, type LabelConfig, type LabelPosition, type MeasureText, type PlannedLabel } from '../core/pageLabels'
import { createLabelMeasure } from '../core/pdf/labelMetrics'
import { replaceOverlays } from '../core/commands'
import { pageSize } from '../core/pages'
import type { EditorStore } from '../core/editorStore'
import type { PdfHandle } from '../core/pdf/loadPdf'
import type { SearchFragment } from '../core/search'

const POSITION_NAMES: Record<LabelPosition, string> = {
  'top-left': 'Oben links', 'top-center': 'Oben Mitte', 'top-right': 'Oben rechts',
  'bottom-left': 'Unten links', 'bottom-center': 'Unten Mitte', 'bottom-right': 'Unten rechts',
}
const CSS_FONT: Record<LabelConfig['font'], string> = { helvetica: 'Helvetica, Arial, sans-serif', times: "'Times New Roman', Times, serif", courier: "'Courier New', Courier, monospace" }
const PREVIEW_HEIGHT = 340

export function PageLabelsDialog({ pdf, store, onClose }: { pdf: PdfHandle; store: EditorStore; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [config, setConfig] = useState<LabelConfig>({ template: 'Seite {n} von {gesamt}', range: '', start: 1, position: 'bottom-center', margin: 28, font: 'helvetica', fontSize: 10 })
  const [measure, setMeasure] = useState<MeasureText | null>(null)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [collisions, setCollisions] = useState<{ labels: PlannedLabel[]; pages: number[] } | null>(null)
  const [accepted, setAccepted] = useState(false)
  // The dialog is modal, so the document cannot change while it is open.
  const [pages] = useState(() => store.state.pages ?? [])

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  useEffect(() => { void createLabelMeasure().then(value => setMeasure(() => value)) }, [])

  const plan = useMemo(() => {
    if (!measure) return { labels: [] as PlannedLabel[], problem: '' }
    try { return { labels: planLabels(pages, config, measure), problem: '' } }
    catch (error) { return { labels: [] as PlannedLabel[], problem: error instanceof Error ? error.message : 'Die Eingabe ist ungültig.' } }
  }, [pages, config, measure])

  const label = plan.labels[Math.min(previewIndex, plan.labels.length - 1)]
  const page = label ? pages[label.pageIndex] : undefined
  const size = page ? pageSize(page) : undefined
  const scale = size ? Math.min(PREVIEW_HEIGHT / size.height, 300 / size.width) : 1

  useEffect(() => {
    if (!label || !canvas.current) return
    const controller = new AbortController()
    void pdf.renderPage(label.pageIndex + 1, canvas.current, scale, controller.signal).catch(() => undefined)
    return () => controller.abort()
  }, [pdf, label, scale])

  // Collisions depend on page text, so they are worked out for the whole plan.
  useEffect(() => {
    if (!plan.labels.length) return
    let current = true
    void (async () => {
      const text = new Map<number, SearchFragment[]>()
      for (const item of plan.labels) {
        if (!current) return
        text.set(item.pageIndex, await pdf.getSearchText(item.pageIndex + 1))
      }
      const others = withoutLabelGroup(store.state.overlays, config.position)
      if (current) setCollisions({ labels: plan.labels, pages: labelCollisions(plan.labels, config.fontSize, pages, others, text) })
    })()
    return () => { current = false }
  }, [plan.labels, pdf, store, config.fontSize, config.position, pages])

  const hits = collisions?.labels === plan.labels ? collisions.pages : null
  const checked = !!hits && !plan.problem && !!plan.labels.length
  const apply = () => {
    if (!checked) return
    const before = store.state.overlays
    store.dispatch(replaceOverlays(before, [...withoutLabelGroup(before, config.position), ...labelOverlays(plan.labels, config)]))
    onClose()
  }
  const update = (changes: Partial<LabelConfig>) => {
    setConfig(value => ({ ...value, ...changes }))
    setAccepted(false)
    setPreviewIndex(0)
  }
  let rangeError = ''
  try { parsePageRange(config.range, pages.length) } catch (error) { rangeError = error instanceof Error ? error.message : '' }

  return (
    <dialog ref={dialog} className="password-dialog page-labels-dialog" aria-labelledby="page-labels-title" onCancel={event => { event.preventDefault(); onClose() }}>
      <form onSubmit={event => { event.preventDefault(); apply() }}>
        <h2 id="page-labels-title">Seitenzahlen, Kopf- und Fußzeile</h2>
        <div className="page-labels-layout">
          <div className="page-labels-fields">
            <label>Text
              <input autoFocus type="text" value={config.template} onChange={event => update({ template: event.target.value })} />
              <small>{'{n}'} ist die laufende Nummer, {'{gesamt}'} die letzte.</small>
            </label>
            <label>Seiten
              <input type="text" value={config.range} placeholder={`Alle (1-${pages.length})`} onChange={event => update({ range: event.target.value })} />
            </label>
            <label>Erste Nummer
              <input type="number" min={0} value={config.start} onChange={event => update({ start: Number(event.target.value) })} />
            </label>
            <fieldset className="page-labels-position">
              <legend>Position</legend>
              {LABEL_POSITIONS.map(position => (
                <label key={position} title={POSITION_NAMES[position]}>
                  <input type="radio" name="label-position" aria-label={POSITION_NAMES[position]} checked={config.position === position} onChange={() => update({ position })} />
                </label>
              ))}
            </fieldset>
            <div className="page-labels-row">
              <label>Schrift
                <select value={config.font} onChange={event => update({ font: event.target.value as LabelConfig['font'] })}>
                  <option value="helvetica">Helvetica</option>
                  <option value="times">Times</option>
                  <option value="courier">Courier</option>
                </select>
              </label>
              <label>Größe
                <input type="number" min={4} max={72} value={config.fontSize} onChange={event => update({ fontSize: Number(event.target.value) })} />
              </label>
              <label>Rand
                <input type="number" min={0} value={config.margin} onChange={event => update({ margin: Number(event.target.value) })} />
              </label>
            </div>
          </div>
          <div className="page-labels-preview" aria-label="Vorschau">
            {page && size && label && <>
              <div className="page-labels-sheet" style={{ width: size.width * scale, height: size.height * scale }}>
                <canvas ref={canvas} />
                <span data-testid="label-preview" style={{ left: label.x * scale, bottom: label.y * scale, fontSize: config.fontSize * scale, fontFamily: CSS_FONT[config.font] }}>{label.text}</span>
              </div>
              <div className="page-labels-pager">
                <button type="button" aria-label="Vorherige Seite" disabled={previewIndex === 0} onClick={() => setPreviewIndex(value => value - 1)}>‹</button>
                <span>Seite {label.pageIndex + 1} · {Math.round(size.width)} × {Math.round(size.height)} pt</span>
                <button type="button" aria-label="Nächste Seite" disabled={previewIndex >= plan.labels.length - 1} onClick={() => setPreviewIndex(value => value + 1)}>›</button>
              </div>
            </>}
          </div>
        </div>
        {(rangeError || plan.problem) && <p role="alert" className="export-error">{rangeError || plan.problem}</p>}
        {!!hits?.length && <label className="export-confirm">
          <input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />
          <span>Überdeckt vorhandene Inhalte auf {hits.length === 1 ? 'Seite' : 'den Seiten'} {hits.slice(0, 8).map(index => index + 1).join(', ')}{hits.length > 8 ? ' und weiteren' : ''}. Trotzdem anwenden.</span>
        </label>}
        <p className="export-detail">Die Prüfung erkennt Text und Overlays, aber keine Bilder im PDF. Die Vorschau zeigt die echte Seite. Ein zweites Anwenden an derselben Position ersetzt die Beschriftung. Die Nummern folgen automatisch, wenn Seiten umsortiert oder gelöscht werden. Von Hand geänderte Beschriftungen bleiben, wie sie sind.</p>
        <div className="password-actions">
          <button type="button" onClick={onClose}>Abbrechen</button>
          <button type="submit" className="export-primary" disabled={!checked || (!!hits?.length && !accepted)}>{plan.labels.length ? `Auf ${plan.labels.length} ${plan.labels.length === 1 ? 'Seite' : 'Seiten'} anwenden` : 'Anwenden'}</button>
        </div>
      </form>
    </dialog>
  )
}
