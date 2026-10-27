import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib'
import { supportedSourceText } from './encoding'
import { readSourceFont } from './sourceFonts'
import type { SourceFont } from './sourceFonts'
import { streamText } from './streams'
import { planSourceParagraph } from './layout'
import { contentTokens } from './contentTokens'
import type { ContentToken } from './contentTokens'

/** Conservative text-only source adapter: horizontal explicit text state,
 * verified standard/embedded fonts, simple lines and opt-in uniform BT paragraphs.
 * Unknown graphics/shaping/structures fail closed. Not a redaction tool.
 */
export interface SimpleSourceRun {
  id: string
  pageIndex: number
  text: string
  fontName: string
  fontSize: number
  x: number
  baseline: number
  width: number
  selection?: { characters: { offset: number; width: number }[]; groupId?: string }
  paragraph?: { text: string; lineCount: number; leading: number; width: number; separator?: string; automatic?: boolean }
}
export interface SourceSelection { digest: string; runId: string; expectedText: string; scope?: 'line' | 'paragraph'; confirmReflow?: boolean }
interface Rect { left: number; right: number; bottom: number; top: number }
type Font = SourceFont
interface InternalRun { block: string; leading: number; operatorEnd: number; view: SimpleSourceRun; font: Font; rect: Rect; stream: { ref: PDFRef; text: string }; token: ContentToken }
const n = PDFName.of
function unsupported(): never { throw new Error('Diese PDF-Struktur wird für Originaltext-Korrekturen noch nicht unterstützt. Es wurde nichts verändert.') }
function limit(): never { throw new Error('Dieses PDF überschreitet die Grenzen der sicheren Textanalyse. Es wurde nichts verändert.') }
function stale(): never { throw new Error('Die Textauswahl ist veraltet. Bitte die Textstelle erneut auswählen.') }
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
function rect(run: SimpleSourceRun, font: Font): Rect {
  const scale = run.fontSize / 1000
  // Conservative full-font ink extents, including possible overhangs. These can
  // reject tight layouts, but do not equate advance width with painted bounds.
  return { left: run.x + Math.min(0, font.bbox[0]) * scale, right: run.x + run.width + Math.max(0, font.bbox[2]) * scale,
    bottom: run.baseline + font.bbox[1] * scale, top: run.baseline + font.bbox[3] * scale }
}
function overlap(a: Rect, b: Rect, clearance: number) {
  return a.left < b.right + clearance && a.right + clearance > b.left && a.bottom < b.top + clearance && a.top + clearance > b.bottom
}
async function analyze(input: Uint8Array) {
  if (!input.length || input.length > 16 * 1024 * 1024) limit()
  const bytes = input.slice() // Never let callers mutate the revision during async analysis.
  const revision = await digest(bytes)
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const pages = doc.getPages()
  if (pages.length > 200 || doc.isEncrypted) unsupported()
  // Don't rewrite signed/encrypted, form-based or tagged/accessibility documents
  // until their source text mappings and preservation rules are implemented.
  if (['AcroForm', 'StructTreeRoot', 'Perms', 'OpenAction', 'AA', 'Names'].some(key => doc.catalog.has(n(key)))) unsupported()
  const usedStreams = new Set<string>(), runs: InternalRun[] = []
  let total = 0
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex]
    if (page.getRotation().angle !== 0 || (page.node.lookupMaybe(n('UserUnit'), PDFNumber)?.asNumber() ?? 1) !== 1
      || (page.node.Annots()?.size() ?? 0) || ['StructParents', 'AA', 'Group'].some(key => page.node.has(n(key)))) unsupported()
    const resources = page.node.Resources()
    for (const [key, raw] of resources?.entries() ?? []) {
      if (key.decodeText() === 'Font' || key.decodeText() === 'ProcSet') continue
      const object = doc.context.lookup(raw)
      if (!(object instanceof PDFDict) || object.keys().length) unsupported()
    }
    const contents = page.node.get(n('Contents'))
    if (!contents) continue
    const array = doc.context.lookup(contents)
    const refs = array instanceof PDFArray ? array.asArray() : [contents]
    if (refs.length > 128) limit()
    let inText = false, depth = 0, block = 0, shown = false, line = 0, leading = 0
    let font: Font | undefined, fontSize = 0, x = 0, y = 0, positioned = false
    const fonts = new Map<string, Font>()
    const operands: ContentToken[] = []
    for (const ref of refs) {
      if (!(ref instanceof PDFRef) || usedStreams.has(ref.toString())) unsupported()
      usedStreams.add(ref.toString())
      const raw = doc.context.lookup(ref)
      if (!(raw instanceof PDFRawStream)) unsupported()
      const text = await streamText(raw)
      total += text.length
      if (total > 2 * 1024 * 1024) limit()
      const stream = { ref, text }
      for (const token of contentTokens(text)) {
        if (token.kind !== 'operator') { if (operands.length >= 6) unsupported(); operands.push(token); continue }
        const op = token.raw
        const numbers = (count: number) => {
          if (operands.length !== count || operands.some(value => value.kind !== 'number' || !Number.isFinite(Number(value.raw)))) unsupported()
          return operands.map(value => Number(value.raw))
        }
        switch (op) {
          case 'q': if (inText || ++depth > 32) unsupported(); numbers(0); break
          case 'Q': if (inText || --depth < 0) unsupported(); numbers(0); break
          case 'BT':
            if (inText) unsupported()
            numbers(0); inText = true; block++; line = 0; leading = 0; shown = false; font = undefined; fontSize = 0; positioned = false; break
          case 'ET': if (!inText || !shown) unsupported(); numbers(0); inText = false; break
          case 'Tf': {
            if (!inText || shown || operands.length !== 2 || operands[0].kind !== 'name' || operands[1].kind !== 'number') unsupported()
            const key = operands[0].raw.slice(1).replace(/#([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
            fontSize = Number(operands[1].raw)
            if (!Number.isFinite(fontSize) || fontSize <= 0 || fontSize > 512) unsupported()
            font = fonts.get(key) ?? await readSourceFont(page, key); fonts.set(key, font); break
          }
          case 'Tm': {
            if (!inText || shown || positioned) unsupported()
            const [a, b, c, d, tx, ty] = numbers(6)
            if (a !== 1 || b !== 0 || c !== 0 || d !== 1 || Math.abs(tx) > 32768 || Math.abs(ty) > 32768) unsupported()
            x = tx; y = ty; positioned = true; break
          }
          case 'TL': if (!inText || shown) unsupported(); leading = numbers(1)[0]; if (leading < 0) unsupported(); break
          case 'T*': if (!inText || !shown || positioned) unsupported(); numbers(0); y -= leading; positioned = true; break
          case 'Tj': {
            if (!inText || !font || !positioned || operands.length !== 1 || operands[0].kind !== 'string') unsupported()
            // Tokens cannot span content streams; reject split operands as well.
            const target = operands[0]
            if (text.slice(target.start, target.end) !== target.raw) unsupported()
            let value = ''
            if (target.bytes!.length % font.codeBytes) unsupported()
            for (let i = 0; i < target.bytes!.length; i += font.codeBytes) {
              const code = font.codeBytes === 1 ? target.bytes![i] : target.bytes![i] * 256 + target.bytes![i + 1]
              const c = font.decode.get(code); if (!c) unsupported(); value += c
            }
            const encoded = font.codec.encode(value)
            if (!encoded.ok || value.trim() !== value || value.includes('  ')) unsupported()
            if (shown && y >= runs.at(-1)!.view.baseline) unsupported()
            const view = { id: `${pageIndex}:${block}${line ? ':' + line : ''}`, pageIndex, text: value, fontName: font.name, fontSize, x, baseline: y, width: encoded.value.advance * fontSize / 1000 }
            if (runs.length >= 4096) limit()
            runs.push({ block: `${pageIndex}:${block}`, leading, operatorEnd: token.end, view, font, rect: rect(view, font), stream, token: target }); shown = true; positioned = false; line++; break
          }
          case 'rg': case 'RG': if (shown && inText) unsupported(); if (numbers(3).some(value => value < 0 || value > 1)) unsupported(); break
          case 'g': case 'G': if (shown && inText) unsupported(); if (numbers(1).some(value => value < 0 || value > 1)) unsupported(); break
          case 'k': case 'K': if (shown && inText) unsupported(); if (numbers(4).some(value => value < 0 || value > 1)) unsupported(); break
          default: unsupported()
        }
        operands.length = 0
      }
      if (operands.length) unsupported()
    }
    if (inText || depth || operands.length) unsupported()
  }
  const groups = new Map<string, InternalRun[]>()
  for (const run of runs) { const group = groups.get(run.block) ?? []; group.push(run); groups.set(run.block, group) }
  for (const group of groups.values()) {
    if (group.length < 2 || group.some(run => run.stream.ref !== group[0].stream.ref || run.view.x !== group[0].view.x)
      || group.slice(0, -1).some(run => /[-.!?:;]$/.test(run.view.text)) || group.some(run => /^(?:[-*]|\d+[.)]) /.test(run.view.text))) continue
    const first = group[0], text = group.map(run => run.view.text).join(' '), scale = first.view.fontSize / 1000
    const width = Math.max(...group.map(run => run.view.width))
    const original = planSourceParagraph(text, first.font.codec, { left: first.view.x, right: first.view.x + width,
      firstBaseline: first.view.baseline, bottomLimit: group.at(-1)!.view.baseline + first.font.bbox[1] * scale,
      fontSize: first.view.fontSize, leading: first.leading, ascent: Math.max(0, first.font.bbox[3] * scale),
      descent: Math.max(0, -first.font.bbox[1] * scale), originalLineCount: group.length })
    if (!original.ok || original.value.lines.length !== group.length || original.value.lines.some((line, i) => line.text !== group[i].view.text || line.baseline !== group[i].view.baseline)) continue
    for (const run of group) run.view.paragraph = { text, lineCount: group.length, leading: first.leading, width }
  }
  return { doc, runs, revision }
}

