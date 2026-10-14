import { useEffect, useRef, useState } from 'react'
import type { Redaction } from '../core/redactions'
interface Props { marks: Redaction[]; fill: Redaction['fill']; onFill: (fill: Redaction['fill']) => void; selected: string | null; onRemove: () => void; onClear: () => void; onApply: () => void; busy: boolean }
export function RedactionBar({ marks, fill, onFill, selected, onRemove, onClear, onApply, busy }: Props) {
  const [confirm, setConfirm] = useState(false), dialog = useRef<HTMLDialogElement>(null), count = new Set(marks.map(m => m.pageId)).size
  useEffect(() => { const element = dialog.current; if (confirm && !element?.open) element?.showModal(); if (!confirm && element?.open) element.close() }, [confirm])
  return <section className="redaction-bar" aria-label="Schwärzung vormerken und anwenden">
    <div><strong>{marks.length} {marks.length === 1 ? 'Bereich' : 'Bereiche'} vorgemerkt</strong><small>Bereiche ziehen; zum Ändern auswählen und an vier Ecken skalieren. Noch nicht sicher entfernt.</small></div>
    <label>Bereich <select aria-label="Schwärzungsfarbe" value={fill} disabled={busy} onChange={e => onFill(e.target.value as Redaction['fill'])}><option value="black">Schwarz</option><option value="white">Weiß · für Ersatztext</option></select></label>
    <button disabled={busy || !marks.some(m => m.id === selected)} onClick={onRemove}>Bereich entfernen</button>
    <button disabled={busy || !marks.length} onClick={onClear}>Vormerkungen verwerfen</button>
    <button className="redaction-primary" disabled={busy || !marks.length} onClick={() => setConfirm(true)}>Schwärzung anwenden …</button>
    <dialog ref={dialog} className="redaction-confirm" aria-labelledby="redaction-title" onCancel={() => setConfirm(false)}>
      <h2 id="redaction-title">Schwärzung auf {count} {count === 1 ? 'Seite' : 'Seiten'} anwenden?</h2>
      <p>Die <strong>gesamten betroffenen Seiten</strong> werden mit 300 dpi als Bild neu aufgebaut — einschließlich vorhandener Textboxen, Bilder und Formularfelder. Originaltext ist dort nicht mehr durchsuchbar; vorhandene Ergänzungen und Felder sind dort nicht mehr einzeln bearbeitbar.</p>
      <p>Andere Seiten bleiben vektorbasiert. Auf weißen Bereichen werden anschließend normale, leere Textboxen angelegt; Schrift und Position sind nur eine Näherung und anpassbar.</p>
      <p>Im Schwärzungs-Export entfallen außerdem Dokumentmetadaten, Verknüpfungsaktionen und nicht sichtbare Formularwerte. Nicht sicher prüfbare PDF-Strukturen werden abgelehnt, statt still übernommen.</p>
      <p><strong>Originaldatei und lokale Entwürfe können weiterhin vertrauliche Daten enthalten.</strong> Nur das geprüfte Export-PDF weitergeben; auch andere Vorkommen im Dokument kontrollieren. Undo stellt den lokalen vorherigen Stand wieder her.</p>
      <div><button onClick={() => setConfirm(false)}>Abbrechen</button><button className="redaction-primary" onClick={() => { setConfirm(false); onApply() }}>Jetzt wirklich schwärzen</button></div>
    </dialog>
  </section>
}
