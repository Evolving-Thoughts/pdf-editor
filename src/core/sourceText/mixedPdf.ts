/** Page-scoped content adapter. Original operators/resources/tags are preserved;
 * only one supported text-show operand is replaced. Unknown painting fails the
 * selected page, never an unrelated page. This is not a general PDF interpreter. */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  PDFHexString,
} from 'pdf-lib'
import { contentTokens } from './contentTokens'
import type { ContentToken } from './contentTokens'
import { readPageFont, UnmeasurableFont } from './fontReader'
import type { SourceFont } from './sourceFonts'
import { streamText } from './streams'
import {
  inspectSimpleSourceText,
  previewSimpleSourceCorrection,
} from './simplePdf'
import type { SimpleSourceRun, SourceSelection } from './simplePdf'
import { supportedSourceText } from './encoding'
import { blockedBy, contains, overlap, separation, slotBox, union } from './space'
import type { BlockSpace, Box } from './space'
import {
  buildBlocks,
  codeAdvance,
  emitBlock,
  hidden,
  inkBox,
  layoutEdit,
  pdfNumber,
  placeLine,
} from './mixedBlocks'
import type { BlockGlyph, BlockInput, BlockRect, PlacedLine, SourceBlock } from './mixedBlocks'
import { editModels } from './editModel'

type Matrix = [number, number, number, number, number, number]
interface Rect {
  left: number
  right: number
  bottom: number
  top: number
  /** Painted path or annotation that may mark text (background, underline, link). */
  decor?: boolean
}
interface State {
  ctm: Matrix
  tm: Matrix
  lm: Matrix
  font?: SourceFont
  fontRaw?: string
  fill: string
  size: number
  tc: number
  tw: number
  hz: number
  leading: number
  rise: number
  render: number
  clip?: Rect
  lineWidth: number
  miter: number
  /** Graphics state that makes text drawn under it measurement-only. */
  locked?: string
  fillSpace?: string
  pattern?: boolean
  /** Horizontal text-space offset of Tm from Tlm (shows and TJ moves). */
  dx: number
  /** Applied ExtGState names: block members must share them. */
  gs: string
}
interface Run {
  view: SimpleSourceRun
  bounds: Rect
  clip?: Rect
  font: SourceFont
  state: State
  stream: { ref: PDFRef; text: string; index: number }
  token: ContentToken
  end: number
  advance: number
  adjustments: number[]
  codes: number[]
  fontRaw: string
  fill: string
  bt: number
  mc: number
  tagged: boolean
  paint: number
  /** Why this text is only a protected obstacle (never editable). */
  locked?: string
  /** Text of an enclosing ActualText span (ligatures, no-break spaces). */
  actual?: string
  span?: number
  mcid?: number
  /** Show operator: ' and " carry line/spacing semantics of their own. */
  op: string
  quote?: { aw: number; ac: number }
  /** Uniform page scale of the text space, undefined when not uniform. */
  scale?: number
}
const n = PDFName.of,
  identity = (): Matrix => [1, 0, 0, 1, 0, 0]
