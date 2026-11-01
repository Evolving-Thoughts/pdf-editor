import { expect, test } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { buildTable, COLUMN_CROSSING, detectColumns, groupRows, mergeRows, reclassifyRows, TABLE_LIMITS, wordsFromFragments, wordsInRegion, type TableWord } from '../../src/core/tables/extract'
import { asNumberCell, classifyCell, parseNumber } from '../../src/core/tables/values'
import { buildOds, buildXlsx } from '../../src/core/tables/workbook'
import type { TableCell } from '../../src/core/tables/values'

const word = (text: string, left: number, top: number, width = text.length * 6, height = 10): TableWord => ({ text, left, right: left + width, top, bottom: top + height })
const number = (text: string): TableCell => ({ text, type: 'number' })
const plain = (text: string): TableCell => ({ text, type: 'text' })

test.each([
  ['1.234,50', 'de', 1234.5], ['12,5', 'de', 12.5], ['-3,25', 'de', -3.25], ['1.000.000', 'de', 1000000], ['42', 'de', 42],
  ['1,234.50', 'en', 1234.5], ['12.5', 'en', 12.5], ['1,000,000', 'en', 1000000], ['−7', 'en', -7],
] as const)('reads %s in %s', (text, locale, expected) => {
  expect(parseNumber(text, locale)).toBe(expected)
})

test.each([
  ['12.5', 'de'], ['1,234.50', 'de'], ['1.23,4', 'de'], ['12,5', 'en'], ['1.234,50', 'en'], ['1 234', 'de'], ['abc', 'de'], ['', 'de'], ['12a', 'en'],
] as const)('refuses %s in %s', (text, locale) => {
  expect(parseNumber(text, locale)).toBeNull()
})

test('clear numbers become numbers', () => {
  expect(classifyCell('1.234,50', 'de')).toEqual({ text: '1.234,50', type: 'number' })
  expect(classifyCell('12.5', 'en')).toEqual({ text: '12.5', type: 'number' })
})

test('1.234 and 1,234 stay text in both locales, because they read differently', () => {
  for (const locale of ['de', 'en'] as const) for (const text of ['1.234', '1,234']) {
    const cell = classifyCell(text, locale)
    expect(cell.type).toBe('text')
    expect(cell.note).toMatch(/Unklar/)
  }
})

test('leading zeros and long reference numbers never become numbers', () => {
  expect(classifyCell('0042', 'de')).toMatchObject({ type: 'text', note: expect.stringMatching(/Führende Null/) })
  expect(classifyCell('4012345678901234', 'de')).toMatchObject({ type: 'text', note: expect.stringMatching(/Kennnummer/) })
  expect(classifyCell('0,5', 'de').type).toBe('number')
})

test('a value in the wrong format is marked, not converted', () => {
  expect(classifyCell('12.5', 'de')).toMatchObject({ type: 'text', note: expect.stringMatching(/Zahlenformat/) })
})

test('formula-like text stays text and is marked', () => {
  for (const text of ['=SUM(A1:A9)', '+cmd|calc', '@foo', '-A1']) expect(classifyCell(text, 'de')).toMatchObject({ type: 'text', note: expect.stringMatching(/Formel/) })
})

test('dates, units and words stay plain text', () => {
  for (const text of ['Papier', '12.03.2026', '12 kg', '50 %']) expect(classifyCell(text, 'de').type).toBe('text')
})

test('a person can turn a clear value into a number, but not a word', () => {
  expect(asNumberCell(plain('1.234'), 'de')).toEqual({ text: '1.234', type: 'number' })
  expect(asNumberCell(plain('Papier'), 'de')).toMatchObject({ type: 'text', note: expect.stringMatching(/Zahlenformat/) })
})

test('fragments split into words with their own position', () => {
  const words = wordsFromFragments([{ text: 'Eins  Zwei', quad: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }, { x: 0, y: 10 }] }])
  expect(words.map(item => item.text)).toEqual(['Eins', 'Zwei'])
  expect(words[1].left).toBeCloseTo(60)
})

test('slanted text does not enter the grid', () => {
  expect(wordsFromFragments([{ text: 'Quer', quad: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 40, y: 60 }, { x: -10, y: 10 }] }])).toEqual([])
})

test('only words inside the region count', () => {
  const words = [word('rein', 20, 20), word('raus', 200, 20)]
  expect(wordsInRegion(words, { left: 0, right: 100, top: 0, bottom: 100 }).map(item => item.text)).toEqual(['rein'])
})

test('words on one line form a row despite small baseline differences', () => {
  const rows = groupRows([word('a', 0, 100), word('b', 50, 102), word('c', 0, 120)])
  expect(rows.map(row => row.map(item => item.text))).toEqual([['a', 'b'], ['c']])
})

test('column lines fall into the gaps', () => {
  const lines = detectColumns([word('Posten', 10, 10), word('Menge', 100, 10), word('Papier', 10, 30), word('12', 100, 30)])
  expect(lines).toHaveLength(1)
  expect(lines[0]).toBeGreaterThan(46)
  expect(lines[0]).toBeLessThan(100)
})

