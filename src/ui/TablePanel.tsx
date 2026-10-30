import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { buildTable, detectColumns, mergeRows, wordsFromFragments, wordsInRegion, type TableRegion, type TableWord } from '../core/tables/extract'
import { asNumberCell, classifyCell, type NumberLocale, type TableCell } from '../core/tables/values'
import { buildOds, buildXlsx } from '../core/tables/workbook'
import { downloadFile } from '../core/pdf/downloadPdf'
import { pageSize, type DocumentPage } from '../core/pages'
import type { PdfHandle } from '../core/pdf/loadPdf'

const STAGE_WIDTH = 460
const MIN_DRAG = 6
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ODS_TYPE = 'application/vnd.oasis.opendocument.spreadsheet'

/** Reviewing happens on this copy; the PDF and the editor state are never touched. */
export function TablePanel({ pdf, pages, fileName, initialPage, onClose }: { pdf: PdfHandle; pages: DocumentPage[]; fileName: string; initialPage: number; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ x: number; y: number; moved: boolean; line?: number } | null>(null)
  const [pageIndex, setPageIndex] = useState(Math.min(initialPage, pages.length - 1))
  const [words, setWords] = useState<{ pageIndex: number; words: TableWord[] } | null>(null)
  const [region, setRegion] = useState<TableRegion | null>(null)
  const [draft, setDraft] = useState<TableRegion | null>(null)
  const [lines, setLines] = useState<number[]>([])
  const [locale, setLocale] = useState<NumberLocale>('de')
  const [rows, setRows] = useState<TableCell[][]>([])
  const [problem, setProblem] = useState('')
  const [reviewed, setReviewed] = useState(false)

  const size = pageSize(pages[pageIndex])
  const scale = Math.min(1.2, STAGE_WIDTH / size.width)

  useEffect(() => {
    const controller = new AbortController()
    if (canvas.current) void pdf.renderPage(pageIndex + 1, canvas.current, scale, controller.signal).catch(() => undefined)
    return () => controller.abort()
  }, [pdf, pageIndex, scale])

  useEffect(() => {
    let current = true
    void pdf.getSearchText(pageIndex + 1).then(fragments => { if (current) setWords({ pageIndex, words: wordsFromFragments(fragments) }) })
      .catch(() => { if (current) setProblem('Der Text dieser Seite konnte nicht gelesen werden.') })
    return () => { current = false }
  }, [pdf, pageIndex])

  const pageWords = useMemo(() => (words?.pageIndex === pageIndex ? words.words : null), [words, pageIndex])

  const rebuild = useCallback((area: TableRegion | null, columnLines: number[], format: NumberLocale) => {
    setReviewed(false)
    setProblem('')
    if (!area || !pageWords) { setRows([]); return }
    try { setRows(buildTable(wordsInRegion(pageWords, area), columnLines, format).rows) }
    catch (error) {
      setRows([])
      setProblem(error instanceof Error ? error.message : 'Die Tabelle konnte nicht erzeugt werden.')
    }
  }, [pageWords])

  const chooseRegion = (area: TableRegion) => {
    const detected = pageWords ? detectColumns(wordsInRegion(pageWords, area)) : []
    setRegion(area)
    setLines(detected)
    rebuild(area, detected, locale)
  }
  const updateLines = (next: number[]) => {
    setLines(next)
    rebuild(region, next, locale)
  }
  const changePage = (index: number) => {
    setPageIndex(index)
    setRegion(null)
    setLines([])
    setRows([])
    setReviewed(false)
    setProblem('')
  }

  const point = (event: ReactPointerEvent) => {
    const box = stage.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(size.width, (event.clientX - box.left) / scale)), y: Math.max(0, Math.min(size.height, (event.clientY - box.top) / scale)) }
  }
  const areaBetween = (a: { x: number; y: number }, b: { x: number; y: number }): TableRegion =>
    ({ left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) })

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const line = (event.target as HTMLElement).dataset.line
    gesture.current = { ...point(event), moved: false, line: line === undefined ? undefined : Number(line) }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = gesture.current
    if (!start) return
    const here = point(event)
    start.moved ||= Math.hypot(here.x - start.x, here.y - start.y) * scale > MIN_DRAG
    if (!start.moved) return
    if (start.line !== undefined) setLines(list => list.map((value, index) => index === start.line ? here.x : value))
    else setDraft(areaBetween(start, here))
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = gesture.current
    gesture.current = null
    setDraft(null)
    if (!start) return
    const here = point(event)
    if (start.line !== undefined) {
      if (start.moved) rebuild(region, lines.map((value, index) => index === start.line ? here.x : value), locale)
    } else if (start.moved) chooseRegion(areaBetween(start, here))
    else if (region && here.x > region.left && here.x < region.right && here.y > region.top && here.y < region.bottom) updateLines([...lines, here.x])
  }

  const editCell = (rowIndex: number, columnIndex: number, text: string) => {
    setRows(list => list.map((row, r) => r !== rowIndex ? row : row.map((cell, c) => c === columnIndex ? classifyCell(text, locale) : cell)))
    setReviewed(false)
  }
  const setColumnType = (columnIndex: number, type: 'number' | 'text') => {
    setRows(list => list.map(row => row.map((cell, c) => {
      if (c !== columnIndex || !cell.text) return cell
      return type === 'number' ? asNumberCell(cell, locale) : { text: cell.text, type: 'text' }
    })))
    setReviewed(false)
  }
  const deleteRow = (rowIndex: number) => {
    setRows(list => list.filter((_, index) => index !== rowIndex))
    setReviewed(false)
  }
  const mergeWithNext = (rowIndex: number) => {
    setRows(list => mergeRows(list, rowIndex, locale))
    setReviewed(false)
  }
  const save = (format: 'xlsx' | 'ods') => {
    try {
      const bytes = format === 'xlsx' ? buildXlsx(rows, locale) : buildOds(rows, locale)
      downloadFile(bytes, `${fileName.replace(/\.pdf$/i, '')}-tabelle.${format}`, format === 'xlsx' ? XLSX_TYPE : ODS_TYPE)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Der Export ist fehlgeschlagen.')
    }
  }

  const uncertain = rows.flat().filter(cell => cell.note).length
  const recognized = !!pages[pageIndex].ocr?.length
  const shownRegion = draft ?? region
  const columns = rows[0]?.length ?? 0

  return (
    <section className="table-panel" aria-label="Tabelle exportieren">
      <div className="table-source">
        <div className="table-source-bar">
          <button type="button" aria-label="Vorherige Seite" disabled={pageIndex === 0} onClick={() => changePage(pageIndex - 1)}>‹</button>
          <span>Seite {pageIndex + 1} von {pages.length}</span>
          <button type="button" aria-label="Nächste Seite" disabled={pageIndex === pages.length - 1} onClick={() => changePage(pageIndex + 1)}>›</button>
          <button type="button" disabled={!pageWords} onClick={() => chooseRegion({ left: 0, right: size.width, top: 0, bottom: size.height })}>Ganze Seite</button>
        </div>
        <div ref={stage} className="table-stage" style={{ width: size.width * scale, height: size.height * scale }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { gesture.current = null; setDraft(null) }}>
          <canvas ref={canvas} />
          {shownRegion && <div className="table-region" style={{ left: shownRegion.left * scale, top: shownRegion.top * scale, width: (shownRegion.right - shownRegion.left) * scale, height: (shownRegion.bottom - shownRegion.top) * scale }} />}
          {region && !draft && lines.map((line, index) => (
            <button
              key={index}
              type="button"
              className="table-line"
              data-line={index}
              aria-label={`Spaltengrenze ${index + 1}`}
              style={{ left: line * scale, top: region.top * scale, height: (region.bottom - region.top) * scale }}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault()
                  updateLines(lines.map((value, position) => position === index ? value + (event.key === 'ArrowLeft' ? -2 : 2) : value))
                } else if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault()
                  updateLines(lines.filter((_, position) => position !== index))
                }
              }}
            />
          ))}
        </div>
        <p className="table-hint">Tabellenbereich mit der Maus aufziehen. Ein Klick in den Bereich setzt eine Spaltengrenze. Grenzen lassen sich ziehen, mit den Pfeiltasten verschieben und mit Entf löschen.</p>
      </div>
      <div className="table-review">
        <div className="table-review-bar">
          <h2>Tabelle prüfen</h2>
          <label>Zahlenformat
            <select value={locale} onChange={event => { const next = event.target.value as NumberLocale; setLocale(next); rebuild(region, lines, next) }}>
              <option value="de">Deutsch (1.234,50)</option>
              <option value="en">Englisch (1,234.50)</option>
            </select>
          </label>
          <button type="button" onClick={onClose}>Zur Dokumentbearbeitung</button>
        </div>
        {problem && <p role="alert" className="export-error">{problem}</p>}
        {!rows.length && !problem && <p className="table-hint">{pageWords && !pageWords.length ? 'Diese Seite hat keine Textebene. Bei einem Scan zuerst über „Dokument“ den Text erkennen lassen, dann lässt sich die Tabelle hier übernehmen.' : 'Noch kein Bereich gewählt.'}</p>}
        {!!rows.length && <>
          {recognized && <p className="password-warning">Diese Seite ist ein Scan. Der Text stammt aus der Texterkennung, Ziffern und Trennzeichen können falsch sein. Bitte Werte besonders mit dem Scan vergleichen.</p>}
          <p className="table-hint">{rows.length} Zeilen, {columns} Spalten. Die Zuordnung ist aus den Textpositionen geschätzt und muss geprüft werden.{uncertain ? ` ${uncertain} Zellen sind markiert.` : ''}</p>
          <div className="table-grid-wrap">
            <table className="table-grid">
              <thead>
                <tr>
                  <th aria-label="Zeilenaktionen" />
                  {Array.from({ length: columns }, (_, index) => (
                    <th key={index}>
                      <select aria-label={`Spalte ${index + 1} als`} defaultValue="" onChange={event => { const value = event.target.value as 'number' | 'text' | ''; if (value) setColumnType(index, value); event.target.value = '' }}>
                        <option value="">Spalte {index + 1}</option>
                        <option value="number">Alles als Zahl</option>
                        <option value="text">Alles als Text</option>
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    <td className="table-row-actions">
                      <button type="button" aria-label={`Zeile ${rowIndex + 1} löschen`} onClick={() => deleteRow(rowIndex)}>×</button>
                      <button type="button" aria-label={`Zeile ${rowIndex + 1} mit nächster verbinden`} disabled={rowIndex === rows.length - 1} onClick={() => mergeWithNext(rowIndex)}>↓</button>
                    </td>
                    {row.map((cell, columnIndex) => (
                      <td key={columnIndex} className={`${cell.note ? 'table-cell-note' : ''}${cell.type === 'number' ? ' table-cell-number' : ''}`}>
                        <input aria-label={`Zeile ${rowIndex + 1}, Spalte ${columnIndex + 1}`} title={cell.note} value={cell.text} onChange={event => editCell(rowIndex, columnIndex, event.target.value)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="export-confirm">
            <input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
            <span>Ich habe Werte, Zahlen und Spalten geprüft. Jede Änderung hebt diese Bestätigung auf.</span>
          </label>
          <div className="table-export">
            <button type="button" className="export-primary" disabled={!reviewed} onClick={() => save('xlsx')}>Als XLSX speichern</button>
            <button type="button" className="export-primary" disabled={!reviewed} onClick={() => save('ods')}>Als ODS speichern</button>
          </div>
        </>}
      </div>
    </section>
  )
}