export function fail(reason: string): never {
  throw new Error(
    reason.endsWith('Es wurde nichts verändert.')
      ? reason
      : `${reason} Es wurde nichts verändert.`,
  )
}
const mul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
]
/** Uniform, unrotated and unmirrored page scale of a text matrix product. */
function uniformScale(m: Matrix) {
  const s = m[0]
  return s > 1e-6 &&
    Math.abs(m[1]) <= 1e-6 * s &&
    Math.abs(m[2]) <= 1e-6 * s &&
    Math.abs(m[3] - s) <= 1e-6 * s
    ? s
    : undefined
}
const point = (m: Matrix, x: number, y: number) => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
]
const box = (m: Matrix, x: number, y: number, w: number, h: number): Rect => {
  const pts = [
    point(m, x, y),
    point(m, x + w, y),
    point(m, x, y + h),
    point(m, x + w, y + h),
  ]
  return {
    left: Math.min(...pts.map((p) => p[0])),
    right: Math.max(...pts.map((p) => p[0])),
    bottom: Math.min(...pts.map((p) => p[1])),
    top: Math.max(...pts.map((p) => p[1])),
  }
}
const copy = (s: State): State => ({
  ...s,
  ctm: [...s.ctm],
  tm: [...s.tm],
  lm: [...s.lm],
})
async function hash(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    ),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('')
}
function name(token?: ContentToken) {
  if (token?.kind !== 'name') fail('Ein PDF-Ressourcenname ist ungültig.')
  return token.raw
    .slice(1)
    .replace(/#([\da-f]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
}
/** PDF text string: UTF-16BE with BOM, otherwise PDFDocEncoding (Latin-1 subset). */
function textString(bytes: Uint8Array) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if (bytes.length % 2) return undefined
    let text = ''
    for (let i = 2; i < bytes.length; i += 2) text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
    return text
  }
  return String.fromCharCode(...bytes)
}
function numeric(token?: ContentToken) {
  const v = Number(token?.raw)
  if (token?.kind !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e7)
    fail('Ein PDF-Zahlenwert liegt außerhalb der unterstützten Grenzen.')
  return v
}
function initial(): State {
  return {
    ctm: identity(),
    tm: identity(),
    lm: identity(),
    fill: '0 g',
    size: 0,
    tc: 0,
    tw: 0,
    hz: 1,
    leading: 0,
    rise: 0,
    render: 0,
    lineWidth: 1,
    miter: 10,
    dx: 0,
    gs: '',
  }
}
function glyphs(
  font: SourceFont,
  codes: number[],
  adjustments: number[],
  state: State,
  override?: string,
) {
  let advance = 0,
    bounds: Rect | undefined,
    text = ''
  const matrix = mul(state.ctm, state.tm)
  for (let i = 0; i < codes.length; i++) {
    advance -= (((adjustments[i] ?? 0) * state.size) / 1000) * state.hz
    const code = codes[i],
      // Undecodable codes keep their measured geometry but make the run locked.
      char = override !== undefined ? (i ? '' : override) : (font.decode.get(code) ?? '\ufffd')
    text += char
    const enc = font.codec.encode(char),
      width = font.advances?.get(code) ?? (enc.ok ? enc.value.advance : font.defaultWidth ?? NaN)
    if (!Number.isFinite(width))
      fail('Die Breite eines Originalzeichens ist nicht nachgewiesen.')
    const b = font.boxes?.get(code) ?? font.bbox
    if (char.trim() || override !== undefined) {
      const r = box(
        matrix,
        advance + ((b[0] * state.size) / 1000) * state.hz,
        (b[1] * state.size) / 1000 + state.rise,
        (((b[2] - b[0]) * state.size) / 1000) * state.hz,
        ((b[3] - b[1]) * state.size) / 1000,
      )
      bounds = bounds ? union(bounds, r) : r
    }
    advance +=
      ((width * state.size) / 1000 +
        state.tc +
        (font.codeBytes === 1 && code === 32 ? state.tw : 0)) *
      state.hz
  }
  const width = advance
  advance -= (((adjustments[codes.length] ?? 0) * state.size) / 1000) * state.hz
  return {
    text,
    width,
    advance,
    bounds: bounds ?? box(matrix, 0, state.rise, 0, 0),
  }
}
export async function analyze(input: Uint8Array, pageIndex: number) {
  if (!input.length || input.length > 16 * 1024 * 1024)
    fail('Die PDF überschreitet die Größenbegrenzung von 16 MiB.')
  const bytes = input.slice(),
    revision = await hash(bytes),
    doc = await PDFDocument.load(bytes, { updateMetadata: false })
  if (doc.isEncrypted || doc.catalog.has(n('Perms')))
    fail(
      'Verschlüsselte oder signierte PDFs können nicht als Originaltext umgeschrieben werden.',
    )
  const form = doc.catalog.lookup(n('AcroForm'))
  if (form instanceof PDFDict) {
    // Ordinary form fields are widget annotations (protected obstacles below).
    // Signatures and XFA are refused: any content change would invalidate them.
    const flags = form.lookup(n('SigFlags'))
    if (form.has(n('XFA')) || (flags instanceof PDFNumber && flags.asNumber() & 1))
      fail('Signierte PDFs oder XFA-Formulare können nicht als Originaltext umgeschrieben werden.')
    const fields = form.lookup(n('Fields')),
      queue = fields instanceof PDFArray ? [...fields.asArray()] : []
    for (let guard = 0; queue.length && guard < 20000; guard++) {
      const field = doc.context.lookup(queue.pop())
      if (!(field instanceof PDFDict)) continue
      if (field.lookup(n('FT'))?.toString() === '/Sig' && field.has(n('V')))
        fail('Signierte PDFs können nicht als Originaltext umgeschrieben werden.')
      const kids = field.lookup(n('Kids'))
      if (kids instanceof PDFArray) queue.push(...kids.asArray())
    }
  }
  const pages = doc.getPages(),
    page = pages[pageIndex]
  if (!page || pages.length > 2000)
    fail(
      'Die gewählte Seite ist nicht vorhanden oder das Dokument überschreitet 2000 Seiten.',
    )
  // Structure elements with their own replacement text (ActualText/E/Alt)
  // lock exactly the marked-content sequences they own on this page.
  const tree = doc.catalog.lookup(n('StructTreeRoot')),
    seen = new Set<string>(),
    lockedMcids = new Set<number>(),
    // Owning structure element per MCID: lines of one paragraph often carry
    // their own marked-content sequences (LibreOffice) but one element.
    mcidOwner = new Map<number, number>()
  let structureNodes = 0,
    elements = 0,
    lockAllTagged = false
  const pageRef = page.ref.toString()
  const walk = (value: unknown, locked: boolean, pg: string | undefined, depth = 0, owner = 0): void => {
    if (value === undefined || value === null) return
    if (++structureNodes > 50000 || depth > 64) {
      lockAllTagged = true
      return
    }
    if (value instanceof PDFNumber) {
      if (pg === undefined || pg === pageRef) {
        if (locked) lockedMcids.add(value.asNumber())
        mcidOwner.set(value.asNumber(), owner)
      }
      return
    }
    if (value instanceof PDFRef) {
      if (seen.has(value.toString())) return
      seen.add(value.toString())
      walk(doc.context.lookup(value), locked, pg, depth + 1, owner)
      return
    }
    if (value instanceof PDFArray) {
      for (const child of value.asArray()) walk(child, locked, pg, depth + 1, owner)
      return
    }
    if (!(value instanceof PDFDict)) return
    const own = value.get(n('Pg'))
    const at = own instanceof PDFRef ? own.toString() : pg
    const lock =
      locked ||
      value.has(n('ActualText')) ||
      value.has(n('E')) ||
      (value.has(n('Alt')) && value.lookup(n('S'))?.toString() !== '/Figure')
    const type = value.lookup(n('Type'))?.toString()
    if (type === '/MCR') {
      const id = value.lookup(n('MCID'))
      if (id instanceof PDFNumber && !value.has(n('Stm')) && (at === undefined || at === pageRef)) {
        if (lock) lockedMcids.add(id.asNumber())
        mcidOwner.set(id.asNumber(), owner)
      }
      return
    }
    if (type === '/OBJR') return
    walk(value.get(n('K')), lock, at, depth + 1, ++elements)
  }
  if (tree instanceof PDFDict) walk(tree.get(n('K')), false, undefined)
  if (
    page.getRotation().angle !== 0 ||
    (page.node.lookupMaybe(n('UserUnit'), PDFNumber)?.asNumber() ?? 1) !== 1
  )
    fail(
      'Die gewählte Seite hat eine noch nicht unterstützte Drehung oder UserUnit-Skalierung.',
    )
  const resources = page.node.Resources(),
    objects = resources?.lookupMaybe(n('XObject'), PDFDict),
    obstacles: Rect[] = [],
    runs: Run[] = []
  // Every annotation (links, comments, form widgets, stamps) is a protected
  // area: corrected text may neither grow into it nor reduce its distance.
  const annots = page.node.Annots()
  for (let i = 0; i < Math.min(annots?.size() ?? 0, 5000); i++) {
    const a = annots!.lookup(i)
    if (!(a instanceof PDFDict) || a.lookup(n('Subtype'))?.toString() === '/Popup') continue
    const r = a.lookup(n('Rect'))
    if (!(r instanceof PDFArray) || r.size() !== 4)
      fail('Eine Anmerkung hat keine sicheren Bereichsgrenzen.')
    const v = r
      .asArray()
      .map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN))
    if (!v.every(Number.isFinite)) fail('Ein Anmerkungsbereich ist ungültig.')
    obstacles.push({
      left: Math.min(v[0], v[2]),
      right: Math.max(v[0], v[2]),
      bottom: Math.min(v[1], v[3]),
      top: Math.max(v[1], v[3]),
      decor: true,
    })
  }
  const annotationCount = obstacles.length
  const contents = page.node.get(n('Contents')),
    resolved = doc.context.lookup(contents),
    refs =
      resolved instanceof PDFArray
        ? resolved.asArray()
        : contents
          ? [contents]
          : []
  if (refs.length > 128) fail('Die Seite enthält zu viele Inhaltsstreams.')
  let glyphBudget = 0,
    glyphCount = 0
  let state = initial(),
    inText = false,
    markDepth = 0,
    total = 0,
    path: Rect | undefined,
    pendingClip = false,
    rectangularPath = false,
    btId = 0,
    mcCounter = 0,
    paint = 0
  interface Mark {
    id: number
    tagged: boolean
    mcid?: number
    actual?: string
    lock?: string
  }
  const marks: Mark[] = [],
    spans = new Map<number, number>(),
    barriers: BlockRect[] = []
  const stack: State[] = [],
    fonts = new Map<string, SourceFont>(),
    ops: ContentToken[] = []
  for (let streamIndex = 0; streamIndex < refs.length; streamIndex++) {
    const ref = refs[streamIndex],
      raw = doc.context.lookup(ref)
    if (!(ref instanceof PDFRef) || !(raw instanceof PDFRawStream))
      fail('Ein Seiten-Inhaltsstream ist nicht eindeutig referenziert.')
    const text = await streamText(raw),
      stream = { ref, text, index: streamIndex }
    total += text.length
    if (total > 2 * 1024 * 1024)
      fail('Die entpackten Seiteninhalte überschreiten 2 MiB.')
    for (const token of contentTokens(text, true)) {
      if (token.kind !== 'operator') {
        if (ops.length >= 32) fail('Ein PDF-Operator hat zu viele Argumente.')
        ops.push(token)
        continue
      }
      const op = token.raw,
        nums = (count: number) => {
          if (ops.length !== count)
            fail(`PDF-Operator ${op} hat eine unerwartete Argumentzahl.`)
          return ops.map(numeric)
        }
      const addPoint = (x: number, y: number) => {
        const p = point(state.ctm, x, y),
          r = { left: p[0], right: p[0], bottom: p[1], top: p[1] }
        path = path ? union(path, r) : r
      }
      const paintCount = () => paint++
      const finishPath = (paint: boolean, stroke = false) => {
        if (path && paint) {
          paintCount()
          barriers.push(path)
          // Fills paint exactly their path; strokes reach at most half the
          // line width times the miter limit (or a square cap) beyond it.
          const pad = stroke
            ? (Math.max(state.lineWidth, 1) / 2) *
              Math.max(state.miter, Math.SQRT2) *
              (Math.hypot(state.ctm[0], state.ctm[1]) +
                Math.hypot(state.ctm[2], state.ctm[3]))
            : 0
          obstacles.push({
            left: path.left - pad,
            right: path.right + pad,
            bottom: path.bottom - pad,
            top: path.top + pad,
            decor: true,
          })
        }
        if (pendingClip) {
          if (!path) fail('Eine Clipfläche ohne Pfad ist ungültig.')
          // A non-rectangular clip is bounded by its box; text drawn under it
          // could be cut by the real shape and therefore stays unchanged.
          if (!rectangularPath)
            state.locked = 'Text unter einer nicht rechteckigen Clipfläche bleibt unverändert.'
          state.clip = state.clip
            ? {
                left: Math.max(state.clip.left, path.left),
                right: Math.min(state.clip.right, path.right),
                bottom: Math.max(state.clip.bottom, path.bottom),
                top: Math.min(state.clip.top, path.top),
              }
            : path
        }
        path = undefined
        pendingClip = false
        rectangularPath = false
      }
      switch (op) {
        case 'q':
          nums(0)
          if (inText || stack.length >= 32)
            fail('Der PDF-Grafikzustand ist zu tief verschachtelt.')
          stack.push(copy(state))
          break
        case 'Q':
          nums(0)
          if (inText || !stack.length)
            fail('Ein PDF-Grafikzustand ist nicht ausgeglichen.')
          state = stack.pop()!
          break
        case 'cm': {
          const v = nums(6) as Matrix
          if (inText)
            fail(
              'Eine Transformation innerhalb eines Textobjekts wird nicht unterstützt.',
            )
          state.ctm = mul(state.ctm, v)
          break
        }
        case 'BT':
          nums(0)
          if (inText)
            fail('Verschachtelte Textobjekte werden nicht unterstützt.')
          inText = true
          btId++
          state.tm = identity()
          state.lm = identity()
          state.dx = 0
          break
        case 'ET':
          nums(0)
          if (!inText) fail('Ein Textobjekt ist nicht ausgeglichen.')
          inText = false
          break
        case 'Tf': {
          if (!inText || ops.length !== 2)
            fail('Ein Schriftwechsel ist ungültig.')
          const key = name(ops[0])
          if (!fonts.has(key) && fonts.size >= 32)
            fail('Die Seite verwendet mehr als 32 Schriftressourcen.')
          state.fontRaw = ops[0].raw
          state.size = numeric(ops[1])
          if (state.size <= 0 || state.size > 512)
            fail('Die Schriftgröße wird nicht unterstützt.')
          try {
            state.font = fonts.get(key) ?? (await readPageFont(page, key))
            if (!fonts.has(key)) {
              glyphBudget += state.font.decode.size
              if (glyphBudget > 131072)
                fail(
                  'Die Schrift-Zeichentabellen überschreiten die sichere Gesamtgröße.',
                )
            }
            fonts.set(key, state.font)
          } catch (error) {
            fail(
              `Seite ${pageIndex + 1}, Schrift ${key}: ${error instanceof UnmeasurableFont || error instanceof Error ? error.message : 'Schrift nicht unterstützt.'}`,
            )
          }
          break
        }
        case 'Tm':
          if (!inText) fail('Textposition außerhalb eines Textobjekts.')
          state.tm = nums(6) as Matrix
          state.lm = [...state.tm]
          state.dx = 0
          break
        case 'Td':
        case 'TD': {
          if (!inText) fail('Textverschiebung außerhalb eines Textobjekts.')
          const [x, y] = nums(2)
          if (op === 'TD') state.leading = -y
          state.lm = mul(state.lm, [1, 0, 0, 1, x, y])
          state.tm = [...state.lm]
          state.dx = 0
          break
        }
        case 'T*':
          nums(0)
          if (!inText) fail('Zeilenwechsel außerhalb eines Textobjekts.')
          state.lm = mul(state.lm, [1, 0, 0, 1, 0, -state.leading])
          state.tm = [...state.lm]
          state.dx = 0
          break
        case 'TL':
          state.leading = nums(1)[0]
          break
        case 'Tc':
          state.tc = nums(1)[0]
          break
        case 'Tw':
          state.tw = nums(1)[0]
          break
        case 'Tz':
          state.hz = nums(1)[0] / 100
          if (state.hz <= 0 || state.hz > 10)
            fail('Die horizontale Textskalierung wird nicht unterstützt.')
          break
        case 'Ts':
          state.rise = nums(1)[0]
          break
        case 'Tr':
          state.render = nums(1)[0]
          if (!Number.isInteger(state.render) || state.render < 0 || state.render > 7)
            fail('Ungültiger Textdarstellungsmodus.')
          break
        case "'":
        case '"':
        case 'Tj':
        case 'TJ': {
          const quoted = op === '"' ? 3 : 1
          if (!inText || !state.font || ops.length !== quoted)
            fail('Ein Textoperator hat keinen eindeutigen Schriftzustand.')
          let quote: Run['quote']
          if (op === '"') {
            quote = { aw: numeric(ops[0]), ac: numeric(ops[1]) }
            state.tw = quote.aw
            state.tc = quote.ac
          }
          if (op === "'" || op === '"') {
            state.lm = mul(state.lm, [1, 0, 0, 1, 0, -state.leading])
            state.tm = [...state.lm]
            state.dx = 0
          }
          const target = ops[quoted - 1],
            items =
              op === 'TJ' && target.kind === 'array'
                ? target.items
                : op !== 'TJ' && target.kind === 'string'
                  ? [target]
                  : undefined
          if (!items) fail('Das TJ-Array enthält nicht unterstützte Elemente.')
          const font = state.font
          const codes: number[] = [],
            adjustments: number[] = []
          for (const item of items) {
            if (item.kind === 'number') {
              adjustments[codes.length] =
                (adjustments[codes.length] ?? 0) + numeric(item)
              continue
            }
            if (
              item.kind !== 'string' ||
              !item.bytes ||
              item.bytes.length % font.codeBytes
            )
              fail('Ein TJ-Array enthält ungültige Zeichencodes.')
            for (let k = 0; k < item.bytes.length; k += font.codeBytes)
              codes.push(
                font.codeBytes === 1
                  ? item.bytes[k]
                  : item.bytes[k] * 256 + item.bytes[k + 1],
              )
          }
          if (codes.length > 4096)
            fail('Eine Textstelle überschreitet 4096 Zeichen.')
          // ActualText spans own the meaning of the glyphs they enclose.
          // A span whose text equals the decoded glyphs adds no meaning.
          const span = [...marks].reverse().find((m) => m.actual !== undefined)
          const decoded = codes.map((c) => font.decode.get(c) ?? '\ufffd').join(''),
            override = span && span.actual !== decoded ? span.actual : undefined
          const measured = glyphs(font, codes, adjustments, state, override),
            matrix = mul(state.ctm, state.tm)
          if (!codes.length) {
            // A number-only TJ only moves the text position.
            state.tm = mul(state.tm, [1, 0, 0, 1, measured.advance, 0])
            state.dx += measured.advance
            break
          }
          if (runs.length >= 20000)
            fail('Die Seite enthält zu viele einzelne Textstellen.')
          if (++glyphCount > 200000)
            fail('Die Seite enthält zu viele Zeichen für eine sichere Analyse.')
          const structural = [...marks].reverse().find((m) => m.actual === undefined)
          const scale = uniformScale(matrix)
          const locked =
            state.locked ??
            (state.pattern ? 'Text mit Muster-Füllung bleibt unverändert.' : undefined) ??
            marks.find((m) => m.lock)?.lock ??
            font.locked ??
            (state.render !== 0
              ? 'Unsichtbarer, konturierter oder als Clip verwendeter Text bleibt unverändert.'
              : undefined) ??
            (structural?.mcid !== undefined && lockedMcids.has(structural.mcid)
              ? 'Der Strukturbaum enthält für diesen Text eigenen Ersatztext.'
              : undefined) ??
            (lockAllTagged && structural?.tagged
              ? 'Der Strukturbaum ist zu groß für eine sichere Prüfung von Ersatztexten.'
              : undefined)
          const view: SimpleSourceRun = {
            id: `mixed:${pageIndex}:${runs.length}`,
            pageIndex,
            text: measured.text,
            fontName: font.name,
            fontSize: state.size * (scale ?? 1),
            x: matrix[4],
            baseline: matrix[5] + state.rise * matrix[3],
            width: measured.width * (scale ?? 1),
          }
          runs.push({
            view,
            bounds: measured.bounds,
            clip: state.clip,
            font,
            state: copy(state),
            stream,
            token: op === 'TJ' || op === 'Tj' ? target : ops[0],
            end: token.end,
            advance: measured.advance,
            adjustments,
            codes,
            fontRaw: state.fontRaw ?? '',
            fill: state.fill,
            bt: btId,
            mc: structural?.id ?? 0,
            tagged: !!structural?.tagged,
            mcid: structural?.mcid,
            paint,
            locked,
            actual: override,
            span: override !== undefined ? span!.id : undefined,
            op,
            quote,
            scale,
          })
          if (override !== undefined) spans.set(span!.id, (spans.get(span!.id) ?? 0) + 1)
          state.tm = mul(state.tm, [1, 0, 0, 1, measured.advance, 0])
          state.dx += measured.advance
          break
        }
        case 'Do': {
          if (inText || ops.length !== 1)
            fail('Ein XObject-Aufruf ist ungültig.')
          const object = objects?.lookup(n(name(ops[0])))
          if (!(object instanceof PDFRawStream))
            fail('Ein Bild oder Form-XObject kann nicht aufgelöst werden.')
          const subtype = object.dict.lookup(n('Subtype'))?.toString()
          let r: Rect
          if (subtype === '/Image') r = box(state.ctm, 0, 0, 1, 1)
          else if (subtype === '/Form') {
            const b = object.dict.lookup(n('BBox')),
              m = object.dict.lookup(n('Matrix'))
            if (
              !(b instanceof PDFArray) ||
              b.size() !== 4 ||
              (m && (!(m instanceof PDFArray) || m.size() !== 6))
            )
              fail('Eine Formgrafik hat keine sicheren Grenzen.')
            const v = b
                .asArray()
                .map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN)),
              mv =
                m instanceof PDFArray
                  ? m
                      .asArray()
                      .map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN))
                  : identity()
            if (
              ![...v, ...mv].every(Number.isFinite) ||
              v[2] < v[0] ||
              v[3] < v[1]
            )
              fail('Die Grenzen einer Formgrafik sind ungültig.')
            r = box(
              mul(state.ctm, mv as Matrix),
              v[0],
              v[1],
              v[2] - v[0],
              v[3] - v[1],
            )
          } else fail('Dieser XObject-Typ wird noch nicht unterstützt.')
          obstacles.push(r)
          barriers.push(r)
          paintCount()
          break
        }
        case 'gs': {
          if (ops.length !== 1) fail('Ein Grafikzustand ist ungültig.')
          const g = resources
            ?.lookupMaybe(n('ExtGState'), PDFDict)
            ?.lookup(n(name(ops[0])))
          if (!(g instanceof PDFDict))
            fail('Ein Grafikzustand kann nicht aufgelöst werden.')
          // Corrections are written at the original position in the stream, so
          // transparency, blend and overprint settings apply unchanged. Only
          // states that redefine the font or mask by shape lock the text.
          // Effective compositing parameters (not the operator history).
          const effective = new Map<string, string>(state.gs ? (JSON.parse(state.gs) as [string, string][]) : [])
          for (const [key, val] of g.entries())
            if (!['/Type', '/LW', '/LC', '/LJ', '/ML', '/D', '/RI', '/FL', '/SM', '/SA'].includes(key.toString()))
              effective.set(key.toString(), val.toString())
          // Default values are equivalent to never having set them.
          const defaults: Record<string, string> = { '/BM': '/Normal', '/CA': '1', '/ca': '1', '/SMask': '/None', '/AIS': 'false', '/OP': 'false', '/op': 'false', '/OPM': '0', '/TK': 'true' }
          for (const [k, v] of effective) if (defaults[k] === v) effective.delete(k)
          state.gs = effective.size ? JSON.stringify([...effective].sort()) : ''
          for (const [key, val] of g.entries()) {
            const k = key.toString()
            if (k === '/Font') fail('Ein Grafikzustand setzt eine eigene Schrift.')
            if (k === '/LW' && val instanceof PDFNumber) state.lineWidth = Math.max(0, val.asNumber())
            if (k === '/SMask' && val.toString() !== '/None')
              state.locked = 'Text unter einer Soft-Maske bleibt unverändert.'
          }
          break
        }
        case 'm':
        case 'l': {
          rectangularPath = false
          const v = nums(2)
          addPoint(v[0], v[1])
          break
        }
        case 'c':
        case 'v':
        case 'y': {
          rectangularPath = false
          const v = nums(op === 'c' ? 6 : 4)
          for (let j = 0; j < v.length; j += 2) addPoint(v[j], v[j + 1])
          break
        }
        case 're': {
          rectangularPath =
            !path &&
            Math.abs(state.ctm[1]) < 1e-8 &&
            Math.abs(state.ctm[2]) < 1e-8
          const [x, y, w, h] = nums(4)
          addPoint(x, y)
          addPoint(x + w, y + h)
          addPoint(x + w, y)
          addPoint(x, y + h)
          break
        }
        case 'h':
          nums(0)
          break
        case 'W':
        case 'W*':
          nums(0)
          pendingClip = true
          break
        case 'n':
          nums(0)
          finishPath(false)
          break
        case 'S':
        case 's':
        case 'f':
        case 'F':
        case 'f*':
        case 'B':
        case 'B*':
        case 'b':
        case 'b*':
          nums(0)
          finishPath(true, op !== 'f' && op !== 'F' && op !== 'f*')
          break
        case 'w':
          state.lineWidth = nums(1)[0]
          if (state.lineWidth < 0) fail('Negative Linienbreite.')
          break
        case 'J':
        case 'j':
          nums(1)
          break
        case 'M':
          state.miter = Math.max(1, nums(1)[0])
          if (state.miter > 1000) fail('Der Gehrungsgrenzwert ist zu groß.')
          break
        case 'd':
          if (
            ops.length !== 2 ||
            ops[0].kind !== 'array' ||
            ops[0].items?.some((t) => t.kind !== 'number')
          )
            fail('Nicht unterstütztes Strichmuster.')
          numeric(ops[1])
          break
        case 'rg':
        case 'g':
        case 'k':
          nums(op === 'rg' ? 3 : op === 'g' ? 1 : 4)
          state.fill = `${ops.map((t) => t.raw).join(' ')} ${op}`
          state.fillSpace = undefined
          state.pattern = false
          break
        case 'RG':
          nums(3)
          break
        case 'G':
          nums(1)
          break
        case 'K':
          nums(4)
          break
        case 'ri':
          if (ops.length !== 1) fail('Ungültige Rendering-Absicht.')
          name(ops[0])
          break
        case 'BMC':
          if (ops.length !== 1) fail('Ungültiges Struktur-Tag.')
          name(ops[0])
          if (++markDepth > 64) fail('Zu tief verschachtelte Struktur-Tags.')
          marks.push({ id: ++mcCounter, tagged: false })
          break
        case 'BDC': {
          if (ops.length !== 2) fail('Ungültiges Struktur-Tag.')
          name(ops[0])
          const props = ops[1],
            mark: Mark = { id: ++mcCounter, tagged: false }
          if (props.kind === 'dict') {
            const items = props.items ?? []
            for (let k = 0; k + 1 < items.length; k += 2) {
              const key = items[k].raw,
                value = items[k + 1]
              if (key === '/MCID' && value.kind === 'number') {
                mark.tagged = true
                mark.mcid = Number(value.raw)
              } else if (key === '/ActualText') {
                const text = value.kind === 'string' && value.bytes ? textString(value.bytes) : undefined
                if (text === undefined) mark.lock = 'Ein Ersatztext ist nicht lesbar.'
                else mark.actual = text
              } else if (key === '/Alt' || key === '/E')
                mark.lock = 'Diese Textstelle besitzt eigenen Ersatztext (Alt/E) und bleibt unverändert.'
            }
          } else if (props.kind === 'name') {
            const prop = resources
              ?.lookupMaybe(n('Properties'), PDFDict)
              ?.lookup(n(name(props)))
            if (!(prop instanceof PDFDict)) mark.lock = 'Unbekannte Inhaltseigenschaften.'
            else {
              const type = prop.lookup(n('Type'))?.toString()
              if (type === '/OCG' || type === '/OCMD')
                mark.lock = 'Text in einer optionalen Inhaltsebene bleibt unverändert.'
              const id = prop.lookup(n('MCID'))
              if (id instanceof PDFNumber) {
                mark.tagged = true
                mark.mcid = id.asNumber()
              }
              const actual = prop.lookup(n('ActualText'))
              if (actual instanceof PDFString || actual instanceof PDFHexString) mark.actual = actual.decodeText()
              if (prop.has(n('Alt')) || prop.has(n('E')))
                mark.lock = 'Diese Textstelle besitzt eigenen Ersatztext (Alt/E) und bleibt unverändert.'
            }
          } else fail('Ungültiges Struktur-Tag.')
          if (++markDepth > 64) fail('Zu tief verschachtelte Struktur-Tags.')
          marks.push(mark)
          break
        }
        case 'EMC':
          nums(0)
          if (--markDepth < 0) fail('Unausgeglichene Struktur-Tags.')
          marks.pop()
          break
        case 'MP':
        case 'DP':
        case 'BX':
        case 'EX':
        case 'i':
        case 'd0':
        case 'd1':
          break
        case 'cs':
          if (ops.length !== 1) fail('Ungültiger Farbraum.')
          state.fillSpace = ops[0].raw
          state.fill = `${ops[0].raw} cs`
          state.pattern = ops[0].raw === '/Pattern'
          break
        case 'sc':
        case 'scn':
          if (!ops.length || ops.length > 33) fail('Ungültige Füllfarbe.')
          if (ops.some((t) => t.kind !== 'number' && t.kind !== 'name')) fail('Ungültige Füllfarbe.')
          state.fill = `${state.fillSpace ? `${state.fillSpace} cs ` : ''}${ops.map((t) => t.raw).join(' ')} ${op}`
          state.pattern = ops.some((t) => t.kind === 'name')
          break
        case 'CS':
        case 'SC':
        case 'SCN':
          break
        case 'sh': {
          if (ops.length !== 1) fail('Ungültige Farbverlaufsfläche.')
          const area = state.clip ?? pageRect(page.getMediaBox())
          obstacles.push(area)
          paintCount()
          break
        }
        case 'BI': {
          // The lexer delivers an inline image as one operator with its data.
          obstacles.push(box(state.ctm, 0, 0, 1, 1))
          paintCount()
          break
        }
        default:
          fail(
            `Seite ${pageIndex + 1}: PDF-Operator „${op}“ wird für sichere Textkorrekturen noch nicht unterstützt.`,
          )
      }
      ops.length = 0
    }
    if (ops.length)
      fail(
        'Über mehrere Streams verteilte PDF-Operanden werden noch nicht unterstützt.',
      )
  }
  if (inText || stack.length || markDepth || pendingClip || path)
    fail(
      'Die Seite enthält einen nicht abgeschlossenen Text-, Grafik- oder Clipzustand.',
    )
  // An ActualText span maps to exactly one glyph (ligature, no-break space);
  // anything else cannot be split into editable characters and stays locked.
  for (const run of runs)
    if (run.span !== undefined && (spans.get(run.span)! > 1 || run.codes.length !== 1))
      run.locked ??= 'Ein Ersatztext (ActualText) über mehrere Zeichen bleibt unverändert.'
  const inputs: BlockInput[] = runs.map((run, index) => {
    const scale = run.scale ?? 1
    return {
      index,
      text: run.view.text,
      codes: run.codes,
      chars: run.actual !== undefined ? [run.actual] : run.codes.map((c) => run.font.decode.get(c) ?? '\ufffd'),
      actual: run.actual !== undefined,
      adjustments: run.adjustments,
      font: run.font,
      fontRaw: run.fontRaw,
      fill: run.fill,
      tf: run.state.size,
      tc: run.state.tc,
      tw: run.state.tw,
      scale,
      size: run.state.size * scale,
      x: run.view.x,
      baseline: run.view.baseline,
      advance: run.advance * scale,
      eligible: blockEligible(run),
      key: [
        run.mcid !== undefined && mcidOwner.has(run.mcid) ? `e${mcidOwner.get(run.mcid)}` : run.mc,
        run.paint,
        JSON.stringify(run.clip ?? null),
        run.state.ctm.join(','),
        run.state.tm.slice(0, 4).join(','),
        run.state.gs,
      ].join('|'),
      tagged: run.tagged,
    }
  })
  const blocks = buildBlocks(inputs, pageIndex, [...obstacles.slice(0, annotationCount), ...barriers])
  return { doc, page, runs, obstacles, revision, refs, blocks, inputs }
}
/** Characters of a run per code (an ActualText glyph carries its whole text). */
const runChars = (run: Run) =>
  run.actual !== undefined ? [run.actual] : run.codes.map((c) => run.font.decode.get(c) ?? '')
