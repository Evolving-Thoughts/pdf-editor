// Writes XLSX and ODS by hand: a table of plain values needs no spreadsheet library.
// Every text is stored as a string, so nothing from a PDF can become a formula,
// macro or link. Only cells marked as numbers are written as numbers.
import { strToU8, zipSync, type Zippable } from 'fflate'
import { TABLE_LIMITS } from './extract'
import { parseNumber, type NumberLocale, type TableCell } from './values'

const SHEET_NAME = 'Tabelle1'

// XML 1.0 forbids these characters even when escaped; PDF text can contain them.
// eslint-disable-next-line no-control-regex
const stripInvalid = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
const xml = (text: string) => stripInvalid(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function columnName(index: number): string {
  let name = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name
  return name
}

const numberOf = (cell: TableCell, locale: NumberLocale) => (cell.type === 'number' ? parseNumber(cell.text, locale) : null)

function finished(bytes: Uint8Array): Uint8Array {
  if (bytes.length > TABLE_LIMITS.outputBytes) throw new Error('Die Tabelle ist für den Export zu groß. Bitte einen kleineren Bereich wählen.')
  return bytes
}

export function buildXlsx(rows: TableCell[][], locale: NumberLocale): Uint8Array {
  const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => {
    const reference = `${columnName(columnIndex)}${rowIndex + 1}`, value = numberOf(cell, locale)
    if (value !== null) return `<c r="${reference}"><v>${value}</v></c>`
    return cell.text ? `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(cell.text)}</t></is></c>` : ''
  }).join('')}</row>`).join('')
  const files: Zippable = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`),
  }
  return finished(zipSync(files, { level: 6, mtime: new Date(2000, 0, 1) }))
}

export function buildOds(rows: TableCell[][], locale: NumberLocale): Uint8Array {
  const tableRows = rows.map(row => `<table:table-row>${row.map(cell => {
    const value = numberOf(cell, locale)
    if (value !== null) return `<table:table-cell office:value-type="float" office:value="${value}"><text:p>${xml(cell.text)}</text:p></table:table-cell>`
    return cell.text ? `<table:table-cell office:value-type="string"><text:p>${xml(cell.text)}</text:p></table:table-cell>` : '<table:table-cell/>'
  }).join('')}</table:table-row>`).join('')
  const mimetype = 'application/vnd.oasis.opendocument.spreadsheet'
  const files: Zippable = {
    // ODF requires this entry first and uncompressed.
    mimetype: [strToU8(mimetype), { level: 0 }],
    'META-INF/manifest.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${mimetype}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`),
    'content.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:spreadsheet><table:table table:name="${SHEET_NAME}">${tableRows}</table:table></office:spreadsheet></office:body></office:document-content>`),
  }
  return finished(zipSync(files, { level: 6, mtime: new Date(2000, 0, 1) }))
}
