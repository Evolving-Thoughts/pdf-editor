import { useEffect, useRef, useState } from 'react'
import {
  COMPRESSION_PRESETS,
  type CompressionPreset,
  type CompressionResult,
} from '../core/pdf/compressPdf'
export interface PreparedExport {
  name: string
  original: Uint8Array
  compression?: CompressionResult
}
function formatSize(bytes: number) {
  const unit = bytes >= 1024 * 1024 ? 'MiB' : 'KiB'
  return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(bytes / (unit === 'MiB' ? 1024 * 1024 : 1024))} ${unit}`
}
export function ExportDialog({
  onCancel,
  onPrepare,
  onDownload,
}: {
  onCancel: () => void
  onPrepare: (
    preset: CompressionPreset | undefined,
    signal: AbortSignal,
    onProgress: (done: number, total: number) => void,
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
  const [compression, setCompression] = useState(false),
    [protect, setProtect] = useState(false)
  const [preset, setPreset] = useState<CompressionPreset>('balanced')
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState('')
  const [prepared, setPrepared] = useState<PreparedExport | null>(null)
  const [failedPreparation, setFailedPreparation] = useState(false)
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
          compression && !withoutCompression ? preset : undefined,
          signal,
          (done, total) => {
            if (!signal.aborted)
              setProgress(`Bilddaten optimieren: ${done} / ${total}`)
          },
        )
      } catch (problem) {
        if (!signal.aborted) setFailedPreparation(true)
        throw problem
      }
      if (signal.aborted) return
      if (compression && !withoutCompression) setPrepared(result)
      else {
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
  const save = (original = false) => {
    if (!prepared || !validPassword()) return
    void run(async (signal) => {
      setProgress(
        protect ? 'PDF wird verschlüsselt …' : 'PDF wird gespeichert …',
      )
      await onDownload(
        original
          ? prepared.original
          : (prepared.compression?.bytes ?? prepared.original),
        prepared.name,
        protect ? password : undefined,
        signal,
      )
      if (!signal.aborted) close()
    })
  }
  const stats = prepared?.compression
  const saved = stats ? prepared!.original.length - stats.bytes.length : 0
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
        {!prepared ? (
          <fieldset disabled={busy}>
            <label className="export-toggle">
              <input
                autoFocus
                type="checkbox"
                checked={compression}
                onChange={(event) => {
                  setCompression(event.target.checked)
                  setError('')
                  setFailedPreparation(false)
                }}
              />
              <span>
                <strong>Bilddaten komprimieren</strong>
                <small>
                  Optional · besonders für gerasterte Seiten und Bilder.
                </small>
              </span>
            </label>
            {compression ? (
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
            ) : (
              <p className="export-detail">
                Ohne Komprimierung: Export in der bisherigen Qualität.
              </p>
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
                <dt>Ohne Komprimierung</dt>
                <dd>{formatSize(prepared.original.length)}</dd>
              </div>
              <div>
                <dt>Gewählte Ausgabe</dt>
                <dd>
                  {formatSize(stats?.bytes.length ?? prepared.original.length)}
                </dd>
              </div>
            </dl>
            <p className="password-warning">
              {saved > 0
                ? `${Math.round((saved / prepared.original.length) * 100)} % kleiner · ${COMPRESSION_PRESETS[preset].label}`
                : 'Keine Ersparnis. Die Ausgabe ohne Komprimierung wird verwendet.'}
            </p>
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
          <p role="status" aria-live="polite">
            {progress}
          </p>
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
            disabled={busy}
            className="export-primary"
          >
            {prepared
              ? saved > 0
                ? 'Kleinere Datei speichern'
                : 'Datei speichern'
              : compression
                ? 'Export vorbereiten'
                : protect
                  ? 'Geschützt exportieren'
                  : 'Ohne Komprimierung exportieren'}
          </button>
        </div>
        {((prepared && saved > 0) ||
          (!prepared && failedPreparation && compression)) && (
          <button
            className="export-fallback"
            type="button"
            disabled={busy}
            onClick={() => (prepared ? save(true) : prepare(true))}
          >
            Stattdessen ohne Komprimierung exportieren
          </button>
        )}
      </form>
    </dialog>
  )
}