/** A fragment may join a reconstructed block only as unrotated, unmirrored,
 * uniformly scaled horizontal text without Tz/rise, with proved widths and
 * characters from the supported alphabet. */
function blockEligible(run: Run) {
  const chars = runChars(run)
  return (
    !run.locked &&
    !!run.fontRaw &&
    run.codes.length > 0 &&
    run.scale !== undefined &&
    run.state.hz === 1 &&
    run.state.rise === 0 &&
    Math.abs(run.state.tc) <= run.state.size &&
    Math.abs(run.state.tw) <= run.state.size &&
    supportedSourceText(chars.join('')) &&
    run.codes.every((code, i) => {
      const char = chars[i]
      return (
        !!char &&
        Array.from(char).length <= 4 &&
        (Number.isFinite(run.font.advances?.get(code)) ||
          (Array.from(char).length === 1 && run.font.codec.encode(char).ok))
      )
    })
  )
}
/** Single-fragment correction (no block): 1:1 characters the font encodes. */
function editable(run: Run) {
  return (
    !run.locked &&
    run.actual === undefined &&
    run.scale !== undefined &&
    run.state.hz === 1 &&
    run.state.rise === 0 &&
    supportedSourceText(run.view.text) &&
    run.codes.every(
      (code) => Array.from(run.font.decode.get(code) ?? '').length === 1,
    ) &&
    !!run.view.text.trim() &&
    run.font.codec.encode(run.view.text).ok
  )
}
export async function inspectPageSource(bytes: Uint8Array, pageIndex: number) {
  let result: Analysis
  try {
    result = await analyze(bytes, pageIndex)
  } catch (error) {
    // The older single-stream adapter still covers its own verified subset.
    try {
      const simple = await inspectSimpleSourceText(bytes)
      const runs = simple.runs.filter((r) => r.pageIndex === pageIndex)
      if (runs.length) return { ...simple, runs, blocks: [], fonts: [] }
    } catch {
      /* report the page-scoped reason below */
    }
    throw error
  }
  const geometry = (r: Run) => {
    const scale = r.scale ?? 1,
      chars = runChars(r)
    // Locked spans (e.g. multi-code ActualText) have no per-code characters.
    if (chars.length !== r.codes.length) return undefined
    let offset = 0
    const characters = r.codes.flatMap((code, i) => {
      // Preserve original TJ positioning and Tc/Tw, not replacement metrics.
      offset -= ((r.adjustments[i] ?? 0) * r.state.size * scale) / 1000
      const char = chars[i]
      const width =
        ((codeAdvance(r.font, code, char) * r.state.size) / 1000 +
          r.state.tc +
          (r.font.codeBytes === 1 && code === 32 ? r.state.tw : 0)) *
        scale
      // A ligature glyph is split evenly for selection geometry only.
      const parts = Array.from(char).length
      const value = Array.from({ length: parts }, (_, k) => ({
        offset: offset + (width * k) / parts,
        width: width / parts,
      }))
      offset += width
      return value
    })
    return characters.length === r.view.text.length &&
      characters.every(
        (c, i) =>
          Number.isFinite(c.offset) &&
          Number.isFinite(c.width) &&
          c.width > 0 &&
          (i === 0 || c.offset >= characters[i - 1].offset),
      )
      ? characters
      : undefined
  }
  const views = result.runs.map(geometry),
    member = new Map<number, SourceBlock>()
  // A block is offered only as a whole; one unsafe member keeps it fragment-only.
  const offered = result.blocks.filter((block) => block.members.every((i) => views[i]))
  for (const block of offered) for (const i of block.members) member.set(i, block)
  // One shared object per block: structured clone sends shared objects once,
  // not once per member run (HTML renderers emit one run per character).
  const paragraphs = new Map<SourceBlock, NonNullable<SimpleSourceRun['paragraph']>>()
  const paragraphOf = (block: SourceBlock) => {
    let p = paragraphs.get(block)
    if (!p)
      paragraphs.set(block, (p = {
        text: block.text,
        lineCount: block.lines.length,
        leading: block.leading,
        width: block.right - block.lines[0].left,
        separator: '',
        automatic: true,
      }))
    return p
  }
  const runs: SimpleSourceRun[] = []
  result.runs.forEach((r, i) => {
    const block = member.get(i)
    if (!block && !editable(r)) return
    const characters = views[i]
    runs.push({
      ...r.view,
      selection: characters ? { characters, groupId: block?.id } : undefined,
      paragraph: block ? paragraphOf(block) : undefined,
    })
  })
  if (!runs.length)
    fail(
      `Seite ${pageIndex + 1}: Keine sicher kodierbare, horizontal bearbeitbare Textstelle gefunden. Scans benötigen OCR; Type3-Schriften, gedrehter Text oder geschützte Bereiche können einzelne Stellen ausschließen.`,
    )
  // Page content once for all blocks; each block lists its own rectangles.
  const rectOf = new Map<number, number>(),
    rects: Box[] = []
  const plain = (r: Rect): Box => ({ left: r.left, right: r.right, bottom: r.bottom, top: r.top })
  result.runs.forEach((r, i) => {
    if (!r.view.text.trim()) return
    rectOf.set(i, rects.length)
    rects.push(plain(r.bounds))
  })
  for (const o of result.obstacles) rects.push(plain(o))
  const models = editModels(
    offered.map((block) => ({
      block,
      runId: result.runs[block.members[0]].view.id,
      expectedText: result.runs[block.members[0]].view.text,
      ...blockSpace(result, block, rectOf),
    })),
  )
  return { digest: result.revision, runs, ...models, rects }
}
/** Free space for the inline editor: the display estimate (`room`, `limit`)
 * and the exact rule inputs (`space`) that the worker check also uses. */
