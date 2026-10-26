/** Strict content lexer for the initial simple-text adapter, not a general PDF parser. */
export interface ContentToken { kind: 'number' | 'name' | 'string' | 'operator'; raw: string; start: number; end: number; bytes?: Uint8Array }
const whitespace = new Set(['\0', '\t', '\n', '\f', '\r', ' '])
const white = (c: string) => whitespace.has(c)
const delimiter = (c: string) => white(c) || '()<>[]{}/%'.includes(c)
const bad = (): never => { throw new Error('Nicht unterstützte oder beschädigte PDF-Textstruktur.') }

export function contentTokens(content: string): ContentToken[] {
  if (content.length > 512 * 1024) bad()
  const tokens: ContentToken[] = []
  let i = 0
  while (i < content.length) {
    if (white(content[i])) { i++; continue }
    if (content[i] === '%') { while (i < content.length && !/[\r\n]/.test(content[i])) i++; continue }
    if (tokens.length >= 50000) bad()
    const start = i
    const first = content[i++]
    let kind: ContentToken['kind'], bytes: Uint8Array | undefined
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
        if (delimiter(first)) bad() // TJ arrays, dictionaries, inline images etc fail closed.
        while (i < content.length && !delimiter(content[i])) i++
        kind = /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(content.slice(start, i)) ? 'number' : 'operator'
      }
    }
    tokens.push({ kind, raw: content.slice(start, i), start, end: i, bytes })
  }
  return tokens
}
