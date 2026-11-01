// Limits checked before expensive work. Values and measurements: docs/t20-large-pdfs.md.
export const MAX_PDF_BYTES = 512 * 1024 * 1024
export const MAX_PAGE_COUNT = 5000
export const MAX_TOTAL_SOURCE_BYTES = 1024 * 1024 * 1024

const mebibytes = (bytes: number) => `${new Intl.NumberFormat('de-DE').format(Math.round(bytes / 1024 / 1024))} MiB`
const count = (value: number) => new Intl.NumberFormat('de-DE').format(value)

/** The reason is known and belongs in front of the user as it stands. */
export class DocumentProblem extends Error {}

export function assertFileBudget(bytes: number): void {
  if (bytes > MAX_PDF_BYTES)
    throw new DocumentProblem(`Die Datei ist mit ${mebibytes(bytes)} zu groß. Möglich sind bis zu ${mebibytes(MAX_PDF_BYTES)}. Der bisherige Stand bleibt unverändert.`)
}

export function assertPageBudget(pages: number): void {
  if (pages > MAX_PAGE_COUNT)
    throw new DocumentProblem(`Das Dokument hätte ${count(pages)} Seiten. Möglich sind bis zu ${count(MAX_PAGE_COUNT)} Seiten. Der bisherige Stand bleibt unverändert.`)
}

export function assertSourceBudget(existing: number, added: number): void {
  if (existing + added > MAX_TOTAL_SOURCE_BYTES)
    throw new DocumentProblem(`Die Gesamtgröße aller Quelldateien wäre ${mebibytes(existing + added)}. Möglich sind bis zu ${mebibytes(MAX_TOTAL_SOURCE_BYTES)}. Der bisherige Stand bleibt unverändert.`)
}