function blockSpace(result: Analysis, block: SourceBlock, rectOf: Map<number, number>) {
  const ctx = layoutContext(result, block, block.glyphs)
  const last = block.lines.at(-1)!,
    left = Math.min(...block.lines.map((l) => l.left))
  let room = 0
  if (block.leading > 0)
    for (let j = 1; j <= 8; j++) {
      const baseline = last.baseline - j * block.leading
      const rect = { left, right: block.right, bottom: baseline + ctx.bandBottom, top: baseline + ctx.bandTop }
      if (ctx.blocked(rect, undefined)) break
      room = j
    }
  // Growth to the right of a single line until the protected distance.
  const slot = ctx.oldSlots[0]
  let limit = Math.min(...ctx.limits.map((l) => l.right), ctx.clip?.right ?? Infinity)
  if (block.lines.length > 1) limit = Math.min(limit, block.right)
  else
    for (const other of ctx.others) {
      if (overlap(slot, other) || other.top <= slot.bottom || other.bottom >= slot.top || other.left < slot.right) continue
      limit = Math.min(limit, other.left - Math.min(3, separation(slot, other)))
    }
  // Glyphs under links, highlights or underlines stay fixed (see previewBlock).
  const pinned: number[] = []
  if (ctx.decorations.length) {
    const original = block.lines.map((l) => ({ ...l, ...placeLine(block.glyphs, l.from, l.to, l.left) }))
    for (const b of glyphBoxes(block.glyphs, original))
      if (b.orig >= 0 && ctx.decorations.some((d) => overlap(b.box, d))) pinned.push(b.orig)
  }
  const { limits, clip, whole, leading, bandBottom, bandTop } = ctx.space
  const own = block.members.map((i) => rectOf.get(i)).filter((i): i is number => i !== undefined)
  return { room, limit, slots: ctx.oldSlots, pinned, space: { limits, clip, whole, leading, bandBottom, bandTop, own } }
}
export async function previewPageSource(
  input: Uint8Array,
  selection: SourceSelection,
  replacement: string,
) {
  selection = { ...selection }
  if (!selection.runId.startsWith('mixed:'))
    return previewSimpleSourceCorrection(input, selection, replacement)
  const pageIndex = Number(selection.runId.split(':')[1]),
    result = await analyze(input, pageIndex),
    { doc, page, runs, obstacles, revision, refs } = result
  const run = runs.find((r) => r.view.id === selection.runId)
  if (
    selection.digest !== revision ||
    !run ||
    run.view.text !== selection.expectedText
  )
    fail('Die Textauswahl ist veraltet. Bitte die Textstelle erneut auswählen.')
  if (selection.scope === 'paragraph') {
    const index = runs.indexOf(run),
      block = result.blocks.find((b) => b.members.includes(index))
    if (!block)
      fail(
        'Diese Textstelle ist keinem nachgewiesenen Absatz zugeordnet. Sie kann nur als einzelnes Textfragment korrigiert werden.',
      )
    return previewBlock(result, block, replacement, pageIndex)
  }
  if (!editable(run))
    fail(
      'Der Schrift- oder Transformationszustand dieser Textstelle ist nicht sicher bearbeitbar.',
    )
  // Edge spaces of a fragment are ordinary text; only a blank result is refused.
  if (!supportedSourceText(replacement) || !replacement.trim())
    fail('Dieser Ersatztext wird nicht unterstützt.')
  const encoded = run.font.codec.encode(replacement)
  if (!encoded.ok)
    fail(
      'Ein benötigtes Zeichen fehlt in der Originalschrift oder ist nicht eindeutig kodierbar.',
    )
  const codes = encoded.value.hex
      .match(new RegExp(`.{${run.font.codeBytes * 2}}`, 'g'))!
      .map((v) => parseInt(v, 16)),
    chars = Array.from(replacement),
    old = Array.from(run.view.text),
    adjustments: number[] = []
  let prefix = 0,
    suffix = 0
  while (
    prefix < Math.min(chars.length, old.length) &&
    chars[prefix] === old[prefix]
  )
    prefix++
  while (
    suffix < Math.min(chars.length - prefix, old.length - prefix) &&
    chars[chars.length - 1 - suffix] === old[old.length - 1 - suffix]
  )
    suffix++
  // Preserve kerning only inside unchanged prefix/suffix pairs. Never copy a
  // numeric TJ correction onto a newly introduced glyph pair or squeeze to fit.
  for (let i = 1; i < codes.length; i++) {
    if (i < prefix) adjustments[i] = run.adjustments[i] ?? 0
    else if (i > chars.length - suffix)
      adjustments[i] = run.adjustments[old.length - (chars.length - i)] ?? 0
  }
  const candidate = glyphs(run.font, codes, adjustments, run.state),
    bounds = candidate.bounds
  for (const b of [page.getMediaBox(), page.getCropBox()])
    if (
      !contains(
        { left: b.x, right: b.x + b.width, bottom: b.y, top: b.y + b.height },
        bounds,
      )
    )
      fail('Die Korrektur überschreitet die Seiten- oder Zuschnittgrenze.')
  if (run.clip && !contains(run.clip, bounds))
    fail('Die Korrektur würde außerhalb der ursprünglichen Clipfläche liegen.')
  // Preserve existing tight typography; new ink may not enter another object's
  // bounds or reduce its existing separation (up to the 3 pt safety margin).
  for (const other of [
    ...runs.filter((r) => r !== run && r.view.text.trim()).map((r) => r.bounds),
    ...obstacles,
  ]) {
    if (!overlap(bounds, other, 3)) continue
    const oldOverlap = overlap(run.bounds, other)
    if (oldOverlap) {
      if (!contains(run.bounds, bounds))
        fail(
          'Die Textstelle überlappt bereits andere Inhalte; nur innerhalb der bisherigen sicheren Fläche korrigieren.',
        )
      continue
    }
    const gapX = Math.max(
        other.left - run.bounds.right,
        run.bounds.left - other.right,
        0,
      ),
      gapY = Math.max(
        other.bottom - run.bounds.top,
        run.bounds.bottom - other.top,
        0,
      )
    const gap = Math.min(3, Math.max(gapX, gapY))
    if (overlap(bounds, other, Math.max(0, gap - 0.001)))
      fail(
        'Die Korrektur würde den geschützten Abstand zu benachbartem Text, Bild, Link oder einer Grafik unterschreiten.',
      )
  }
  const hex = encoded.value.hex
  let operand = '['
  for (let i = 0; i < codes.length; i++) {
    if (adjustments[i]) operand += `${adjustments[i]} `
    operand += `<${hex.slice(i * run.font.codeBytes * 2, (i + 1) * run.font.codeBytes * 2)}> `
  }
  // Restore the original post-show text matrix. Independently positioned later
  // fragments and relative Td/Tj continuations must not drift as a side effect.
  const compensation =
    ((candidate.advance - run.advance) * 1000) / run.state.size / run.state.hz
  operand += `${Number(compensation.toFixed(9))}] TJ`
  const changed =
    run.stream.text.slice(0, run.token.start) +
    showPrefix(run) +
    operand +
    run.stream.text.slice(run.end)
  writeStreams(doc, page, refs, [{ stream: run.stream, text: changed }])
  const bytes = await doc.save({ updateFieldAppearances: false }),
    checked = await analyze(bytes, pageIndex)
  if (checked.runs.length !== runs.length)
    fail('Die Ergebnisprüfung fand eine unerwartete Anzahl von Textstellen.')
  for (let i = 0; i < runs.length; i++) {
    const before = runs[i],
      after = checked.runs[i]
    if (
      after.view.text !== (before === run ? replacement : before.view.text) ||
      after.view.fontName !== before.view.fontName ||
      Math.abs(after.view.x - before.view.x) > 1e-5 ||
      Math.abs(after.view.baseline - before.view.baseline) > 1e-5 ||
      Math.abs(after.advance - before.advance) > 1e-5
    )
      fail(
        'Die Ergebnisprüfung fand eine unerwartete Text- oder Positionsänderung.',
      )
  }
  return bytes
}

