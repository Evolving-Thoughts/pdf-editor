import type { FitStatus } from '../core/sourceText/inlineLayout'

/** Fit message for the inline editor (live layout; the PDF check decides). */
export function fitMessage(status: FitStatus | undefined) {
  if (!status) return { tone: 'bad', text: 'Ein Wort ist breiter als der Absatz. Es wird nicht verkleinert, gestaucht oder neu getrennt.' }
  const lines = status.before === status.after ? `${status.after} ${status.after === 1 ? 'Zeile' : 'Zeilen'}` : `${status.before} → ${status.after} Zeilen`
  switch (status.kind) {
    case 'same': return { tone: 'neutral', text: `Unverändert · ${lines}. Direkt im Absatz tippen.` }
    case 'ok': return { tone: 'good', text: `Passt · ${lines}${status.after < status.before ? ' · darunter bleibt freier Platz' : ''}` }
    case 'overflow': return { tone: 'bad', text: `Passt nicht · ${lines}: ${status.reason.replace(/ Nachfolgende Inhalte werden nicht verschoben\.$/, '')} Platz ist für ${status.room} weitere ${status.room === 1 ? 'Zeile' : 'Zeilen'}; nachfolgende Inhalte werden nicht verschoben.` }
    case 'limit': return { tone: 'bad', text: `Passt nicht · ${status.reason}` }
    case 'pinned': return { tone: 'bad', text: 'Passt nicht · Text unter einem Link, einer Hinterlegung oder Unterstreichung würde sich verschieben.' }
    case 'missing': return { tone: 'bad', text: `Zeichen fehlt in der Originalschrift: ${status.chars!.map(c => `„${c}“`).join(', ')} (rot markiert).` }
    case 'invalid': return { tone: 'bad', text: status.chars?.length ? `Nicht unterstütztes Zeichen: ${status.chars.map(c => `„${c}“`).join(', ')} (rot markiert).` : 'Ein Absatz darf nicht leer sein.' }
    default: return { tone: 'bad', text: 'Passt nicht.' }
  }
}
