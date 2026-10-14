import { useEffect, useRef, useState } from 'react'
export interface PasswordRequest {
  fileName: string
  error: string | null
  resolve: (password: string | null) => void
}
export function PasswordDialog({ request }: { request: PasswordRequest }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [password, setPassword] = useState('')
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="password-dialog"
      aria-labelledby="password-title"
      onCancel={(event) => {
        event.preventDefault()
        request.resolve(null)
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          request.resolve(password)
          setPassword('')
        }}
      >
        <h2 id="password-title">Geschütztes PDF öffnen</h2>
        <p>
          „{request.fileName}“ benötigt ein Passwort. Der bisherige Stand bleibt
          bei Abbruch oder falschem Passwort geöffnet.
        </p>
        <p className="password-warning">
          Nur die lokale Arbeitskopie wird entschlüsselt. Automatische Entwürfe
          bleiben <strong>unverschlüsselt</strong>. Der normale Export ist
          ebenfalls unverschlüsselt; „Mit Passwort exportieren …“ schützt die
          Ausgabe. Die Originaldatei bleibt unverändert. Das Passwort wird nicht
          gespeichert.
        </p>
        <label>
          PDF-Passwort
          <input
            autoFocus
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {request.error && <p role="alert">{request.error}</p>}
        <div className="password-actions">
          <button type="button" onClick={() => request.resolve(null)}>
            Abbrechen
          </button>
          <button type="submit">PDF öffnen</button>
        </div>
      </form>
    </dialog>
  )
}