type Analysis = Awaited<ReturnType<typeof analyze>>
/** Replace changed content streams in place when unshared, copy-on-write otherwise. */
function writeStreams(
  doc: PDFDocument,
  page: Analysis['page'],
  refs: Analysis['refs'],
  changes: { stream: Run['stream']; text: string }[],
) {
  const newRefs = [...refs]
  let replaced = false
  for (const { stream, text } of changes) {
    let uses = 0
    for (const p of doc.getPages()) {
      const c = p.node.get(n('Contents')),
        v = doc.context.lookup(c),
        values = v instanceof PDFArray ? v.asArray() : c ? [c] : []
      uses += values.filter((r) => r.toString() === stream.ref.toString()).length
    }
    if (uses === 1) doc.context.assign(stream.ref, doc.context.flateStream(text))
    else {
      newRefs[stream.index] = doc.context.register(doc.context.flateStream(text))
      replaced = true
    }
  }
  if (replaced) page.node.set(n('Contents'), doc.context.obj(newRefs))
}
const pageRect = (b: { x: number; y: number; width: number; height: number }) => ({
  left: b.x,
  right: b.x + b.width,
  bottom: b.y,
  top: b.y + b.height,
})
/** Operators that a replaced ' or " show still has to perform. */
const showPrefix = (r: Run) =>
  r.op === "'"
    ? 'T* '
    : r.op === '"'
      ? `${pdfNumber(r.quote!.aw)} Tw ${pdfNumber(r.quote!.ac)} Tc T* `
      : ''