export async function inspectSimpleSourceText(bytes: Uint8Array): Promise<{ digest: string; runs: SimpleSourceRun[] }> {
  const result = await analyze(bytes)
  return { digest: result.revision, runs: result.runs.map(run => {
    let offset = 0
    const characters = Array.from(run.view.text).map(character => {
      const encoded = run.font.codec.encode(character)
      const width = encoded.ok ? encoded.value.advance * run.view.fontSize / 1000 : 0
      const value = { offset, width }
      offset += width
      return value
    })
    const safe = characters.every(c => Number.isFinite(c.offset) && Number.isFinite(c.width) && c.width > 0)
    return { ...run.view, selection: safe ? { characters, groupId: run.view.paragraph ? run.block : undefined } : undefined }
  }) }
}

/** Makes a new, real candidate PDF. Does not commit any editor/draft state. */
export async function previewSimpleSourceCorrection(input: Uint8Array, selection: SourceSelection, replacement: string): Promise<Uint8Array> {
  selection = { ...selection }
  const { doc, runs, revision } = await analyze(input)
  if (selection.digest !== revision) stale()
  const source = runs.find(run => run.view.id === selection.runId)
  if (!source || source.view.text !== selection.expectedText) stale()
  if (!supportedSourceText(replacement) || replacement.trim() !== replacement || replacement.includes('  ')) throw new Error('Dieser Ersatztext wird noch nicht unterstützt.')
  const encoded = source.font.codec.encode(replacement)
  if (!encoded.ok) throw new Error('Ein benötigtes Zeichen fehlt in der Originalschrift. Es wurde nichts verändert.')
  const paragraph = selection.scope === 'paragraph'
  if (paragraph && (!selection.confirmReflow || !source.view.paragraph)) throw new Error('Ein sicher unterstützter Fließtextabsatz muss ausdrücklich bestätigt werden. Bewusste Umbrüche dürfen nicht umgebaut werden.')
  const members = paragraph ? runs.filter(run => run.block === source.block) : [source]
  const first = members[0], page = doc.getPages()[source.view.pageIndex], boxes = [page.getMediaBox(), page.getCropBox()]
  let expected: SimpleSourceRun[]
  let changed: string
  const stream = first.stream
  if (paragraph) {
    const meta = first.view.paragraph!, scale = first.view.fontSize / 1000
    const originalBottom = members.at(-1)!.rect.bottom
    let bottomLimit = Math.max(...boxes.map(box => box.y))
    const column = { left: Math.min(...members.map(run => run.rect.left)), right: Math.max(...members.map(run => run.rect.right)) }
    for (const other of runs) {
      if (other.view.pageIndex !== first.view.pageIndex || members.includes(other) || other.rect.top > first.rect.bottom) continue
      if (other.rect.right <= column.left || other.rect.left >= column.right) continue
      const oldGap = originalBottom - other.rect.top
      const clearance = Math.max(3, Math.min(oldGap, meta.leading / 2))
      bottomLimit = Math.max(bottomLimit, other.rect.top + clearance)
    }
    const plan = planSourceParagraph(replacement, first.font.codec, { left: first.view.x, right: first.view.x + meta.width,
      firstBaseline: first.view.baseline, bottomLimit, fontSize: first.view.fontSize, leading: meta.leading,
      ascent: Math.max(0, first.font.bbox[3] * scale), descent: Math.max(0, -first.font.bbox[1] * scale), originalLineCount: members.length })
    if (!plan.ok) throw new Error(plan.error === 'missing-glyph' ? 'Ein benötigtes Zeichen fehlt in der Originalschrift.' : 'Der vollständige Absatz passt nicht mit geschütztem Abstand. Es wurde nichts verändert.')
    expected = plan.value.lines.map((line, index) => ({ ...first.view, id: first.block + (index ? ':' + index : ''), text: line.text, baseline: line.baseline, width: line.width }))
    const operators = plan.value.lines.map(line => `<${line.hex}> Tj`).join('\nT*\n')
    changed = stream.text.slice(0, first.token.start) + operators + stream.text.slice(members.at(-1)!.operatorEnd)
  } else {
    expected = [{ ...source.view, text: replacement, width: encoded.value.advance * source.view.fontSize / 1000 }]
    changed = stream.text.slice(0, source.token.start) + `<${encoded.value.hex}>` + stream.text.slice(source.token.end)
  }
  if (!paragraph && source.view.paragraph && expected[0].width > source.view.paragraph.width) {
    throw new Error('Die Zeile würde die Absatzbreite überschreiten. Bitte den bestätigten Absatzumbruch verwenden. Es wurde nichts verändert.')
  }
  for (const view of expected) {
    const bounds = rect(view, first.font)
    if (boxes.some(box => bounds.left < box.x || bounds.right > box.x + box.width || bounds.bottom < box.y || bounds.top > box.y + box.height)
      || runs.some(other => !members.includes(other) && other.view.pageIndex === view.pageIndex && overlap(bounds, other.rect, 3))) {
      throw new Error('Die Korrektur passt nicht mit sicherem Abstand in den verfügbaren Bereich. Es wurde nichts verändert.')
    }
  }
  doc.context.assign(stream.ref, doc.context.flateStream(changed))
  const bytes = await doc.save({ updateFieldAppearances: false })
  const checked = await analyze(bytes)
  const allExpected = runs.flatMap(run => run === first ? expected : members.includes(run) ? [] : [run.view])
  const comparable = (view: SimpleSourceRun) => { const { paragraph: _paragraph, ...rest } = view; void _paragraph; return rest }
  if (checked.runs.length !== allExpected.length) unsupported()
  for (let i = 0; i < allExpected.length; i++) {
    if (JSON.stringify(comparable(checked.runs[i].view)) !== JSON.stringify(comparable(allExpected[i]))) unsupported()
  }
  return bytes
}
