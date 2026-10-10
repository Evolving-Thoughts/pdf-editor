// Erzeugt die Test-Fixtures in tests/fixtures/ (nicht im Repo eingecheckt).
// Aufruf: node scripts/make-fixtures.mjs
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdirSync, writeFileSync } from 'node:fs'

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
for (let i = 1; i <= 2; i++) {
  const page = doc.addPage([595, 842]) // A4
  page.drawText(`Fixture-Seite ${i}`, { x: 50, y: 780, size: 24, font })
}
mkdirSync('tests/fixtures', { recursive: true })
writeFileSync('tests/fixtures/zweiseitig.pdf', await doc.save())
console.log('tests/fixtures/zweiseitig.pdf erzeugt')