/** An invisible show with the same text-space advance as `dx`. */
const advanceShow = (r: Run, dx: number) =>
  `[${pdfNumber((-dx * 1000) / (r.state.size * r.state.hz))}] TJ\n`

/** Geometry shared by the worker check and the inline fit display. */
function layoutContext(result: Analysis, block: SourceBlock, edited: readonly BlockGlyph[]) {
  const { page, runs, obstacles } = result
  const members = new Set(block.members)
  let bandBottom = 0,
    bandTop = 0
  for (const g of [...block.glyphs, ...edited]) {
    bandBottom = Math.min(bandBottom, (g.font.bbox[1] * g.size) / 1000)
    bandTop = Math.max(bandTop, (g.font.bbox[3] * g.size) / 1000)
  }
  // Existing line slots keep origin and baseline. They are compared as
  // full-font bands from the unchanged origin, so glyph side bearings and
  // ascender/descender differences are not treated as movement; only a longer
  // line can approach other content. New lines below use real ink boxes.
  const slot = (left: number, baseline: number, right: number): Rect => slotBox({ bandBottom, bandTop }, left, baseline, right)
  const oldBoxes = block.lines.map((line) => {
    let r: Rect | undefined
    for (const i of line.runs)
      if (runs[i].view.text.trim()) r = r ? union(r, runs[i].bounds) : runs[i].bounds
    return r
  })
  const oldSlots = block.lines.map((l, i) =>
    slot(l.left, l.baseline, Math.max(placeLine(block.glyphs, l.from, l.to, l.left).extent, oldBoxes[i]?.right ?? -Infinity)),
  )
  const whole = oldBoxes.reduce<Rect | undefined>((a, b) => (a && b ? union(a, b) : (a ?? b)), undefined)
  const others = [
    ...runs.filter((r, i) => !members.has(i) && r.view.text.trim()).map((r) => r.bounds),
    ...obstacles,
  ]
  // Glyph overhangs that the original clip already cut (e.g. a side bearing
  // left of a column clip) stay as they were; nothing new may be cut.
  const ownClip = runs[block.members[0]].clip
  const clip = ownClip && whole ? union(ownClip, whole) : ownClip,
    limits = [page.getMediaBox(), page.getCropBox()].map(pageRect)
  const space: BlockSpace = { limits, clip, whole, leading: block.leading, bandBottom, bandTop, others }
  const background = (o: Rect) => !!whole && contains(o, whole)
  const blocked = (rect: Rect, old: Rect | undefined, ink = rect) => blockedBy(space, rect, old, ink)
  // Decorations: painted or annotated areas inside the paragraph (code
  // backgrounds, underlines, links). The text under them must not move.
  const decorations = obstacles.filter((o) => o.decor && !background(o) && oldSlots.some((s) => overlap(s, o)))
  return { bandBottom, bandTop, slot, oldSlots, others, clip, limits, blocked, decorations, space }
}
/** Per-glyph boxes of a laid-out block (ink, or a low band for blanks). */
function glyphBoxes(glyphs: readonly BlockGlyph[], lines: readonly PlacedLine[]) {
  const out: { orig: number; x: number; baseline: number; box: Rect }[] = []
  for (const line of lines)
    for (let k = line.from; k < line.to; k++) {
      if (hidden(glyphs, k, line.to)) continue
      const g = glyphs[k],
        x = line.positions[k - line.from]
      const b = g.char.trim() ? (g.font.boxes?.get(g.code) ?? g.font.bbox) : undefined
      const box = b
        ? { left: x + (b[0] * g.size) / 1000, right: x + (b[2] * g.size) / 1000, bottom: line.baseline + (b[1] * g.size) / 1000, top: line.baseline + (b[3] * g.size) / 1000 }
        : { left: x, right: x + g.width, bottom: line.baseline - 0.25 * g.size, top: line.baseline + 0.5 * g.size }
      out.push({ orig: g.orig, x, baseline: line.baseline, box })
    }
  return out
}
/** Re-lay out a reconstructed paragraph block: whole words move between its
 * lines, following fragments move with the text, and nothing outside the block
 * moves. The block stays top anchored; extra lines need proved free space.
 * Every member show is replaced by an invisible show of the same advance and
 * the text state is restored, so operators between members keep their effect. */
