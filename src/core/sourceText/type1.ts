/** Minimal, bounded Type 1 (FontFile) reader: built-in encoding, glyph names,
 * FontMatrix/FontBBox and charstring outlines. Used to prove that a glyph
 * exists in the embedded program and to draw it in the inline editor. It
 * never executes PostScript; unknown constructs simply yield no outline. */
import { STANDARD_ENCODING } from './fontTables'

export interface Type1Program {
  encoding?: Map<number, string>
  matrix: number[]
  bbox: number[]
  glyphs: Map<string, Uint8Array>
  subrs: Uint8Array[]
}
const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s }
function decrypt(data: Uint8Array, key: number, skip: number) {
  const out = new Uint8Array(Math.max(0, data.length - skip))
  let r = key
  for (let i = 0; i < data.length; i++) {
    const c = data[i], p = c ^ (r >> 8)
    r = ((c + r) * 52845 + 22719) & 0xffff
    if (i >= skip) out[i - skip] = p
  }
  return out
}
const numbers = (text?: string) => (text ?? '').trim().split(/\s+/).map(Number)
export function parseType1(bytes: Uint8Array, length1: number, length2: number): Type1Program | undefined {
  if (bytes[0] === 0x80) return undefined // PFB segment headers do not belong in FontFile.
  if (!(length1 > 0 && length2 > 0 && length1 + length2 <= bytes.length)) return undefined
  const clear = latin1(bytes.subarray(0, length1))
  if (!/^%!(PS-AdobeFont|FontType1)/.test(clear)) return undefined
  const matrix = numbers(/\/FontMatrix\s*\[([^\]]*)\]/.exec(clear)?.[1])
  const bbox = numbers(/\/FontBBox\s*[[{]([^\]}]*)[\]}]/.exec(clear)?.[1])
  let encoding: Map<number, string> | undefined
  if (!/\/Encoding\s+StandardEncoding\s+def/.test(clear)) {
    encoding = new Map()
    for (const m of clear.matchAll(/dup\s+(\d+)\s*\/([^\s/[\]{}()<>]+)\s+put/g)) encoding.set(Number(m[1]), m[2])
  }
  let enc = bytes.subarray(length1, length1 + length2)
  // eexec may be stored as hexadecimal text.
  if (Array.from(enc.subarray(0, 4)).every(c => /[0-9a-fA-F\s]/.test(String.fromCharCode(c)))) {
    const hex = latin1(enc).replace(/[^0-9a-fA-F]/g, '')
    enc = Uint8Array.from(hex.match(/../g) ?? [], h => parseInt(h, 16))
  }
  const priv = decrypt(enc, 55665, 4), text = latin1(priv)
  const lenIV = Number(/\/lenIV\s+(\d+)/.exec(text)?.[1] ?? 4)
  const subrs: Uint8Array[] = [], glyphs = new Map<string, Uint8Array>()
  const subrStart = text.search(/\/Subrs\s+\d+\s+array/)
  const charStart = text.search(/\/CharStrings\s+\d+\s+dict/)
  if (charStart < 0) return undefined
  if (subrStart >= 0) {
    const re = /dup\s+(\d+)\s+(\d+)\s+(RD|-\|)\s/g
    re.lastIndex = subrStart
    for (let m = re.exec(text); m && m.index < charStart; m = re.exec(text)) {
      const at = m.index + m[0].length, length = Number(m[2])
      if (Number(m[1]) > 65535 || at + length > priv.length) return undefined
      subrs[Number(m[1])] = lenIV < 0 ? priv.slice(at, at + length) : decrypt(priv.subarray(at, at + length), 4330, lenIV)
      re.lastIndex = at + length
    }
  }
  const re = /\/([^\s/[\]{}()<>]+)\s+(\d+)\s+(RD|-\|)\s/g
  re.lastIndex = charStart
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index + m[0].length, length = Number(m[2])
    if (at + length > priv.length || glyphs.size > 65535) return undefined
    glyphs.set(m[1], lenIV < 0 ? priv.slice(at, at + length) : decrypt(priv.subarray(at, at + length), 4330, lenIV))
    re.lastIndex = at + length
  }
  if (!glyphs.size || matrix.length !== 6 || !matrix.every(Number.isFinite) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return undefined
  return { encoding, matrix, bbox, glyphs, subrs }
}