test('a wrong column assignment is marked: a word over the line gets a note', () => {
  const { rows } = buildTable([word('Langer', 10, 10, 90), word('x', 200, 10)], [50], 'de')
  expect(rows[0][1].note).toMatch(/Spaltengrenze/)
})

test('builds a table in reading order and keeps empty cells', () => {
  const { rows } = buildTable([word('Menge', 100, 10), word('Posten', 10, 10), word('12,5', 100, 30), word('Blatt', 40, 50), word('Papier', 10, 50, 25)], [80], 'de')
  expect(rows.map(row => row.map(cell => cell.text))).toEqual([['Posten', 'Menge'], ['', '12,5'], ['Papier Blatt', '']])
  expect(rows[1][1].type).toBe('number')
})

test('limits are named, not silently cut', () => {
  expect(() => buildTable([], [], 'de')).toThrow(/kein auswählbarer Text/)
  expect(() => buildTable(Array.from({ length: TABLE_LIMITS.words + 1 }, (_, index) => word('x', 0, index)), [], 'de')).toThrow(/Wörter/)
  expect(() => buildTable(Array.from({ length: TABLE_LIMITS.rows + 1 }, (_, index) => word('x', 0, index * 20)), [], 'de')).toThrow(/Zeilen/)
  expect(() => buildTable([word('x', 0, 0)], Array.from({ length: TABLE_LIMITS.columns }, (_, index) => index + 1), 'de')).toThrow(/Spalten/)
})

test('merging rows joins their cells, for values split over two lines', () => {
  const rows = [[plain('Lange'), plain('')], [plain('Bezeichnung'), plain('12,5')], [plain('x'), plain('y')]]
  const merged = mergeRows(rows, 0, 'de')
  expect(merged.map(row => row.map(cell => cell.text))).toEqual([['Lange Bezeichnung', '12,5'], ['x', 'y']])
  expect(merged[0][1].type).toBe('number')
})

const xlsxSheet = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml'])
const odsContent = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['content.xml'])

test('xlsx stores numbers as numbers and everything else as text', () => {
  const sheet = xlsxSheet(buildXlsx([[plain('Posten'), number('1.234,50')], [plain('0042'), plain('=1+1')]], 'de'))
  expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">Posten</t></is></c>')
  expect(sheet).toContain('<c r="B1"><v>1234.5</v></c>')
  expect(sheet).toContain('<t xml:space="preserve">0042</t>')
  expect(sheet).toContain('<t xml:space="preserve">=1+1</t>')
  expect(sheet).not.toContain('<f>')
})

test('xlsx names columns past Z', () => {
  const sheet = xlsxSheet(buildXlsx([Array.from({ length: 28 }, () => plain('x'))], 'de'))
  expect(sheet).toContain('r="Z1"')
  expect(sheet).toContain('r="AB1"')
})

test('ods stores numbers with their value, and its mimetype comes first and uncompressed', () => {
  const bytes = buildOds([[plain('Äpfel & Birnen'), number('12,5')]], 'de')
  expect(new TextDecoder().decode(bytes.slice(30, 38))).toBe('mimetype')
  expect(strFromU8(bytes.slice(38, 84))).toBe('application/vnd.oasis.opendocument.spreadsheet')
  const content = odsContent(bytes)
  expect(content).toContain('office:value-type="float" office:value="12.5"')
  expect(content).toContain('<text:p>Äpfel &amp; Birnen</text:p>')
})

test('markup and control characters from a PDF cannot break the file', () => {
  const sheet = xlsxSheet(buildXlsx([[plain('<a href="x">\u0007Text</a>')]], 'de'))
  expect(sheet).toContain('&lt;a href=&quot;x&quot;&gt;Text&lt;/a&gt;')
  expect(sheet).not.toContain('\u0007')
})

test('neither file carries macros, links or external references', () => {
  for (const bytes of [buildXlsx([[plain('https://example.org')]], 'de'), buildOds([[plain('https://example.org')]], 'de')]) {
    const names = Object.keys(unzipSync(bytes))
    expect(names.some(name => /vba|macro|externalLink|sharedStrings/i.test(name))).toBe(false)
    expect(names.join()).not.toContain('hyperlink')
  }
})

test('a number mark on a value that is no number falls back to text', () => {
  expect(xlsxSheet(buildXlsx([[number('Papier')]], 'de'))).toContain('inlineStr')
})

test('oversized output is refused', () => {
  const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(2000))).toString('base64')
  const wide = Array.from({ length: 400 }, () => Array.from({ length: 30 }, () => plain(random())))
  expect(() => buildXlsx(wide, 'de')).toThrow(/zu groß/)
})

test('a new number format reads the cells again and keeps a crossing word', () => {
  const rows: TableCell[][] = [[
    plain('Toner schwarz'),
    number('1.234,50'),
    { ...plain('89.90'), note: COLUMN_CROSSING },
  ]]
  const [row] = reclassifyRows(rows, 'en')
  expect(row[0]).toEqual(plain('Toner schwarz'))
  expect(row[1].type).toBe('text')
  expect(row[2]).toEqual({ ...number('89.90'), note: COLUMN_CROSSING })
})
