import { useEffect, useRef, useState } from 'react'
import { COMPRESSION_PRESETS, type CompressionPreset } from '../core/pdf/compressPdf'
import type { ExportProgress, ExportResult, ExportSize } from '../core/pdf/exportPipeline'
import { CHECK_INCOMPLETE, rejection, type Assessment, type PreflightReport, type TextIssue } from '../core/pdf/preflight'
export interface PreparedExport extends ExportResult {
  name: string
}
type SizeMode = ExportSize['mode']
function formatSize(bytes: number) {
  const unit = bytes >= 1024 * 1024 ? 'MiB' : 'KiB'
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(bytes / (unit === 'MiB' ? 1024 * 1024 : 1024))} ${unit}`
}
const VISIBLE_TEXT_ISSUES = 5

export function ExportDialog({
  onCancel,
  onCheck,
  onJump,
  onPrepare,
  onDownload,
}: {
  onCancel: () => void
  onCheck: (signal: AbortSignal) => Promise<PreflightReport>
  onJump: (issue: TextIssue) => void
  onPrepare: (
    size: ExportSize,
    signal: AbortSignal,
    onProgress: (progress: ExportProgress) => void,
  ) => Promise<PreparedExport>
  onDownload: (
    bytes: Uint8Array,
    name: string,
    password: string | undefined,
    signal: AbortSignal,
  ) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const operation = useRef<AbortController | null>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  // Fresh component on every open: neither preference nor password enters drafts.
  const [sizeMode, setSizeMode] = useState<SizeMode>('none'),
    [protect, setProtect] = useState(false)
  const [preset, setPreset] = useState<CompressionPreset>('balanced')
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(''),
    [progressShare, setProgressShare] = useState<number | null>(null)
  const [prepared, setPrepared] = useState<PreparedExport | null>(null)
  const [failedPreparation, setFailedPreparation] = useState(false)
  // Absent while the check runs; the export stays locked until it reports.
  const [report, setReport] = useState<PreflightReport | null>(null)
  const [confirmed, setConfirmed] = useState<ReadonlySet<Assessment['kind']>>(new Set())
  const [textConfirmed, setTextConfirmed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void onCheck(controller.signal).then(result => { if (!controller.signal.aborted) setReport(result) }).catch(() => {
      if (!controller.signal.aborted) setReport({ rebuilt: true, textIssues: [], xmpDropped: false, assessments: [{ kind: 'signature', state: 'unknown', decision: 'confirm', message: CHECK_INCOMPLETE }] })
    })
    return () => controller.abort()
  }, [onCheck])
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => {
      operation.current?.abort()
      element?.close()
    }
  }, [])
  useEffect(() => {
    if (prepared) actionRef.current?.focus()
  }, [prepared])
  const close = () => {
    operation.current?.abort()
    setPassword('')
    setConfirmation('')
    onCancel()
  }
  const validPassword = () => {
    if (!protect) return true
    if (!password.length) {
      setError('Bitte ein Export-Passwort eingeben.')
      return false
    }
    if (password !== confirmation) {
      setError('Die Passwörter stimmen nicht überein.')
      return false
    }
    return true
  }
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setError('')
    setBusy(true)
    try {
      await work(controller.signal)
    } catch (problem) {
      if (!controller.signal.aborted)
        setError(
          problem instanceof Error
            ? problem.message
            : 'Der Export ist fehlgeschlagen. Es wurde keine Datei gespeichert.',
        )
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false)
        setProgress('')
      }
      if (operation.current === controller) operation.current = null
    }
  }
  const prepare = (withoutCompression = false) => {
    if (!validPassword()) return
    void run(async (signal) => {
      setFailedPreparation(false)
      setProgress('PDF wird vorbereitet …')
      let result: PreparedExport
      try {
        result = await onPrepare(
          withoutCompression || sizeMode === 'none' ? { mode: 'none' } : sizeMode === 'structure' ? { mode: 'structure' } : { mode: 'images', preset },
          signal,
          (step) => {
            if (signal.aborted) return
            setProgressShare(step.stage === 'images' && step.total ? step.done / step.total : null)
            if (step.stage === 'images') setProgress(`Bilddaten optimieren: ${step.done} / ${step.total}`)
            else if (step.stage === 'structure') setProgress('Struktur wird optimiert …')
            else setProgress('PDF wird vorbereitet …')
          },
        )
      } catch (problem) {
        if (!signal.aborted) setFailedPreparation(true)
        throw problem
      }
      if (signal.aborted) return
      if (sizeMode !== 'none' && !withoutCompression) setPrepared(result)
      else {
        setProgressShare(null)
        setProgress(
          protect ? 'PDF wird verschlüsselt …' : 'PDF wird gespeichert …',
        )
        await onDownload(
          result.original,
          result.name,
          protect ? password : undefined,
          signal,
        )
        if (!signal.aborted) close()
      }
    })
  }
  const output = prepared?.optimization?.bytes ?? prepared?.compression?.bytes ?? prepared?.original
  const save = (original = false) => {
    if (!prepared || !output || !validPassword()) return
    void run(async (signal) => {
      setProgressShare(null)
      setProgress(
        protect ? 'PDF wird verschlüsselt …' : 'PDF wird gespeichert …',
      )
      await onDownload(
        original ? prepared.original : output,
        prepared.name,
        protect ? password : undefined,
        signal,
      )
      if (!signal.aborted) close()
    })
  }
  const rejected = report ? rejection(report) : undefined
  const open = report?.assessments.filter(item => item.decision === 'confirm' && !confirmed.has(item.kind)) ?? []
  const textOpen = !!report?.textIssues.length && !textConfirmed
  const checkPending = !report || !!rejected || open.length > 0 || textOpen
  const stats = prepared?.compression
  const saved = prepared && output ? prepared.original.length - output.length : 0
  const outcomeNote = saved > 0
    ? `${Math.round((saved / prepared!.original.length) * 100)} % kleiner · ${prepared?.optimization ? 'Verlustfrei' : COMPRESSION_PRESETS[preset].label}`
    : prepared?.optimization?.outcome === 'not-verified'
      ? 'Die Optimierung ließ sich nicht sicher bestätigen. Die unveränderte Ausgabe wird verwendet.'
      : 'Keine Ersparnis. Die unveränderte Ausgabe wird verwendet.'
  return (
    <dialog
      ref={dialog}
      className="password-dialog export-dialog"
      aria-labelledby="export-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (prepared) save()
          else prepare()
        }}
      >
        <h2 id="export-title">
          {prepared ? 'Export vorbereitet' : 'PDF exportieren'}
        </h2>
        <p>Originaldatei und lokaler Entwurf bleiben unverändert.</p>
        {!prepared && (
          <section className="export-check" aria-label="Prüfung vor dem Export">
            {!report && <p role="status">Dokument wird geprüft …</p>}
            {report?.assessments.filter(item => item.decision === 'reject').map(item => <p key={item.kind} role="alert" className="export-error">{item.message}</p>)}
            {report?.assessments.filter(item => item.decision === 'confirm').map(item => (
              <label key={item.kind} className="export-confirm">
                <input type="checkbox" disabled={busy} checked={confirmed.has(item.kind)} onChange={event => setConfirmed(current => {
                  const next = new Set(current)
                  if (event.target.checked) next.add(item.kind)
                  else next.delete(item.kind)
                  return next
                })} />
                <span>{item.message}</span>
              </label>
            ))}
            {!!report?.textIssues.length && <div className="export-text-issues">
              <p><strong>Nicht darstellbare Zeichen</strong></p>
              <ul>
                {report.textIssues.slice(0, VISIBLE_TEXT_ISSUES).map(issue => (
                  <li key={issue.overlayId}>
                    <span>Seite {issue.pageIndex + 1}: {issue.characters.map(character => `„${character}“`).join(', ')} fehlt in {issue.font} · {issue.excerpt}</span>
                    <button type="button" disabled={busy} onClick={() => onJump(issue)}>Zur Stelle</button>
                  </li>
                ))}
              </ul>
              {report.textIssues.length > VISIBLE_TEXT_ISSUES && <p className="export-detail">und {report.textIssues.length - VISIBLE_TEXT_ISSUES} weitere Textfelder.</p>}
              <label className="export-confirm">
                <input type="checkbox" disabled={busy} checked={textConfirmed} onChange={event => setTextConfirmed(event.target.checked)} />
                <span>Diese Zeichen im Export durch „?“ ersetzen. In Symbolfeldern werden sie weggelassen.</span>
              </label>
            </div>}
            {report?.xmpDropped && <p className="password-warning">Die XMP-Angaben dieser Datei lassen sich nicht einzeln ändern. Sie entfallen beim Export komplett, auch solche, die nichts mit den gewählten Feldern zu tun haben.</p>}
            {report && !report.xmpDropped && !report.assessments.some(item => item.decision !== 'ok') && !report.textIssues.length && <p className="export-detail">Keine Risiken gefunden.</p>}
            {report?.assessments.filter(item => item.decision === 'ok' && item.state === 'present').map(item => <p key={item.kind} className="export-detail">{item.message}</p>)}
            {report && <p className="export-detail">Diese Prüfung ist keine Sicherheits- oder Konformitätsbestätigung.</p>}
          </section>
        )}
        {!prepared ? (
          <fieldset disabled={busy}>
            <div role="radiogroup" aria-labelledby="export-size-label" className="export-size">
              <p id="export-size-label"><strong>Dateigröße</strong></p>
              {([
                ['none', 'Nicht optimieren', 'Die Datei wird so geschrieben, wie sie ist.'],
                ['structure', 'Struktur optimieren', 'Verlustfrei · Bilder, Text und Vektoren bleiben identisch. Keine Einsparung garantiert.'],
                ['images', 'Bilddaten komprimieren', 'Qualität kann sinken · besonders für gerasterte Seiten und Bilder.'],
              ] as const).map(([value, title, detail], index) => (
                <label key={value} className="export-toggle">
                  <input
                    autoFocus={index === 0}
                    type="radio"
                    name="export-size"
                    checked={sizeMode === value}
                    onChange={() => {
                      setSizeMode(value)
                      setError('')
                      setFailedPreparation(false)
                    }}
                  />
                  <span>
                    <strong>{title}</strong>
                    <small>{detail}</small>
                  </span>
                </label>
              ))}
            </div>
            {sizeMode === 'images' && (
              <div className="export-quality">
                <label htmlFor="export-quality">Bildqualität</label>
                <select
                  id="export-quality"
                  value={preset}
                  onChange={(event) =>
                    setPreset(event.target.value as CompressionPreset)
                  }
                >
                  {Object.entries(COMPRESSION_PRESETS).map(([key, value]) => (
                    <option key={key} value={key}>
                      {value.label}
                    </option>
                  ))}
                </select>
                <small>
                  Optimierte Bilder: längste Kante höchstens{' '}
                  {COMPRESSION_PRESETS[preset].maxEdge} Pixel · kleinere Bilder
                  werden nicht vergrößert.
                </small>
                <p className="password-warning">
                  Bildqualität kann sinken. Prüfe kleine Schrift und Details.
                  PDF-Text, Vektoren und Formularfelder werden nicht gerastert.
                  Transparente oder nicht unterstützte Bildtypen bleiben
                  unverändert.
                </p>
              </div>
            )}
            <div className="export-protection">
              <label className="export-toggle">
                <input
                  type="checkbox"
                  checked={protect}
                  onChange={(event) => {
                    setProtect(event.target.checked)
                    setPassword('')
                    setConfirmation('')
                    setError('')
                  }}
                />
                <span>
                  <strong>Mit Passwort schützen</strong>
                  <small>AES-256 · unabhängig von der Komprimierung.</small>
                </span>
              </label>
              {protect && (
                <>
                  <p className="password-warning">
                    Zum Öffnen wird dieses Passwort benötigt. Bitte sicher
                    aufbewahren – wir speichern es nicht. Die lokale
                    Arbeitskopie und automatische Entwürfe bleiben
                    unverschlüsselt.
                  </p>
                  <label>
                    Export-Passwort
                    <input
                      autoComplete="new-password"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  <label>
                    Passwort wiederholen
                    <input
                      autoComplete="new-password"
                      type="password"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          </fieldset>
        ) : (
          <section aria-label="Exportgröße">
            <p className="export-detail">
              {prepared.name} ·{' '}
              {protect ? 'Mit Passwortschutz' : 'Ohne Passwortschutz'}
            </p>
            <dl className="export-sizes">
              <div>
                <dt>Ohne Optimierung</dt>
                <dd>{formatSize(prepared.original.length)}</dd>
              </div>
              <div>
                <dt>Gewählte Ausgabe</dt>
                <dd>{formatSize(output?.length ?? prepared.original.length)}</dd>
              </div>
            </dl>
            <p className="password-warning">{outcomeNote}</p>
            {stats && (
              <p className="export-detail">
                {stats.optimizedImages} Bildobjekte optimiert ·{' '}
                {stats.unchangedImages} unverändert
                {stats.failedImages
                  ? ` · ${stats.failedImages} konnten nicht optimiert werden und bleiben unverändert`
                  : ''}
                .
              </p>
            )}
            <p className="export-detail">
              Tatsächliche Dateigrößen vor einem optionalen Passwortschutz.
              Bitte Lesbarkeit und Schwärzungen im gespeicherten PDF prüfen.
            </p>
          </section>
        )}
        {error && (
          <p role="alert" className="export-error">
            {error}
          </p>
        )}
        {busy && (
          <div className="export-progress">
            <p role="status" aria-live="polite">{progress}</p>
            <progress aria-label="Exportfortschritt" {...(progressShare === null ? {} : { value: progressShare, max: 1 })} />
            <p className="export-detail">Die Bearbeitung wartet, bis der Export fertig ist. „Abbrechen“ beendet ihn sofort.</p>
          </div>
        )}
        <div className="password-actions">
          <button type="button" onClick={close}>
            Abbrechen
          </button>
          {prepared && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPrepared(null)
                setError('')
              }}
            >
              Einstellungen
            </button>
          )}
          <button
            ref={actionRef}
            type="submit"
            disabled={busy || (!prepared && checkPending)}
            className="export-primary"
          >
            {prepared
              ? saved > 0
                ? 'Kleinere Datei speichern'
                : 'Datei speichern'
              : sizeMode !== 'none'
                ? 'Export vorbereiten'
                : protect
                  ? 'Geschützt exportieren'
                  : 'Ohne Optimierung exportieren'}
          </button>
        </div>
        {((prepared && saved > 0) ||
          (!prepared && failedPreparation && sizeMode !== 'none')) && (
          <button
            className="export-fallback"
            type="button"
            disabled={busy || (!prepared && checkPending)}
            onClick={() => (prepared ? save(true) : prepare(true))}
          >
            Stattdessen ohne Optimierung exportieren
          </button>
        )}
      </form>
    </dialog>
  )
}