/** Outline of one glyph in charstring units (y up) as SVG path data. */
export function type1Outline(program: Type1Program, name: string, depth = 0): { path: string; box?: number[] } | undefined {
  const code = program.glyphs.get(name)
  if (!code || depth > 2) return undefined
  const stack: number[] = [], ps: number[] = [], out: string[] = []
  let x = 0, y = 0, steps = 0, flex: number[][] | null = null, open = false, sbx = 0
  const box = [Infinity, Infinity, -Infinity, -Infinity]
  const touch = (px: number, py: number) => { box[0] = Math.min(box[0], px); box[1] = Math.min(box[1], py); box[2] = Math.max(box[2], px); box[3] = Math.max(box[3], py) }
  const f = (v: number) => String(Math.round(v * 100) / 100)
  const move = (dx: number, dy: number) => { x += dx; y += dy; if (flex) { flex.push([x, y]); return } if (open) out.push('Z'); out.push(`M${f(x)} ${f(y)}`); open = true; touch(x, y) }
  const line = (dx: number, dy: number) => { x += dx; y += dy; out.push(`L${f(x)} ${f(y)}`); touch(x, y) }
  const curve = (a: number, b: number, c: number, d: number, e: number, g: number) => {
    const x1 = x + a, y1 = y + b, x2 = x1 + c, y2 = y1 + d; x = x2 + e; y = y2 + g
    out.push(`C${f(x1)} ${f(y1)} ${f(x2)} ${f(y2)} ${f(x)} ${f(y)}`); touch(x1, y1); touch(x2, y2); touch(x, y)
  }
  let accent: { path: string; box?: number[] } | undefined, base: { path: string; box?: number[] } | undefined
  const run = (data: Uint8Array, level: number): boolean => {
    if (level > 10) return false
    for (let i = 0; i < data.length;) {
      if (++steps > 20000) return false
      const v = data[i++]
      if (v >= 32) {
        if (v <= 246) stack.push(v - 139)
        else if (v <= 250) stack.push((v - 247) * 256 + data[i++] + 108)
        else if (v <= 254) stack.push(-(v - 251) * 256 - data[i++] - 108)
        else { stack.push(((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3])); i += 4 }
        if (stack.length > 48) return false
        continue
      }
      const s = stack
      switch (v) {
        case 1: case 3: s.length = 0; break
        case 4: move(0, s.pop() ?? 0); s.length = 0; break
        case 5: line(s[0], s[1]); s.length = 0; break
        case 6: line(s[0], 0); s.length = 0; break
        case 7: line(0, s[0]); s.length = 0; break
        case 8: curve(s[0], s[1], s[2], s[3], s[4], s[5]); s.length = 0; break
        case 9: if (open) { out.push('Z'); open = false } s.length = 0; break
        case 10: { const n = s.pop()!; const sub = program.subrs[n]; if (!sub || !run(sub, level + 1)) return false; break }
        case 11: return true
        case 13: sbx = s[0]; x = s[0]; y = 0; s.length = 0; break
        case 14: if (open) { out.push('Z'); open = false } return true
        case 21: move(s[0], s[1]); s.length = 0; break
        case 22: move(s[0], 0); s.length = 0; break
        case 30: curve(0, s[0], s[1], s[2], s[3], 0); s.length = 0; break
        case 31: curve(s[0], 0, s[1], s[2], 0, s[3]); s.length = 0; break
        case 12: {
          const w = data[i++]
          if (w === 6) {
            // seac: base and accent from StandardEncoding.
            const [asb, adx, ady, bchar, achar] = s.splice(-5)
            base = type1Outline(program, STANDARD_ENCODING[bchar] ?? '', depth + 1)
            const a = type1Outline(program, STANDARD_ENCODING[achar] ?? '', depth + 1)
            if (a) accent = { path: a.path.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, px, py) => `${f(Number(px) + adx - asb + sbx)} ${f(Number(py) + ady)}`), box: a.box && [a.box[0] + adx - asb + sbx, a.box[1] + ady, a.box[2] + adx - asb + sbx, a.box[3] + ady] }
            return true
          }
          if (w === 7) { sbx = s[0]; x = s[0]; y = s[1]; s.length = 0; break }
          if (w === 12) { const b = s.pop()!, a = s.pop()!; s.push(b ? a / b : 0); break }
          if (w === 16) {
            const n = s.pop()!, argc = s.pop()!, args = s.splice(-argc, argc)
            if (n === 1) flex = []
            else if (n === 0 && flex) {
              const p = flex; flex = null
              if (p.length >= 7) {
                const [, a, b, c, d, e, g] = p
                const sx = p[0][0], sy = p[0][1]; void sx; void sy
                out.push(`C${f(a[0])} ${f(a[1])} ${f(b[0])} ${f(b[1])} ${f(c[0])} ${f(c[1])}`, `C${f(d[0])} ${f(d[1])} ${f(e[0])} ${f(e[1])} ${f(g[0])} ${f(g[1])}`)
                for (const q of [a, b, c, d, e, g]) touch(q[0], q[1])
                x = g[0]; y = g[1]
              }
              ps.push(...args.slice(1).reverse())
            } else if (n === 3) ps.push(3)
            else ps.push(...args.reverse())
            break
          }
          if (w === 17) { s.push(ps.pop() ?? 0); break }
          if (w === 33) { s.length = 0; break }
          s.length = 0
          break
        }
        default: s.length = 0
      }
    }
    return true
  }
  if (!run(code, 0)) return undefined
  const parts = [base?.path, out.join(''), accent?.path].filter(Boolean).join('')
  const boxes = [base?.box, Number.isFinite(box[0]) ? box : undefined, accent?.box].filter(Boolean) as number[][]
  const merged = boxes.length ? [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))] : undefined
  return { path: parts, box: merged }
}
