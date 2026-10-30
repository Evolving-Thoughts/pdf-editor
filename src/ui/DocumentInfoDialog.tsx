import { useEffect, useRef, useState } from 'react'
import { effectiveField, METADATA_FIELDS, readMetadata, type DocumentMetadata, type MetadataEdit, type MetadataField } from '../core/pdf/metadata'

const LABELS: Record<MetadataField, string> = { title: 'Titel', author: 'Autor', subject: 'Betreff', keywords: 'Schlagwörter' }

function shownValues(metadata: DocumentMetadata, edit: MetadataEdit | undefined) {
  return Object.fromEntries(METADATA_FIELDS.map(field => {
    const decided = edit?.fields[field]
    return [field, decided === undefined ? effectiveField(metadata.fields[field]) : decided ?? '']
  })) as Record<MetadataField, string>
}

const dateText = (value: string | undefined) => {
  // PDF dates read D:YYYYMMDDHHmmSS, XMP dates are ISO. Show only what is certain.
  const match = /^(?:D:)?(\d{4})-?(\d{2})-?(\d{2})/.exec(value ?? '')
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value
}

/** Shows the chosen state; it takes effect in the export and stays undoable until then. */
export function DocumentInfoDialog({ original, edit, onApply, onClose }: {
  original: ArrayBuffer
  edit: MetadataEdit | undefined
  onApply: (edit: MetadataEdit | undefined) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [metadata, setMetadata] = useState<DocumentMetadata | null>(null)
  const [values, setValues] = useState<Record<MetadataField, string> | null>(null)
  const [failed, setFailed] = useState(false)
  const [confirmRemoval, setConfirmRemoval] = useState(false)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  useEffect(() => {
    let current = true
    void readMetadata(new Uint8Array(original)).then(result => {
      if (!current) return
      setMetadata(result)
      setValues(shownValues(result, edit))
    }).catch(() => { if (current) setFailed(true) })
    return () => { current = false }
  }, [original, edit])

  const apply = () => {
    if (!metadata || !values) return
    const fields: MetadataEdit['fields'] = {}
    for (const field of METADATA_FIELDS) {
      const text = values[field].trim()
      if (text !== effectiveField(metadata.fields[field]) || (metadata.fields[field].info ?? text) !== (metadata.fields[field].xmp ?? text)) fields[field] = text || null
    }
    const removeTechnical = edit?.removeTechnical
    onApply(Object.keys(fields).length || removeTechnical ? { fields, ...(removeTechnical ? { removeTechnical } : {}) } : undefined)
    onClose()
  }
  const removeAll = () => {
    onApply({ fields: Object.fromEntries(METADATA_FIELDS.map(field => [field, null])), removeTechnical: true })
    onClose()
  }

  return (
    <dialog ref={dialog} className="password-dialog document-info-dialog" aria-labelledby="document-info-title" onCancel={event => { event.preventDefault(); onClose() }}>
      <form onSubmit={event => { event.preventDefault(); apply() }}>
        <h2 id="document-info-title">Dokumentinfo</h2>
        {failed && <p role="alert" className="export-error">Die Dokumentinfo konnte nicht gelesen werden. Das Dokument bleibt unverändert.</p>}
        {!failed && !values && <p role="status">Dokumentinfo wird gelesen …</p>}
        {values && metadata && <>
          {METADATA_FIELDS.map(field => {
            const { info, xmp } = metadata.fields[field]
            return (
              <label key={field}>
                {LABELS[field]}
                <input type="text" value={values[field]} placeholder="Leer" autoComplete="off" onChange={event => setValues({ ...values, [field]: event.target.value })} />
                {info && xmp && info !== xmp && <small className="document-info-note">Die Datei enthält zwei Fassungen: „{info}“ und „{xmp}“. Übernehmen gleicht beide an.</small>}
              </label>
            )
          })}
          {metadata.xmpUnreadable && <p className="password-warning">Die XMP-Angaben der Datei sind nicht lesbar. Wird ein Feld geändert, entfällt dieser Bereich beim Export komplett.</p>}
          <dl className="document-info-technical" aria-label="Technische Angaben">
            <div><dt>Erstellt mit</dt><dd>{metadata.technical.creator ?? 'Nicht angegeben'}</dd></div>
            <div><dt>PDF-Erzeuger</dt><dd>{metadata.technical.producer ?? 'Nicht angegeben'}</dd></div>
            <div><dt>Erstellt am</dt><dd>{dateText(metadata.technical.created) ?? 'Nicht angegeben'}</dd></div>
            <div><dt>Geändert am</dt><dd>{dateText(metadata.technical.modified) ?? 'Nicht angegeben'}</dd></div>
          </dl>
          {edit?.removeTechnical && <p className="export-detail">Technische Angaben werden beim Export entfernt.</p>}
          <p className="password-warning">Das Entfernen gilt für die exportierte Kopie und ist keine vollständige Anonymisierung. Sichtbare Inhalte, Anhänge, versteckte Texte und lokale Entwürfe bleiben bestehen.</p>
          {confirmRemoval && <div className="document-info-confirm" role="group" aria-label="Entfernen bestätigen">
            <p>Titel, Autor, Betreff, Schlagwörter und alle technischen Angaben entfernen?</p>
            <button type="button" className="export-primary" onClick={removeAll}>Jetzt alle entfernen</button>
          </div>}
        </>}
        <div className="password-actions">
          <button type="button" onClick={onClose}>Abbrechen</button>
          {values && !confirmRemoval && <button type="button" onClick={() => setConfirmRemoval(true)}>Alle entfernen</button>}
          <button type="submit" className="export-primary" disabled={!values}>Übernehmen</button>
        </div>
      </form>
    </dialog>
  )
}