export async function previewBlock(result: Analysis, block: SourceBlock, replacement: string, pageIndex: number) {
  const { doc, page, runs, obstacles, refs } = result
  if (!supportedSourceText(replacement) || !replacement.trim())
    fail('Dieser Ersatztext wird nicht unterstützt.')
  if (replacement === block.text) fail('Der Absatz wurde nicht verändert.')
  const layout = layoutEdit(block, replacement)
  if (!layout.ok)
    fail(
      layout.reason === 'char'
        ? `Das Zeichen „${layout.char}“ fehlt in der Originalschrift dieses Absatzes oder ist nicht eindeutig kodierbar.`
        : 'Ein Wort ist breiter als der Absatz. Es wird nicht verkleinert, gestaucht oder neu getrennt.',
    )
  const { glyphs, lines: placed } = layout
  const ctx = layoutContext(result, block, glyphs)
  placed.forEach((line, i) => {
    const ink = inkBox(glyphs, line)
    if (!ink) return
    const old = ctx.oldSlots[i]
    const problem = ctx.blocked(old ? ctx.slot(line.left, line.baseline, Math.max(line.extent, ink.right)) : ink, old, ink)
    if (problem) fail(problem)
  })
  if (ctx.decorations.length) {
    const original = block.lines.map((l) => ({ ...l, ...placeLine(block.glyphs, l.from, l.to, l.left) }))
    const before = glyphBoxes(block.glyphs, original),
      after = glyphBoxes(glyphs, placed)
    const at = new Map(after.filter((a) => a.orig >= 0).map((a) => [a.orig, a]))
    for (const d of ctx.decorations) {
      const under = new Set<number>()
      for (const b of before) {
        if (!overlap(b.box, d)) continue
        under.add(b.orig)
        const a = at.get(b.orig)
        if (!a || Math.abs(a.x - b.x) > 0.01 || Math.abs(a.baseline - b.baseline) > 1e-6)
          fail('Text unter einer Hinterlegung, Unterstreichung oder einem Link würde sich verschieben. Diese Stellen bleiben fest; bitte nur Text ändern, der sie nicht verschiebt.')
      }
      if (after.some((a) => overlap(a.box, d) && !(a.orig >= 0 && under.has(a.orig))))
        fail('Text würde in eine Hinterlegung, Unterstreichung oder einen Link hineinlaufen.')
    }
  }
  const first = runs[block.members[0]],
    ctm = first.state.ctm,
    det = ctm[0] * ctm[3] - ctm[1] * ctm[2]
  const emitted = emitBlock(glyphs, placed, {
    linear: first.state.tm.slice(0, 4),
    toText: (x, y) => {
      const X = x - ctm[4],
        Y = y - ctm[5]
      return [(ctm[3] * X - ctm[2] * Y) / det, (-ctm[1] * X + ctm[0] * Y) / det]
    },
    toPage: (e, f) => [ctm[0] * e + ctm[2] * f + ctm[4], ctm[1] * e + ctm[3] * f + ctm[5]],
  })
  // Restore the text state of the first member, including its advance.
  const restore =
    `${first.fontRaw} ${pdfNumber(first.state.size)} Tf\n${first.fill}\n` +
    `${pdfNumber(first.state.tc)} Tc\n${pdfNumber(first.state.tw)} Tw\n` +
    `${first.state.lm.map(pdfNumber).join(' ')} Tm\n` +
    advanceShow(first, first.state.dx + first.advance)
  const members = new Set(block.members)
  const edits = new Map<Run['stream'], { start: number; end: number; text: string }[]>()
  block.members.forEach((index, i) => {
    const r = runs[index],
      list = edits.get(r.stream) ?? []
    // Operands may directly follow an operator (e.g. `0.2 Tc[...]TJ`): always delimit.
    list.push({
      start: r.token.start,
      end: r.end,
      text: i ? ` ${showPrefix(r)}${advanceShow(r, r.advance)}` : `\n${emitted.content}${restore}`,
    })
    edits.set(r.stream, list)
  })
  const changes = [...edits].map(([stream, list]) => {
    let text = stream.text
    for (const e of list.sort((a, b) => b.start - a.start))
      text = text.slice(0, e.start) + e.text + text.slice(e.end)
    return { stream, text }
  })
  writeStreams(doc, page, refs, changes)
  const bytes = await doc.save({ updateFieldAppearances: false }),
    checked = await analyze(bytes, pageIndex)
  const expected: { text: string; fontName: string; fontRaw: string; fill: string; x: number; baseline: number; advance?: number }[] = []
  runs.forEach((r, i) => {
    if (i === block.members[0]) expected.push(...emitted.expected)
    else if (!members.has(i))
      expected.push({ text: r.view.text, fontName: r.view.fontName, fontRaw: r.fontRaw, fill: r.fill, x: r.view.x, baseline: r.view.baseline, advance: r.advance })
  })
  if (checked.runs.length !== expected.length)
    fail('Die Ergebnisprüfung fand eine unerwartete Anzahl von Textstellen.')
  checked.runs.forEach((after, i) => {
    const e = expected[i]
    if (
      after.view.text !== e.text ||
      after.view.fontName !== e.fontName ||
      after.fontRaw !== e.fontRaw ||
      after.fill !== e.fill ||
      Math.abs(after.view.x - e.x) > 1e-4 ||
      Math.abs(after.view.baseline - e.baseline) > 1e-4 ||
      (e.advance !== undefined && Math.abs(after.advance - e.advance) > 1e-5)
    )
      fail('Die Ergebnisprüfung fand eine unerwartete Text- oder Positionsänderung.')
  })
  // Images, graphics and annotations are untouched by construction; prove it.
  if (
    checked.obstacles.length !== obstacles.length ||
    checked.obstacles.some((o, i) => (['left', 'right', 'bottom', 'top'] as const).some((k) => Math.abs(o[k] - obstacles[i][k]) > 1e-6))
  )
    fail('Die Ergebnisprüfung fand eine Veränderung an Bildern, Grafiken oder Anmerkungen.')
  return bytes
}
