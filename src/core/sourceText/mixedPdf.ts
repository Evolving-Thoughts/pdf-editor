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
} from 'pdf-lib'
import { contentTokens } from './contentTokens'
import type { ContentToken } from './contentTokens'
import { readSourceFont } from './sourceFonts'
import type { SourceFont } from './sourceFonts'
import { streamText } from './streams'
import {
  inspectSimpleSourceText,
  previewSimpleSourceCorrection,
} from './simplePdf'
import type { SimpleSourceRun, SourceSelection } from './simplePdf'
import { supportedSourceText } from './encoding'

type Matrix = [number, number, number, number, number, number]
interface Rect {
  left: number
  right: number
  bottom: number
  top: number
}
interface State {
  ctm: Matrix
  tm: Matrix
  lm: Matrix
  font?: SourceFont
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
}
const n = PDFName.of,
  identity = (): Matrix => [1, 0, 0, 1, 0, 0]
function fail(reason: string): never {
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
const union = (a: Rect, b: Rect): Rect => ({
  left: Math.min(a.left, b.left),
  right: Math.max(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
  top: Math.max(a.top, b.top),
})
const overlap = (a: Rect, b: Rect, gap = 0) =>
  a.left < b.right + gap &&
  a.right + gap > b.left &&
  a.bottom < b.top + gap &&
  a.top + gap > b.bottom
const contains = (a: Rect, b: Rect) =>
  a.left <= b.left + 0.001 &&
  a.right + 0.001 >= b.right &&
  a.bottom <= b.bottom + 0.001 &&
  a.top + 0.001 >= b.top
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
    size: 0,
    tc: 0,
    tw: 0,
    hz: 1,
    leading: 0,
    rise: 0,
    render: 0,
    lineWidth: 1,
    miter: 10,
  }
}
function glyphs(
  font: SourceFont,
  codes: number[],
  adjustments: number[],
  state: State,
) {
  let advance = 0,
    bounds: Rect | undefined,
    text = ''
  const matrix = mul(state.ctm, state.tm)
  for (let i = 0; i < codes.length; i++) {
    advance -= (((adjustments[i] ?? 0) * state.size) / 1000) * state.hz
    const code = codes[i],
      char = font.decode.get(code)
    if (char === undefined)
      fail(
        'Die Originalschrift enthält für einen Zeichencode keine nachgewiesene Unicode-Zuordnung.',
      )
    text += char
    const enc = font.codec.encode(char),
      width = font.advances?.get(code) ?? (enc.ok ? enc.value.advance : NaN)
    if (!Number.isFinite(width))
      fail('Die Breite eines Originalzeichens ist nicht nachgewiesen.')
    const b = font.boxes?.get(code) ?? font.bbox
    if (char.trim()) {
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
async function analyze(input: Uint8Array, pageIndex: number) {
  if (!input.length || input.length > 16 * 1024 * 1024)
    fail('Die PDF überschreitet die Größenbegrenzung von 16 MiB.')
  const bytes = input.slice(),
    revision = await hash(bytes),
    doc = await PDFDocument.load(bytes, { updateMetadata: false })
  if (doc.isEncrypted || doc.catalog.has(n('Perms')))
    fail(
      'Verschlüsselte oder signierte PDFs können nicht als Originaltext umgeschrieben werden.',
    )
  if (doc.catalog.has(n('AcroForm')))
    fail(
      'PDFs mit Formular- oder Signaturfeldern benötigen eine noch nicht unterstützte Erhaltungsprüfung.',
    )
  const tree = doc.catalog.lookup(n('StructTreeRoot')),
    seen = new Set<unknown>()
  let structureNodes = 0
  const checkStructure = (value: unknown, depth = 0): void => {
    if (!value || seen.has(value)) return
    if (++structureNodes > 10000 || depth > 64)
      fail('Die Struktur-Tags überschreiten die sicheren Analysegrenzen.')
    seen.add(value)
    if (value instanceof PDFRef) {
      checkStructure(doc.context.lookup(value), depth + 1)
      return
    }
    if (value instanceof PDFArray) {
      for (const child of value.asArray()) checkStructure(child, depth + 1)
    } else if (value instanceof PDFDict) {
      if (value.has(n('ActualText')) || value.has(n('E')))
        fail(
          'Der PDF-Strukturbaum enthält eigenen Ersatztext (ActualText/E), der gemeinsam aktualisiert werden müsste.',
        )
      checkStructure(value.get(n('K')), depth + 1)
    }
  }
  checkStructure(tree)
  const pages = doc.getPages(),
    page = pages[pageIndex]
  if (!page || pages.length > 200)
    fail(
      'Die gewählte Seite ist nicht vorhanden oder das Dokument überschreitet 200 Seiten.',
    )
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
  const annots = page.node.Annots()
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const a = annots!.lookup(i)
    if (
      !(a instanceof PDFDict) ||
      a.lookup(n('Subtype'))?.toString() !== '/Link'
    )
      fail('Die gewählte Seite enthält eine noch nicht unterstützte Anmerkung.')
    const r = a.lookup(n('Rect'))
    if (!(r instanceof PDFArray) || r.size() !== 4)
      fail('Ein Link hat keine sicheren Bereichsgrenzen.')
    const v = r
      .asArray()
      .map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN))
    if (!v.every(Number.isFinite)) fail('Ein Linkbereich ist ungültig.')
    obstacles.push({
      left: Math.min(v[0], v[2]),
      right: Math.max(v[0], v[2]),
      bottom: Math.min(v[1], v[3]),
      top: Math.max(v[1], v[3]),
    })
  }
  const contents = page.node.get(n('Contents')),
    resolved = doc.context.lookup(contents),
    refs =
      resolved instanceof PDFArray
        ? resolved.asArray()
        : contents
          ? [contents]
          : []
  if (refs.length > 128) fail('Die Seite enthält zu viele Inhaltsstreams.')
  let glyphBudget = 0
  let state = initial(),
    inText = false,
    markDepth = 0,
    total = 0,
    path: Rect | undefined,
    pendingClip = false,
    rectangularPath = false
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
      const finishPath = (paint: boolean) => {
        if (path && paint) {
          const pad =
            state.lineWidth *
            state.miter *
            (Math.hypot(state.ctm[0], state.ctm[1]) +
              Math.hypot(state.ctm[2], state.ctm[3]))
          obstacles.push({
            left: path.left - pad,
            right: path.right + pad,
            bottom: path.bottom - pad,
            top: path.top + pad,
          })
        }
        if (pendingClip) {
          if (!path || !rectangularPath)
            fail(
              'Eine nicht rechteckige Clipfläche benötigt eine zusätzliche Geometrieprüfung.',
            )
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
          state.tm = identity()
          state.lm = identity()
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
          state.size = numeric(ops[1])
          if (state.size <= 0 || state.size > 512)
            fail('Die Schriftgröße wird nicht unterstützt.')
          try {
            state.font =
              fonts.get(key) ?? (await readSourceFont(page, key, true))
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
              `Seite ${pageIndex + 1}, Schrift ${key}: ${error instanceof Error ? error.message : 'Schrift nicht unterstützt.'}`,
            )
          }
          break
        }
        case 'Tm':
          if (!inText) fail('Textposition außerhalb eines Textobjekts.')
          state.tm = nums(6) as Matrix
          state.lm = [...state.tm]
          break
        case 'Td':
        case 'TD': {
          if (!inText) fail('Textverschiebung außerhalb eines Textobjekts.')
          const [x, y] = nums(2)
          if (op === 'TD') state.leading = -y
          state.lm = mul(state.lm, [1, 0, 0, 1, x, y])
          state.tm = [...state.lm]
          break
        }
        case 'T*':
          nums(0)
          if (!inText) fail('Zeilenwechsel außerhalb eines Textobjekts.')
          state.lm = mul(state.lm, [1, 0, 0, 1, 0, -state.leading])
          state.tm = [...state.lm]
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
          if (state.render !== 0)
            fail(
              'Unsichtbarer, konturierter oder als Clip verwendeter Text wird nicht unterstützt.',
            )
          break
        case 'Tj':
        case 'TJ': {
          if (!inText || !state.font || ops.length !== 1)
            fail('Ein Textoperator hat keinen eindeutigen Schriftzustand.')
          const target = ops[0],
            items =
              op === 'TJ' && target.kind === 'array'
                ? target.items
                : op === 'Tj' && target.kind === 'string'
                  ? [target]
                  : undefined
          if (!items) fail('Das TJ-Array enthält nicht unterstützte Elemente.')
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
              item.bytes.length % state.font.codeBytes
            )
              fail('Ein TJ-Array enthält ungültige Zeichencodes.')
            for (let k = 0; k < item.bytes.length; k += state.font.codeBytes)
              codes.push(
                state.font.codeBytes === 1
                  ? item.bytes[k]
                  : item.bytes[k] * 256 + item.bytes[k + 1],
              )
          }
          if (codes.length > 4096)
            fail('Eine Textstelle überschreitet 4096 Zeichen.')
          const measured = glyphs(state.font, codes, adjustments, state),
            matrix = mul(state.ctm, state.tm)
          if (runs.length >= 10000)
            fail('Die Seite enthält zu viele einzelne Textstellen.')
          const view: SimpleSourceRun = {
            id: `mixed:${pageIndex}:${runs.length}`,
            pageIndex,
            text: measured.text,
            fontName: state.font.name,
            fontSize: state.size,
            x: matrix[4],
            baseline: matrix[5] + state.rise,
            width: measured.width,
          }
          runs.push({
            view,
            bounds: measured.bounds,
            clip: state.clip,
            font: state.font,
            state: copy(state),
            stream,
            token: target,
            end: token.end,
            advance: measured.advance,
            adjustments,
            codes,
          })
          state.tm = mul(state.tm, [1, 0, 0, 1, measured.advance, 0])
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
          break
        }
        case 'gs': {
          if (ops.length !== 1) fail('Ein Grafikzustand ist ungültig.')
          const g = resources
            ?.lookupMaybe(n('ExtGState'), PDFDict)
            ?.lookup(n(name(ops[0])))
          if (!(g instanceof PDFDict))
            fail('Ein Grafikzustand kann nicht aufgelöst werden.')
          for (const [key, val] of g.entries()) {
            if (key.toString() === '/Type') continue
            if (key.toString() === '/BM' && val.toString() === '/Normal')
              continue
            if (
              ['/ca', '/CA'].includes(key.toString()) &&
              val instanceof PDFNumber &&
              val.asNumber() === 1
            )
              continue
            fail(
              `Grafikzustand ${key.decodeText()} benötigt eine zusätzliche Erhaltungsprüfung.`,
            )
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
          finishPath(true)
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
        case 'RG':
          nums(3)
          break
        case 'g':
        case 'G':
          nums(1)
          break
        case 'k':
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
          if (++markDepth > 32) fail('Zu tief verschachtelte Struktur-Tags.')
          break
        case 'BDC': {
          if (ops.length !== 2) fail('Ungültiges Struktur-Tag.')
          name(ops[0])
          const props = ops[1]
          if (props.kind !== 'dict')
            fail(
              'Referenzierte Struktur-Eigenschaften werden noch nicht unterstützt.',
            )
          if (
            props.items?.some(
              (t) =>
                t.kind === 'name' &&
                ['/ActualText', '/Alt', '/E'].includes(t.raw),
            )
          )
            fail(
              'Ein Struktur-Tag besitzt eigenen Ersatztext (ActualText/Alt). Dieser muss gemeinsam aktualisiert werden.',
            )
          if (++markDepth > 32) fail('Zu tief verschachtelte Struktur-Tags.')
          break
        }
        case 'EMC':
          nums(0)
          if (--markDepth < 0) fail('Unausgeglichene Struktur-Tags.')
          break
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
  return { doc, page, runs, obstacles, revision, refs }
}
function editable(run: Run) {
  const m = mul(run.state.ctm, run.state.tm)
  return (
    Math.abs(m[0] - 1) < 1e-8 &&
    Math.abs(m[1]) < 1e-8 &&
    Math.abs(m[2]) < 1e-8 &&
    Math.abs(m[3] - 1) < 1e-8 &&
    run.state.hz === 1 &&
    run.state.rise === 0 &&
    supportedSourceText(run.view.text) &&
    run.codes.every(
      (code) => Array.from(run.font.decode.get(code) ?? '').length === 1,
    ) &&
    run.view.text.trim() === run.view.text &&
    !!run.view.text.trim() &&
    run.font.codec.encode(run.view.text).ok
  )
}
export async function inspectPageSource(bytes: Uint8Array, pageIndex: number) {
  // Keep the stronger, already verified paragraph adapter for its known subset.
  try {
    const result = await inspectSimpleSourceText(bytes)
    return {
      ...result,
      runs: result.runs.filter((r) => r.pageIndex === pageIndex),
    }
  } catch {
    /* The selected page may still be editable; do not reject for another page. */
  }
  const result = await analyze(bytes, pageIndex),
    runs = result.runs.filter(editable).map((r) => {
      let offset = 0
      const characters = r.codes.map((code, i) => {
        // Preserve original TJ positioning and Tc/Tw, not replacement metrics.
        offset -= (r.adjustments[i] ?? 0) * r.state.size / 1000
        const char = r.font.decode.get(code)!, encoded = r.font.codec.encode(char)
        const advance = r.font.advances?.get(code) ?? (encoded.ok ? encoded.value.advance : 0)
        const width = advance * r.state.size / 1000 + r.state.tc + (r.font.codeBytes === 1 && code === 32 ? r.state.tw : 0)
        const value = { offset, width }
        offset += width
        return value
      })
      const safe = characters.every((c, i) => Number.isFinite(c.offset) && Number.isFinite(c.width) && c.width > 0 && (i === 0 || c.offset >= characters[i - 1].offset))
      return { ...r.view, selection: safe ? { characters } : undefined }
    })
  if (!runs.length)
    fail(
      `Seite ${pageIndex + 1}: Keine sicher kodierbare, horizontal bearbeitbare Textstelle gefunden. Scans benötigen OCR; Ligaturen oder andere Schriftzustände können einzelne Stellen ausschließen.`,
    )
  return { digest: result.revision, runs }
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
  if (selection.scope === 'paragraph')
    fail(
      'Diese Textstelle ist in mehrere unabhängig positionierte PDF-Fragmente aufgeteilt. Ein sicherer Absatzumbruch ist hier noch nicht nachgewiesen.',
    )
  if (!editable(run))
    fail(
      'Der Schrift- oder Transformationszustand dieser Textstelle ist nicht sicher bearbeitbar.',
    )
  if (
    !supportedSourceText(replacement) ||
    replacement.trim() !== replacement ||
    !replacement
  )
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
    operand +
    run.stream.text.slice(run.end)
  // Reuse an unshared ref so the old text stream is not left orphaned in
  // the saved PDF. Clone only when another page/content slot actually uses it.
  let uses = 0
  for (const p of doc.getPages()) {
    const c = p.node.get(n('Contents')),
      v = doc.context.lookup(c),
      values = v instanceof PDFArray ? v.asArray() : c ? [c] : []
    uses += values.filter(
      (r) => r.toString() === run.stream.ref.toString(),
    ).length
  }
  if (uses === 1)
    doc.context.assign(run.stream.ref, doc.context.flateStream(changed))
  else {
    const newRef = doc.context.register(doc.context.flateStream(changed)),
      newRefs = [...refs]
    newRefs[run.stream.index] = newRef
    page.node.set(n('Contents'), doc.context.obj(newRefs))
  }
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
