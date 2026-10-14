import { useEffect, useRef, useState } from 'react'
export function ProtectedExportDialog({
  onCancel,
  onExport,
}: {
  onCancel: () => void
  onExport: (password: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [error, setError] = useState('')
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="password-dialog"
      aria-labelledby="export-password-title"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!password.length) {
            setError('Bitte ein Passwort eingeben.')
            return
          }
          if (password !== confirmation) {
            setError('Die Passwörter stimmen nicht überein.')
            return
          }
          onExport(password)
          setPassword('')
          setConfirmation('')
        }}
      >
        <h2 id="export-password-title">Passwortgeschützt exportieren</h2>
        <p>
          Die exportierte Datei wird mit AES-256 geschützt. Zum Öffnen wird
          dieses Passwort benötigt. Bitte sicher aufbewahren – wir speichern es
          nicht.
        </p>
        <p className="password-warning">
          Die lokale Arbeitskopie und automatische Entwürfe bleiben
          unverschlüsselt. Für einen Export ohne Passwort verwende
          „Exportieren“.
        </p>
        <label>
          Export-Passwort
          <input
            autoFocus
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
        {error && <p role="alert">{error}</p>}
        <div className="password-actions">
          <button type="button" onClick={onCancel}>
            Abbrechen
          </button>
          <button type="submit">Geschützt exportieren</button>
        </div>
      </form>
    </dialog>
  )
}
