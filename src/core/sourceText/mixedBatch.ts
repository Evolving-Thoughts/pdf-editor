// Several proved paragraphs of one page checked together in one candidate.
import { analyze, fail, previewBlock, previewPageSource } from './mixedPdf'
import type { SourceBlock } from './mixedBlocks'
import type { SourceSelection } from './simplePdf'

/** Identity of a reconstructed block that survives edits of other blocks:
 * its text and the origin of its first line. */
const blockKey = (b: SourceBlock) =>
  `${b.text}\u0000${b.lines[0].left.toFixed(3)}\u0000${b.lines[0].baseline.toFixed(3)}`
/** Several paragraphs of one page in one candidate. They are applied one after
 * another; before each further paragraph the intermediate PDF is analyzed again,
 * so every paragraph is checked against the real result of the previous ones
 * (their new lines are obstacles like any other content). */
export async function previewPageSources(
  input: Uint8Array,
  edits: readonly { selection: SourceSelection; replacement: string }[],
) {
  if (edits.length === 1) return previewPageSource(input, edits[0].selection, edits[0].replacement)
  if (!edits.length || edits.length > 64) fail('Ungültiger Korrekturauftrag.')
  const pages = new Set(edits.map((e) => e.selection.runId.split(':')[1]))
  if (pages.size !== 1 || edits.some((e) => !e.selection.runId.startsWith('mixed:') || e.selection.scope !== 'paragraph'))
    fail('Mehrere Absätze können nur gemeinsam geprüft werden, wenn sie nachgewiesene Absätze derselben Seite sind.')
  const pageIndex = Number([...pages][0])
  let result = await analyze(input, pageIndex)
  const keys = edits.map(({ selection }) => {
    const index = result.runs.findIndex((r) => r.view.id === selection.runId),
      block = result.blocks.find((b) => b.members.includes(index))
    if (selection.digest !== result.revision || index < 0 || result.runs[index].view.text !== selection.expectedText || !block)
      fail('Die Textauswahl ist veraltet. Bitte die Textstelle erneut auswählen.')
    return { key: blockKey(block), label: block.text.slice(0, 40) }
  })
  if (new Set(keys.map((k) => k.key)).size !== keys.length) fail('Ein Absatz wurde mehrfach angegeben.')
  let bytes: Uint8Array = input
  for (let i = 0; i < edits.length; i++) {
    if (i) result = await analyze(bytes, pageIndex)
    const found = result.blocks.filter((b) => blockKey(b) === keys[i].key)
    const quote = `Absatz „${keys[i].label}${keys[i].label.length === 40 ? ' …' : ''}“`
    if (found.length !== 1)
      fail(`${quote}: Nach der Änderung eines anderen Absatzes nicht mehr eindeutig nachweisbar. Bitte die Absätze einzeln prüfen.`)
    try {
      bytes = await previewBlock(result, found[0], edits[i].replacement, pageIndex)
    } catch (error) {
      fail(`${quote}: ${error instanceof Error ? error.message : 'Die Korrektur ist fehlgeschlagen.'}`)
    }
  }
  return bytes
}
