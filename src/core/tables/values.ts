// Cell values for table export (T26). A value only becomes a number when its
// spelling leaves no doubt. Everything else stays text and is marked for review.
export type NumberLocale = 'de' | 'en'
export interface TableCell {
  text: string
  type: 'text' | 'number'
  /** Why a person should look at this cell. */
  note?: string
}

const AMBIGUOUS = 'Unklar: Dezimaltrennzeichen oder Tausenderpunkt?'
const WRONG_FORMAT = 'Passt nicht zum gewählten Zahlenformat.'
const LONG_NUMBER = 'Lange Kennnummer bleibt Text.'
const LEADING_ZERO = 'Führende Null bleibt Text.'
const FORMULA_LIKE = 'Sieht aus wie eine Formel und bleibt Text.'
/** Beyond this, spreadsheets round silently. */
const MAX_DIGITS = 15

const GROUP = { de: '.', en: ',' }, DECIMAL = { de: ',', en: '.' }

/** Parses one number strictly. Returns null when the text is not a number in this locale. */
export function parseNumber(text: string, locale: NumberLocale): number | null {
  const group = GROUP[locale] === '.' ? '\\.' : ',', decimal = DECIMAL[locale] === '.' ? '\\.' : ','
  const value = text.trim().replace(/−/g, '-')
  if (!new RegExp(`^[+-]?(\\d{1,3}(${group}\\d{3})+|\\d+)(${decimal}\\d+)?$`).test(value)) return null
  const number = Number(value.replaceAll(GROUP[locale], '').replace(DECIMAL[locale], '.'))
  return Number.isFinite(number) ? number : null
}

export function classifyCell(text: string, locale: NumberLocale): TableCell {
  const value = text.trim()
  if (!value) return { text: '', type: 'text' }
  const unsigned = value.replace(/^[+−-]/, '')
  if (/^\d/.test(unsigned)) {
    const digits = unsigned.replace(/\D/g, '')
    if (digits.length > MAX_DIGITS) return { text: value, type: 'text', note: LONG_NUMBER }
    if (/^0\d/.test(unsigned)) return { text: value, type: 'text', note: LEADING_ZERO }
    // 1.234 and 1,234 read differently in German and English: one group, no decimals.
    if (/^\d{1,3}[.,]\d{3}$/.test(unsigned)) return { text: value, type: 'text', note: AMBIGUOUS }
    if (parseNumber(value, locale) !== null) return { text: value, type: 'number' }
    if (/^[\d.,\s]+$/.test(unsigned)) return { text: value, type: 'text', note: WRONG_FORMAT }
    return { text: value, type: 'text' }
  }
  if (/^[=+\-@]/.test(value)) return { text: value, type: 'text', note: FORMULA_LIKE }
  return { text: value, type: 'text' }
}

/** A person's explicit choice: accepted only when the value really is a number. */
export function asNumberCell(cell: TableCell, locale: NumberLocale): TableCell {
  return parseNumber(cell.text, locale) === null ? { ...cell, type: 'text', note: WRONG_FORMAT } : { text: cell.text, type: 'number' }
}
