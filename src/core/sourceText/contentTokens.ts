/** Content stream lexer for text analysis, not a general PDF parser. Fails closed on what it cannot read. */
export interface ContentToken { kind: 'number' | 'name' | 'string' | 'operator' | 'array' | 'dict'; raw: string; start: number; end: number; bytes?: Uint8Array; items?: ContentToken[] }
const whitespace = new Set(['\0', '\t', '\n', '\f', '\r', ' '])
const white = (c: string) => whitespace.has(c)
const delimiter = (c: string) => white(c) || '()<>[]{}/%'.includes(c)
const bad = (): never => { throw new Error('Nicht unterstützte oder beschädigte PDF-Textstruktur.') }

export function contentTokens(content: string, level = 0): ContentToken[] {
  if (level > 16 || content.length > 512 * 1024) bad()
  const tokens: ContentToken[] = []
  let i = 0
  while (i < content.length) {
    if (white(content[i])) { i++; continue }
    if (content[i] === '%') { while (i < content.length && !/[\r\n]/.test(content[i])) i++; continue }
    if (tokens.length >= 50000) bad()
    const start = i
    const first = content[i++]
    let kind: ContentToken['kind'], bytes: Uint8Array | undefined
    if (first === '[' || (first === '<' && content[i] === '<')) {
      const dict = first === '<', endMark = dict ? '>>' : ']'
      if (dict) i++
      const bodyStart = i
      // Find the closing delimiter through the same lexer, respecting strings.
      let cursor = i, nesting = 1
      while (cursor < content.length && nesting) {
        if (content[cursor] === '%') { while (cursor < content.length && !/[\r\n]/.test(content[cursor])) cursor++; continue }
        if (content[cursor] === '(') { let d = 1; cursor++; while (cursor < content.length && d) { const c = content[cursor++]; if (c === '\\') cursor++; else if (c === '(') d++; else if (c === ')') d-- } if (d) bad(); continue }
        if (content.startsWith(dict ? '<<' : '[', cursor)) { if (++nesting > 16) bad(); cursor += dict ? 2 : 1; continue }
        // Hex strings may end directly before a delimiter (`<FEFF00A0>>>`).
        if (content[cursor] === '<') { if (content[cursor + 1] === '<') { cursor += 2; continue } const e = content.indexOf('>', cursor); if (e < 0) bad(); cursor = e + 1; continue }
        if (content.startsWith(endMark, cursor)) { if (--nesting === 0) break; cursor += endMark.length; continue }
        cursor++
      }
      if (nesting) bad()
      const items = contentTokens(content.slice(bodyStart, cursor), level + 1)
      const shift = (values: ContentToken[]) => { for (const value of values) { value.start += bodyStart; value.end += bodyStart; if (value.items) shift(value.items) } }; shift(items)
      i = cursor + endMark.length; tokens.push({ kind: dict ? 'dict' : 'array', raw: content.slice(start,i), start, end:i, items }); continue
    }
    if (first === '(') {
      kind = 'string'
      const decoded: number[] = []
      let depth = 1
      while (i < content.length && depth) {
        const c = content[i++]
        if (c === '\\') {
          if (i === content.length) bad()
          const next = content[i++]
          if (next === '\r' || next === '\n') { if (next === '\r' && content[i] === '\n') i++; continue }
          const escape: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 }
          if (/[0-7]/.test(next)) {
            let octal = next
            while (octal.length < 3 && i < content.length && /[0-7]/.test(content[i])) octal += content[i++]
            decoded.push(parseInt(octal, 8) & 255)
          } else decoded.push(escape[next] ?? next.charCodeAt(0))
        } else if (c === '(') { if (++depth > 32) bad(); decoded.push(40) }
        else if (c === ')') { if (--depth) decoded.push(41) }
        else if (c === '\r') { if (content[i] === '\n') i++; decoded.push(10) }
        else decoded.push(c.charCodeAt(0))
      }
      if (depth || decoded.length > 4096) bad()
      bytes = Uint8Array.from(decoded)
    } else if (first === '<') {
      kind = 'string'
      const end = content.indexOf('>', i)
      if (end < 0) bad()
      let hex = Array.from(content.slice(i, end)).filter(c => !white(c)).join('')
      if (!/^[\da-f]*$/i.test(hex) || hex.length > 8192) bad()
      if (hex.length % 2) hex += '0'
      bytes = Uint8Array.from(hex.match(/../g) ?? [], value => parseInt(value, 16))
      i = end + 1
    } else {
      if (first === '/') {
        kind = 'name'
        while (i < content.length && !delimiter(content[i])) i++
        if (i === start + 1) bad()
      } else {
        if (delimiter(first)) bad() // A stray closing delimiter fails closed.
        while (i < content.length && !delimiter(content[i])) i++
        kind = /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(content.slice(start, i)) ? 'number' : 'operator'
        if (kind === 'operator' && content.slice(start, i) === 'BI') {
          // Inline image: dictionary, ID, raw data, EI. Delivered as one token.
          const id = /\sID[\s]/g
          id.lastIndex = i
          const at = id.exec(content)
          if (!at) bad()
          const ei = /\sEI(?=[\s]|$)/g
          ei.lastIndex = at!.index + at![0].length
          const close = ei.exec(content)
          if (!close || close.index - start > 4 * 1024 * 1024) bad()
          i = close!.index + close![0].length
          tokens.push({ kind: 'operator', raw: 'BI', start, end: i })
          continue
        }
      }
    }
    tokens.push({ kind, raw: content.slice(start, i), start, end: i, bytes })
  }
  return tokens
}
